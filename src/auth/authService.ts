import crypto from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { getRuntimeConfig } from '../config/runtimeConfig.ts'
import {
  hashPassword,
  needsPasswordRehash,
  sha256Hex,
  validatePasswordStrength,
  verifyPassword,
} from '../security/password.ts'
import { RbacService } from './rbac.ts'

export interface PublicUser {
  id: string
  email: string
  displayName: string
  isActive: boolean
  mustChangePassword: boolean
  roles: string[]
  permissions: string[]
  lastLoginAt: string | null
  createdAt: string
}

export interface AuthContext {
  user: PublicUser
  sessionId: string
  authMethod: 'bearer' | 'cookie'
}

export interface SessionSummary {
  id: string
  userId: string
  authMethod: string
  ipAddress: string
  userAgent: string
  createdAt: string
  lastSeenAt: string
  idleExpiresAt: string
  absoluteExpiresAt: string
  isCurrent: boolean
}

const MAX_LOGIN_FAILURES = 5
const LOGIN_LOCKOUT_MS = 5 * 60 * 1000

export class AuthService {
  private db: DatabaseSync
  private rbac: RbacService
  private onSessionRevokedHandlers: Array<(sessionIds: string[]) => void> = []

  constructor(db: DatabaseSync, rbac: RbacService) {
    this.db = db
    this.rbac = rbac
  }

  onSessionsRevoked(handler: (sessionIds: string[]) => void): void {
    this.onSessionRevokedHandlers.push(handler)
  }

  private notifyRevoked(sessionIds: string[]): void {
    if (sessionIds.length === 0) return
    for (const h of this.onSessionRevokedHandlers) {
      try {
        h(sessionIds)
      } catch {
        // listener errors must not break revocation
      }
    }
  }

  /**
   * If KATHAL_ADMIN_PASSWORD is set in env, ensure the primary admin account exists
   * and matches the env password so operator env overrides continue to work as expected.
   */
  async ensureConfiguredEnvOwner(): Promise<void> {
    const cfg = getRuntimeConfig()
    if (!cfg.configuredAdminPassword) return
    const existing = this.db
      .prepare('SELECT id FROM users WHERE email = ?')
      .get(cfg.adminEmail) as { id: string } | undefined
    const pwHash = await hashPassword(cfg.configuredAdminPassword)
    const now = new Date().toISOString()

    if (!existing) {
      const userId = 'usr-owner-env'
      this.db
        .prepare(
          `INSERT INTO users (id, email, display_name, password_hash, is_active, failed_attempts, created_at, updated_at)
           VALUES (?, ?, 'Platform Owner', ?, 1, 0, ?, ?)`
        )
        .run(userId, cfg.adminEmail, pwHash, now, now)
      this.db
        .prepare(
          `INSERT OR IGNORE INTO user_roles (user_id, role_id, assigned_by, assigned_at)
           VALUES (?, 'role-owner', ?, ?)`
        )
        .run(userId, userId, now)
    } else {
      this.db
        .prepare('UPDATE users SET password_hash = ?, is_active = 1, updated_at = ? WHERE id = ?')
        .run(pwHash, now, existing.id)
      this.db
        .prepare(
          `INSERT OR IGNORE INTO user_roles (user_id, role_id, assigned_by, assigned_at)
           VALUES (?, 'role-owner', ?, ?)`
        )
        .run(existing.id, existing.id, now)
    }
  }

  needsSetup(): boolean {
    const cfg = getRuntimeConfig()
    if (cfg.configuredAdminPassword) return false
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number }
    return row.cnt === 0
  }

  getAuthStatus(): { needsSetup: boolean; adminEmail: string; allowSelfRegistration: boolean } {
    const cfg = getRuntimeConfig()
    const firstUser = this.db
      .prepare('SELECT email FROM users ORDER BY created_at ASC LIMIT 1')
      .get() as { email: string } | undefined
    return {
      needsSetup: this.needsSetup(),
      adminEmail: cfg.configuredAdminPassword ? cfg.adminEmail : firstUser?.email || cfg.adminEmail,
      allowSelfRegistration: cfg.allowSelfRegistration,
    }
  }

  toPublicUser(userRow: {
    id: string
    email: string
    display_name: string
    is_active: number
    must_change_password: number
    last_login_at: string | null
    created_at: string
  }): PublicUser {
    const roles = this.rbac.getUserRoles(userRow.id).map((r) => r.name)
    const permissions = this.rbac.getUserPermissions(userRow.id)
    return {
      id: userRow.id,
      email: userRow.email,
      displayName: userRow.display_name || userRow.email.split('@')[0],
      isActive: Boolean(userRow.is_active),
      mustChangePassword: Boolean(userRow.must_change_password),
      roles,
      permissions,
      lastLoginAt: userRow.last_login_at,
      createdAt: userRow.created_at,
    }
  }

  getUserById(userId: string): PublicUser | null {
    const row = this.db
      .prepare(
        `SELECT id, email, display_name, is_active, must_change_password, last_login_at, created_at
         FROM users WHERE id = ?`
      )
      .get(userId) as
      | {
          id: string
          email: string
          display_name: string
          is_active: number
          must_change_password: number
          last_login_at: string | null
          created_at: string
        }
      | undefined
    return row ? this.toPublicUser(row) : null
  }

  async claimInitialOwner(
    emailInput: string,
    password: string,
    meta: { ip: string; userAgent: string; displayName?: string }
  ): Promise<{ token: string; user: PublicUser; sessionId: string }> {
    if (!this.needsSetup()) {
      throw Object.assign(new Error('Admin account is already configured. Please sign in.'), { status: 409 })
    }
    const email = emailInput.trim().toLowerCase()
    if (!email || !email.includes('@')) {
      throw Object.assign(new Error('Please enter a valid email address.'), { status: 400 })
    }
    const pwCheck = validatePasswordStrength(password, { strict: false })
    if (!pwCheck.ok) {
      throw Object.assign(new Error(pwCheck.error || 'Invalid password'), { status: 400 })
    }

    const passwordHash = await hashPassword(password)
    if (!this.needsSetup()) {
      throw Object.assign(new Error('Admin account is already configured. Please sign in.'), { status: 409 })
    }

    const userId = `usr-${crypto.randomBytes(6).toString('hex')}`
    const now = new Date().toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const countCheck = (this.db.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number }).cnt
      if (countCheck > 0) {
        throw Object.assign(new Error('Admin account is already configured. Please sign in.'), { status: 409 })
      }
      this.db
        .prepare(
          `INSERT INTO users (id, email, display_name, password_hash, is_active, failed_attempts, last_login_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, 0, ?, ?, ?)`
        )
        .run(userId, email, meta.displayName?.trim() || 'Platform Owner', passwordHash, now, now, now)
      this.db
        .prepare(
          `INSERT INTO user_roles (user_id, role_id, assigned_by, assigned_at) VALUES (?, 'role-owner', ?, ?)`
        )
        .run(userId, userId, now)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }

    const user = this.getUserById(userId)!
    const { token, sessionId } = this.issueSession(userId, meta)
    return { token, user, sessionId }
  }

  async authenticate(
    emailInput: string,
    password: string,
    meta: { ip: string; userAgent: string }
  ): Promise<{ token: string; user: PublicUser; sessionId: string }> {
    const email = emailInput.trim().toLowerCase()
    if (!email || !password) {
      throw Object.assign(new Error('email and password are required'), { status: 400 })
    }
    if (this.needsSetup()) {
      throw Object.assign(
        new Error('Admin account has not been set up yet. Complete first-time setup first.'),
        { status: 403, needsSetup: true }
      )
    }

    const userRow = this.db
      .prepare(
        `SELECT id, email, display_name, password_hash, is_active, failed_attempts, locked_until,
                must_change_password, last_login_at, created_at
         FROM users WHERE email = ?`
      )
      .get(email) as
      | {
          id: string
          email: string
          display_name: string
          password_hash: string
          is_active: number
          failed_attempts: number
          locked_until: string | null
          must_change_password: number
          last_login_at: string | null
          created_at: string
        }
      | undefined

    if (userRow && userRow.locked_until) {
      if (new Date(userRow.locked_until).getTime() > Date.now()) {
        throw Object.assign(new Error('too many failed attempts, try again later'), {
          status: 429,
          reason: 'rate_limited',
          userId: userRow.id,
        })
      }
      // Lockout expired: reset
      this.db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(userRow.id)
      userRow.failed_attempts = 0
      userRow.locked_until = null
    }

    if (!userRow) {
      // Constant-time work to reduce user-enumeration timing skew
      await verifyPassword(password, '$2a$10$invalidsaltforconstanttimenotrealuserhash00000000000')
      throw Object.assign(new Error('invalid credentials'), { status: 401, reason: 'invalid_credentials' })
    }

    if (!userRow.is_active) {
      throw Object.assign(new Error('Account is deactivated. Contact an administrator.'), {
        status: 403,
        reason: 'account_deactivated',
        userId: userRow.id,
      })
    }

    const valid = await verifyPassword(password, userRow.password_hash)
    if (!valid) {
      const nextFailures = (userRow.failed_attempts || 0) + 1
      const lockedUntil =
        nextFailures >= MAX_LOGIN_FAILURES ? new Date(Date.now() + LOGIN_LOCKOUT_MS).toISOString() : null
      this.db
        .prepare('UPDATE users SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?')
        .run(nextFailures, lockedUntil, new Date().toISOString(), userRow.id)

      if (lockedUntil) {
        throw Object.assign(new Error('too many failed attempts, try again later'), {
          status: 429,
          reason: 'rate_limited',
          userId: userRow.id,
        })
      }
      throw Object.assign(new Error('invalid credentials'), {
        status: 401,
        reason: 'invalid_credentials',
        userId: userRow.id,
      })
    }

    const now = new Date().toISOString()
    let updatedHash = userRow.password_hash
    if (needsPasswordRehash(userRow.password_hash)) {
      updatedHash = await hashPassword(password)
    }
    this.db
      .prepare(
        `UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?`
      )
      .run(updatedHash, now, now, userRow.id)

    const user = this.getUserById(userRow.id)!
    const { token, sessionId } = this.issueSession(userRow.id, meta)
    return { token, user, sessionId }
  }

  issueSession(
    userId: string,
    meta: { ip: string; userAgent: string; authMethod?: string }
  ): { token: string; sessionId: string; idleExpiresAt: string; absoluteExpiresAt: string } {
    const cfg = getRuntimeConfig()
    const rawToken = `ks_${crypto.randomBytes(32).toString('hex')}`
    const tokenHash = sha256Hex(rawToken)
    const sessionId = `ses-${crypto.randomBytes(8).toString('hex')}`
    const nowMs = Date.now()
    const nowIso = new Date(nowMs).toISOString()
    const idleExpiresAt = new Date(nowMs + cfg.sessionIdleMs).toISOString()
    const absoluteExpiresAt = new Date(nowMs + cfg.sessionAbsoluteMs).toISOString()

    this.db
      .prepare(
        `INSERT INTO sessions (
          id, user_id, token_hash, auth_method, ip_address, user_agent,
          created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(
        sessionId,
        userId,
        tokenHash,
        meta.authMethod || 'cookie_or_bearer',
        meta.ip || '127.0.0.1',
        (meta.userAgent || '').slice(0, 200),
        nowIso,
        nowIso,
        idleExpiresAt,
        absoluteExpiresAt
      )

    return { token: rawToken, sessionId, idleExpiresAt, absoluteExpiresAt }
  }

  verifySessionToken(rawToken: string, authMethod: 'bearer' | 'cookie'): AuthContext | null {
    if (!rawToken) return null
    const tokenHash = sha256Hex(rawToken)
    const row = this.db
      .prepare(
        `SELECT s.id as session_id, s.user_id, s.idle_expires_at, s.absolute_expires_at, s.revoked_at,
                u.id, u.email, u.display_name, u.is_active, u.must_change_password, u.last_login_at, u.created_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?`
      )
      .get(tokenHash) as
      | {
          session_id: string
          user_id: string
          idle_expires_at: string
          absolute_expires_at: string
          revoked_at: string | null
          id: string
          email: string
          display_name: string
          is_active: number
          must_change_password: number
          last_login_at: string | null
          created_at: string
        }
      | undefined

    if (!row || row.revoked_at || !row.is_active) return null

    const nowMs = Date.now()
    if (
      new Date(row.idle_expires_at).getTime() <= nowMs ||
      new Date(row.absolute_expires_at).getTime() <= nowMs
    ) {
      this.revokeSession(row.session_id)
      return null
    }

    // Sliding idle expiration refresh (bounded by absolute_expires_at)
    const cfg = getRuntimeConfig()
    const nextIdleMs = Math.min(nowMs + cfg.sessionIdleMs, new Date(row.absolute_expires_at).getTime())
    this.db
      .prepare('UPDATE sessions SET last_seen_at = ?, idle_expires_at = ? WHERE id = ?')
      .run(new Date(nowMs).toISOString(), new Date(nextIdleMs).toISOString(), row.session_id)

    return {
      user: this.toPublicUser(row),
      sessionId: row.session_id,
      authMethod,
    }
  }

  revokeSession(sessionId: string): boolean {
    const now = new Date().toISOString()
    const res = this.db
      .prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(now, sessionId)
    if (Number(res.changes || 0) > 0) {
      this.notifyRevoked([sessionId])
      return true
    }
    return false
  }

  revokeAllUserSessions(userId: string, exceptSessionId?: string): number {
    const rows = exceptSessionId
      ? (this.db
          .prepare('SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND id != ?')
          .all(userId, exceptSessionId) as Array<{ id: string }>)
      : (this.db
          .prepare('SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL')
          .all(userId) as Array<{ id: string }>)

    const ids = rows.map((r) => r.id)
    if (ids.length === 0) return 0

    const now = new Date().toISOString()
    if (exceptSessionId) {
      this.db
        .prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id != ?')
        .run(now, userId, exceptSessionId)
    } else {
      this.db
        .prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
        .run(now, userId)
    }

    this.notifyRevoked(ids)
    return ids.length
  }

  listUserSessions(userId: string, currentSessionId?: string): SessionSummary[] {
    const now = new Date().toISOString()
    const rows = this.db
      .prepare(
        `SELECT id, user_id, auth_method, ip_address, user_agent, created_at, last_seen_at, idle_expires_at, absolute_expires_at
         FROM sessions
         WHERE user_id = ? AND revoked_at IS NULL AND idle_expires_at > ? AND absolute_expires_at > ?
         ORDER BY last_seen_at DESC`
      )
      .all(userId, now, now) as Array<{
      id: string
      user_id: string
      auth_method: string
      ip_address: string
      user_agent: string
      created_at: string
      last_seen_at: string
      idle_expires_at: string
      absolute_expires_at: string
    }>

    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      authMethod: r.auth_method,
      ipAddress: r.ip_address,
      userAgent: r.user_agent,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      idleExpiresAt: r.idle_expires_at,
      absoluteExpiresAt: r.absolute_expires_at,
      isCurrent: Boolean(currentSessionId && r.id === currentSessionId),
    }))
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    currentSessionId?: string
  ): Promise<{ revokedSessions: number }> {
    const row = this.db
      .prepare('SELECT id, password_hash FROM users WHERE id = ?')
      .get(userId) as { id: string; password_hash: string } | undefined
    if (!row) throw Object.assign(new Error('User not found'), { status: 404 })

    const ok = await verifyPassword(currentPassword, row.password_hash)
    if (!ok) {
      throw Object.assign(new Error('Current password is incorrect.'), { status: 401 })
    }

    const strength = validatePasswordStrength(newPassword, { strict: true })
    if (!strength.ok) {
      throw Object.assign(new Error(strength.error || 'Weak password'), { status: 400 })
    }

    const nextHash = await hashPassword(newPassword)
    const now = new Date().toISOString()
    this.db
      .prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?')
      .run(nextHash, now, userId)

    // Revoke all other sessions on password change
    const revokedSessions = this.revokeAllUserSessions(userId, currentSessionId)
    return { revokedSessions }
  }

  async createUser(
    input: {
      email: string
      password: string
      displayName?: string
      roles?: string[]
      isActive?: boolean
      mustChangePassword?: boolean
    },
    actorUserId: string
  ): Promise<PublicUser> {
    const email = input.email.trim().toLowerCase()
    if (!email || !email.includes('@')) {
      throw Object.assign(new Error('Valid email address is required.'), { status: 400 })
    }
    const dup = this.db.prepare('SELECT id FROM users WHERE email = ?').get(email)
    if (dup) {
      throw Object.assign(new Error('A user with this email already exists.'), { status: 409 })
    }
    const strength = validatePasswordStrength(input.password, { strict: true })
    if (!strength.ok) {
      throw Object.assign(new Error(strength.error || 'Weak password'), { status: 400 })
    }

    const roleInputs = input.roles && input.roles.length > 0 ? input.roles : ['Viewer']
    const roleIds = this.rbac.resolveRoleIds(roleInputs)
    if (roleIds.length === 0) {
      throw Object.assign(new Error('At least one valid role is required.'), { status: 400 })
    }

    // Only an existing Owner can create another Owner
    const isSelfReg = actorUserId === 'self-registration' || !actorUserId
    const actorIsOwner = !isSelfReg && this.rbac.getUserRoles(actorUserId).some((r) => r.id === 'role-owner')
    if (roleIds.includes('role-owner') && !actorIsOwner) {
      throw Object.assign(new Error('Only an Owner can assign the Owner role.'), { status: 403 })
    }

    const passwordHash = await hashPassword(input.password)
    const userId = `usr-${crypto.randomBytes(6).toString('hex')}`
    const now = new Date().toISOString()
    const assignedByUserId = isSelfReg ? userId : actorUserId

    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare(
          `INSERT INTO users (id, email, display_name, password_hash, is_active, must_change_password, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          userId,
          email,
          input.displayName?.trim() || email.split('@')[0],
          passwordHash,
          input.isActive === false ? 0 : 1,
          input.mustChangePassword ? 1 : 0,
          now,
          now
        )
      const insRole = this.db.prepare(
        'INSERT INTO user_roles (user_id, role_id, assigned_by, assigned_at) VALUES (?, ?, ?, ?)'
      )
      for (const rid of roleIds) {
        insRole.run(userId, rid, assignedByUserId, now)
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }

    return this.getUserById(userId)!
  }

  listUsers(): PublicUser[] {
    const rows = this.db
      .prepare(
        `SELECT id, email, display_name, is_active, must_change_password, last_login_at, created_at
         FROM users ORDER BY created_at ASC`
      )
      .all() as Array<{
      id: string
      email: string
      display_name: string
      is_active: number
      must_change_password: number
      last_login_at: string | null
      created_at: string
    }>
    return rows.map((r) => this.toPublicUser(r))
  }

  updateUserStatus(targetUserId: string, isActive: boolean, actorUserId: string): PublicUser {
    const target = this.getUserById(targetUserId)
    if (!target) throw Object.assign(new Error('User not found'), { status: 404 })

    if (!isActive) {
      if (targetUserId === actorUserId) {
        throw Object.assign(new Error('You cannot deactivate your own active account.'), { status: 400 })
      }
      const targetIsOwner = target.roles.includes('Owner')
      if (targetIsOwner && this.rbac.countActiveOwners(targetUserId) === 0) {
        throw Object.assign(new Error('Cannot deactivate the final active platform Owner.'), { status: 400 })
      }
    }

    this.db
      .prepare('UPDATE users SET is_active = ?, updated_at = ? WHERE id = ?')
      .run(isActive ? 1 : 0, new Date().toISOString(), targetUserId)

    if (!isActive) {
      this.revokeAllUserSessions(targetUserId)
    }
    return this.getUserById(targetUserId)!
  }

  deleteUser(targetUserId: string, actorUserId: string): void {
    const target = this.getUserById(targetUserId)
    if (!target) throw Object.assign(new Error('User not found'), { status: 404 })
    if (targetUserId === actorUserId) {
      throw Object.assign(new Error('You cannot delete your own active account.'), { status: 400 })
    }
    if (target.roles.includes('Owner') && this.rbac.countActiveOwners(targetUserId) === 0) {
      throw Object.assign(new Error('Cannot delete the final active platform Owner.'), { status: 400 })
    }
    this.revokeAllUserSessions(targetUserId)
    this.db.prepare('DELETE FROM users WHERE id = ?').run(targetUserId)
  }

  issuePasswordResetToken(targetUserId: string, actorUserId: string): { resetToken: string; expiresAt: string } {
    const target = this.getUserById(targetUserId)
    if (!target) throw Object.assign(new Error('User not found'), { status: 404 })

    const rawToken = `kpr_${crypto.randomBytes(24).toString('hex')}`
    const tokenHash = sha256Hex(rawToken)
    const now = Date.now()
    const expiresAt = new Date(now + 15 * 60 * 1000).toISOString()

    this.db
      .prepare(
        `INSERT INTO password_resets (id, user_id, token_hash, expires_at, used_at, created_by, created_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?)`
      )
      .run(`rst-${crypto.randomBytes(6).toString('hex')}`, targetUserId, tokenHash, expiresAt, actorUserId, new Date(now).toISOString())

    return { resetToken: rawToken, expiresAt }
  }

  async consumePasswordResetToken(resetToken: string, newPassword: string): Promise<{ userId: string; email: string }> {
    const strength = validatePasswordStrength(newPassword, { strict: true })
    if (!strength.ok) {
      throw Object.assign(new Error(strength.error || 'Weak password'), { status: 400 })
    }
    const tokenHash = sha256Hex(resetToken.trim())
    const row = this.db
      .prepare(
        `SELECT pr.id, pr.user_id, pr.expires_at, pr.used_at, u.email
         FROM password_resets pr
         JOIN users u ON u.id = pr.user_id
         WHERE pr.token_hash = ?`
      )
      .get(tokenHash) as
      | { id: string; user_id: string; expires_at: string; used_at: string | null; email: string }
      | undefined

    if (!row || row.used_at || new Date(row.expires_at).getTime() <= Date.now()) {
      throw Object.assign(new Error('Password reset token is invalid or expired.'), { status: 400 })
    }

    const pwHash = await hashPassword(newPassword)
    const now = new Date().toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('UPDATE password_resets SET used_at = ? WHERE id = ?').run(now, row.id)
      this.db
        .prepare('UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL, must_change_password = 0, updated_at = ? WHERE id = ?')
        .run(pwHash, now, row.user_id)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }

    this.revokeAllUserSessions(row.user_id)
    return { userId: row.user_id, email: row.email }
  }
}
