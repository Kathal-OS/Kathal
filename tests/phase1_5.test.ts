import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import type http from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import bcrypt from 'bcryptjs'
import WebSocket from 'ws'

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kathal-p15-'))
const testAppsDir = path.join(testRoot, 'apps')
fs.mkdirSync(testAppsDir, { recursive: true })

process.env.KATHAL_DATA_DIR = testRoot
process.env.KATHAL_APPS_DIR = testAppsDir
process.env.KATHAL_DISABLE_AUTOSTART = '1'
process.env.KATHAL_JWT_SECRET = 'phase15-test-jwt-secret-0123456789abcdef'
process.env.KATHAL_VAULT_KEY = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
process.env.KATHAL_ALLOW_SELF_REGISTRATION = 'false'
process.env.KATHAL_FLEET_ALLOW_PRIVATE_NETWORKS = 'false'
process.env.NODE_ENV = 'production'

const { DatabaseManager } = await import('../src/database/sqlite.ts')
const { migrateLegacyJsonToSqlite } = await import('../src/database/jsonMigrator.ts')
const { VaultManager, VaultLockedError } = await import('../src/security/vault.ts')
const { RbacService } = await import('../src/auth/rbac.ts')
const { AuditService, sanitizeAuditMetadata } = await import('../src/audit/auditService.ts')
const { PersistenceManager } = await import('../src/persistence.ts')
const { startServer } = await import('../server.ts')

function extractSessionCookie(setCookieHeader: string | null): string {
  assert.ok(setCookieHeader, 'Expected Set-Cookie header')
  const match = /kathal_session=([^;]+)/.exec(setCookieHeader)
  assert.ok(match && match[1], 'Expected kathal_session cookie value')
  return `kathal_session=${match[1]}`
}

describe('Phase 1.5 SQLite Engine, Migrations, FK, Transactions & Backups', () => {
  const unitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kathal-sqlite-unit-'))
  const dbPath = path.join(unitDir, 'unit.db')

  after(() => {
    fs.rmSync(unitDir, { recursive: true, force: true })
  })

  it('initializes WAL mode, foreign keys, schema_migrations, and supports rollback + re-apply', () => {
    const mgr = new DatabaseManager(dbPath)
    const db = mgr.initialize()
    const status = mgr.getStatus()

    assert.equal(status.engine, 'sqlite')
    assert.equal(status.walMode.toLowerCase(), 'wal')
    assert.equal(status.foreignKeysEnabled, true)
    assert.equal(status.integrityOk, true)
    assert.equal(status.migrationVersion, 2)

    // Foreign key constraint must block orphan rows
    assert.throws(() => {
      db.prepare(
        "INSERT INTO user_roles (user_id, role_id, assigned_at) VALUES ('nonexistent-user', 'role-owner', ?)"
      ).run(new Date().toISOString())
    })

    // Rollback migration 2 and migration 1 then re-apply all cleanly
    const rolled2 = mgr.rollbackLastMigration()
    assert.equal(rolled2?.version, 2)
    const rolled1 = mgr.rollbackLastMigration()
    assert.equal(rolled1?.version, 1)
    const reapplied = mgr.runMigrations()
    assert.equal(reapplied.length, 2)
    assert.equal(reapplied[0].version, 1)
    assert.equal(reapplied[1].version, 2)

    mgr.close()
  })

  it('rolls back failed transactions and produces valid hot backups', async () => {
    const mgr = new DatabaseManager(dbPath)
    const db = mgr.initialize()
    const rbac = new RbacService(db)
    rbac.seedDefaults()

    const beforeUsers = (db.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number }).cnt
    assert.throws(() => {
      mgr.transaction(() => {
        const now = new Date().toISOString()
        db.prepare(
          `INSERT INTO users (id, email, display_name, password_hash, is_active, created_at, updated_at)
           VALUES ('usr-rollback', 'rb@kathal.local', 'RB', 'hash', 1, ?, ?)`
        ).run(now, now)
        throw new Error('forced rollback')
      })
    }, /forced rollback/)

    const afterUsers = (db.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number }).cnt
    assert.equal(afterUsers, beforeUsers)

    const backupFile = path.join(unitDir, 'snapshots', 'hot-backup.db')
    await mgr.backupTo(backupFile)
    assert.ok(fs.existsSync(backupFile))

    const snap = new DatabaseSync(backupFile)
    const snapIntegrity = snap.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
    assert.equal(snapIntegrity.integrity_check.toLowerCase(), 'ok')
    snap.close()
    mgr.close()
  })
})

describe('Phase 1.5 Legacy JSON-to-SQLite Migration & Repeatable Safety', () => {
  const migDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kathal-json-mig-'))

  after(() => {
    fs.rmSync(migDir, { recursive: true, force: true })
  })

  it('migrates legacy auth/platform/audit JSON idempotently, preserves IDs, encrypts secrets, and retains originals', async () => {
    const legacyBcrypt = await bcrypt.hash('LegacyPass123!', 4)
    const createdTs = '2025-10-01T10:00:00.000Z'

    fs.writeFileSync(
      path.join(migDir, 'auth-state.json'),
      JSON.stringify({ email: 'legacy-owner@kathal.local', passwordHash: legacyBcrypt, updatedAt: createdTs })
    )
    fs.writeFileSync(
      path.join(migDir, 'platform-state.json'),
      JSON.stringify({
        settings: {
          serverName: 'Legacy Jackfruit Node',
          serverDomain: 'legacy.kathal.local',
          webhookSecret: 'legacy-wh-secret-999',
        },
        databases: [
          {
            id: 'db-legacy-1',
            name: 'legacy-pg',
            type: 'postgres',
            port: 5432,
            user: 'postgres',
            password: 'legacy-db-password-secret',
            status: 'running',
          },
        ],
        envVars: [
          { key: 'LEGACY_API_KEY', value: 'sk_legacy_secret_value', description: 'API key', secret: true },
        ],
        fleetServers: [
          {
            id: 'srv-legacy-1',
            name: 'edge-old-1',
            host: '203.0.113.50',
            port: 22,
            authMethod: 'ssh-key',
            role: 'worker',
            group: 'edge',
            tags: ['eu'],
            status: 'pending',
            isLocal: false,
            os: 'Linux',
            arch: 'x64',
            agentVersion: null,
            lastCheckedAt: null,
            latencyMs: null,
            createdAt: createdTs,
          },
        ],
      })
    )
    fs.writeFileSync(
      path.join(migDir, 'audit-log.json'),
      JSON.stringify([
        {
          id: 'aud-legacy-1',
          timestamp: createdTs,
          actor: 'legacy-owner@kathal.local',
          action: 'deploy.app',
          target: 'blog',
          outcome: 'success',
          ip: '127.0.0.1',
        },
      ])
    )

    const mgr = new DatabaseManager(path.join(migDir, 'kathal.db'))
    const db = mgr.initialize()
    new RbacService(db).seedDefaults()
    const vault = new VaultManager()
    vault.initialize(db)

    const first = await migrateLegacyJsonToSqlite(mgr, vault, migDir)
    assert.equal(first.executed, true)
    assert.equal(first.alreadyCompleted, false)
    assert.equal(first.verified, true)
    assert.ok(first.backupPath && fs.existsSync(first.backupPath))
    assert.equal(first.importedCounts.authUsers, 1)
    assert.equal(first.importedCounts.databases, 1)
    assert.equal(first.importedCounts.secrets, 1)
    assert.equal(first.importedCounts.servers, 1)
    assert.equal(first.importedCounts.auditEvents, 1)

    // Original JSON files must be retained intact
    assert.ok(fs.existsSync(path.join(migDir, 'auth-state.json')))
    assert.ok(fs.existsSync(path.join(migDir, 'platform-state.json')))
    assert.ok(fs.existsSync(path.join(migDir, 'audit-log.json')))

    // Verify encrypted at rest & preserved IDs
    const dbRow = db.prepare('SELECT id, password_enc FROM databases WHERE id = ?').get('db-legacy-1') as {
      id: string
      password_enc: string
    }
    assert.equal(dbRow.id, 'db-legacy-1')
    assert.ok(dbRow.password_enc.startsWith('enc:v2:'))
    assert.equal(vault.decryptSecret(dbRow.password_enc), 'legacy-db-password-secret')

    // Second run must be idempotent without duplicating records
    const second = await migrateLegacyJsonToSqlite(mgr, vault, migDir)
    assert.equal(second.executed, false)
    assert.equal(second.alreadyCompleted, true)
    const userCount = (db.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number }).cnt
    assert.equal(userCount, 1)

    mgr.close()
  })

  it('aborts safely and retains original JSON files when JSON input is malformed', async () => {
    const corruptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kathal-json-bad-'))
    try {
      fs.writeFileSync(path.join(corruptDir, 'platform-state.json'), '{not-valid-json')
      const mgr = new DatabaseManager(path.join(corruptDir, 'kathal.db'))
      const db = mgr.initialize()
      new RbacService(db).seedDefaults()
      const vault = new VaultManager()
      vault.initialize(db)

      await assert.rejects(() => migrateLegacyJsonToSqlite(mgr, vault, corruptDir))
      assert.ok(fs.existsSync(path.join(corruptDir, 'platform-state.json')))
      mgr.close()
    } finally {
      fs.rmSync(corruptDir, { recursive: true, force: true })
    }
  })
})

describe('Phase 1.5 Vault Security Hardening & Recovery', () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kathal-vault-unit-'))

  after(() => {
    fs.rmSync(vaultDir, { recursive: true, force: true })
  })

  it('uses enc:v2 AES-256-GCM with AAD, decrypts enc:v1 backwards, detects key mismatch with VaultLockedError, and rotates keys atomically', () => {
    const prevDataDir = process.env.KATHAL_DATA_DIR
    const prevVaultKey = process.env.KATHAL_VAULT_KEY
    process.env.KATHAL_DATA_DIR = vaultDir
    process.env.KATHAL_VAULT_KEY = '1111111111111111111111111111111111111111111111111111111111111111'

    try {
      const mgr = new DatabaseManager(path.join(vaultDir, 'vault.db'))
      const db = mgr.initialize()
      new RbacService(db).seedDefaults()

      const vault = new VaultManager()
      vault.initialize(db)

      const encV2 = vault.encryptSecret('top-secret-token-value')
      assert.ok(encV2.startsWith('enc:v2:vk-v1:'))
      assert.equal(vault.decryptSecret(encV2), 'top-secret-token-value')

      // Backward decryption of enc:v1 ciphertext using same master key
      const pm = new PersistenceManager()
      const encV1 = pm.encryptSecret('legacy-v1-secret')
      assert.ok(encV1.startsWith('enc:v1:'))
      assert.equal(vault.decryptSecret(encV1), 'legacy-v1-secret')

      // Store encrypted record in DB
      const now = new Date().toISOString()
      db.prepare(
        `INSERT INTO secrets (id, scope, key_name, value_enc, is_secret, key_version, created_at, updated_at)
         VALUES ('sec-v1', 'global', 'JWT_SIGNING', ?, 1, 'vk-v1', ?, ?)`
      ).run(encV2, now, now)

      // Tampering AAD / kid fails authentication
      const tamperedAad = encV2.replace('vk-v1:', 'vk-evil:')
      assert.throws(() => vault.decryptSecret(tamperedAad))

      // Re-open with WRONG vault key -> Vault must lock and refuse overwriting vault_keys
      process.env.KATHAL_VAULT_KEY = '2222222222222222222222222222222222222222222222222222222222222222'
      const lockedVault = new VaultManager()
      lockedVault.initialize(db)
      assert.equal(lockedVault.isLocked(), true)
      assert.throws(() => lockedVault.decryptSecret(encV2), VaultLockedError)
      assert.throws(() => lockedVault.rotateKey(db), VaultLockedError)

      // Restore original key -> unlocks & rotates cleanly
      process.env.KATHAL_VAULT_KEY = '1111111111111111111111111111111111111111111111111111111111111111'
      const unlockedVault = new VaultManager()
      unlockedVault.initialize(db)
      assert.equal(unlockedVault.isLocked(), false)

      const newKeyHex = '3333333333333333333333333333333333333333333333333333333333333333'
      const rotated = unlockedVault.rotateKey(db, newKeyHex)
      assert.equal(rotated.previousKid, 'vk-v1')
      assert.equal(rotated.reencryptedCount, 1)

      const updatedRow = db.prepare('SELECT value_enc, key_version FROM secrets WHERE id = ?').get('sec-v1') as {
        value_enc: string
        key_version: string
      }
      assert.equal(updatedRow.key_version, rotated.newKid)
      assert.ok(updatedRow.value_enc.startsWith(`enc:v2:${rotated.newKid}:`))
      assert.equal(unlockedVault.decryptSecret(updatedRow.value_enc), 'top-secret-token-value')

      mgr.close()
    } finally {
      process.env.KATHAL_DATA_DIR = prevDataDir
      process.env.KATHAL_VAULT_KEY = prevVaultKey
    }
  })

  it('sanitizeAuditMetadata redacts sensitive keys and encrypted/hashed payloads', () => {
    const clean = sanitizeAuditMetadata({
      email: 'ops@kathal.local',
      password: 'plaintext-password',
      api_key: 'tok_123',
      nested: {
        cipher: 'enc:v2:vk-v1:aa:bb:cc',
        digest: '$scrypt$16384$8$1$salt$hash',
        safeField: 'visible',
      },
    }) as Record<string, unknown>
    assert.equal(clean.email, 'ops@kathal.local')
    assert.equal(clean.password, '[REDACTED]')
    assert.equal(clean.api_key, '[REDACTED]')
    const nested = clean.nested as Record<string, unknown>
    assert.equal(nested.cipher, '[REDACTED]')
    assert.equal(nested.digest, '[REDACTED]')
    assert.equal(nested.safeField, 'visible')
  })
})

describe('Phase 1.5 Multi-User Auth, 5-Role RBAC, Sessions, WebSocket & Fleet Integration', () => {
  let server: http.Server
  let baseUrl = ''
  let wsBaseUrl = ''
  let ownerToken = ''
  let ownerCookie = ''
  let ownerId = ''
  let adminToken = ''
  let adminId = ''
  let operatorToken = ''
  let developerToken = ''
  let viewerToken = ''
  let viewerId = ''
  let dbPath = ''

  before(async () => {
    const started = await startServer(0)
    server = started.server
    dbPath = path.join(testRoot, 'kathal.db')
    const addr = server.address()
    assert.ok(addr && typeof addr === 'object')
    baseUrl = `http://127.0.0.1:${addr.port}`
    wsBaseUrl = `ws://127.0.0.1:${addr.port}`
  })

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(testRoot, { recursive: true, force: true })
  })

  it('claims Owner, enforces self-registration policy, issues HttpOnly session cookies, and blocks cross-origin CSRF', async () => {
    const setupRes = await fetch(`${baseUrl}/api/v1/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@kathal.local', password: 'OwnerPass123!' }),
    })
    assert.equal(setupRes.status, 200)
    ownerCookie = extractSessionCookie(setupRes.headers.get('set-cookie'))
    const setupJson = (await setupRes.json()) as { token: string; user: { id: string; roles: string[] } }
    ownerToken = setupJson.token
    ownerId = setupJson.user.id
    assert.deepEqual(setupJson.user.roles, ['Owner'])

    // Self-registration is disabled by default -> 403
    const regDenied = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'self@kathal.local', password: 'SelfPass123!' }),
    })
    assert.equal(regDenied.status, 403)

    // Enable self-registration -> 201 and always assigns Viewer even if caller requests Owner
    process.env.KATHAL_ALLOW_SELF_REGISTRATION = 'true'
    const regAllowed = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'self@kathal.local',
        password: 'SelfPass123!',
        roles: ['Owner'],
      }),
    })
    assert.equal(regAllowed.status, 201)
    const regJson = (await regAllowed.json()) as { user: { roles: string[] } }
    assert.deepEqual(regJson.user.roles, ['Viewer'])
    process.env.KATHAL_ALLOW_SELF_REGISTRATION = 'false'

    // Cookie auth works on GET /auth/session
    const cookieSession = await fetch(`${baseUrl}/api/v1/auth/session`, {
      headers: { Cookie: ownerCookie },
    })
    assert.equal(cookieSession.status, 200)

    // Cross-origin cookie POST without X-Requested-With fails CSRF check -> 403
    const csrfBlocked = await fetch(`${baseUrl}/api/v1/env`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: ownerCookie,
        Origin: 'https://evil-csrf.example',
      },
      body: JSON.stringify({ key: 'CSRF_TEST', value: 'bad' }),
    })
    assert.equal(csrfBlocked.status, 403)

    // Same-origin / X-Requested-With cookie POST succeeds
    const csrfAllowed = await fetch(`${baseUrl}/api/v1/env`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: ownerCookie,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({ key: 'COOKIE_OK', value: 'good', secret: false }),
    })
    assert.equal(csrfAllowed.status, 200)
  })

  it('creates users for all 5 roles and enforces RBAC permission boundaries and anti-escalation rules', async () => {
    const ownerHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ownerToken}`,
    }

    async function createAndLogin(email: string, role: string, password: string) {
      const createdRes = await fetch(`${baseUrl}/api/v1/users`, {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ email, password, roles: [role] }),
      })
      assert.equal(createdRes.status, 201, `Failed creating ${role}: ${createdRes.status}`)
      const createdUser = (await createdRes.json()) as { id: string; passwordHash?: string }
      assert.equal('passwordHash' in createdUser, false)

      const loginRes = await fetch(`${baseUrl}/api/v1/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      assert.equal(loginRes.status, 200)
      const loginJson = (await loginRes.json()) as { token: string; user: { id: string } }
      return { id: createdUser.id, token: loginJson.token }
    }

    const admin = await createAndLogin('admin2@kathal.local', 'Administrator', 'AdminPass123!')
    const operator = await createAndLogin('operator@kathal.local', 'Operator', 'OperatorPass123!')
    const developer = await createAndLogin('dev@kathal.local', 'Developer', 'DevPass123!')
    const viewer = await createAndLogin('viewer@kathal.local', 'Viewer', 'ViewerPass123!')

    adminToken = admin.token
    adminId = admin.id
    operatorToken = operator.token
    developerToken = developer.token
    viewerToken = viewer.token
    viewerId = viewer.id

    // Viewer: read allowed, writes & audit & terminal denied
    assert.equal(
      (await fetch(`${baseUrl}/api/v1/services`, { headers: { Authorization: `Bearer ${viewerToken}` } })).status,
      200
    )
    assert.equal(
      (
        await fetch(`${baseUrl}/api/v1/databases`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${viewerToken}` },
          body: JSON.stringify({ name: 'nope', type: 'postgres' }),
        })
      ).status,
      403
    )
    assert.equal(
      (await fetch(`${baseUrl}/api/v1/audit`, { headers: { Authorization: `Bearer ${viewerToken}` } })).status,
      403
    )
    assert.equal(
      (
        await fetch(`${baseUrl}/api/v1/terminal/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${viewerToken}` },
          body: '{}',
        })
      ).status,
      403
    )

    // Developer: can create git repos / deploy apps, cannot manage databases or view users
    assert.equal(
      (
        await fetch(`${baseUrl}/api/v1/git/repos`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${developerToken}` },
          body: JSON.stringify({ name: 'dev-repo', url: 'https://github.com/Kathal-OS/Kathal.git' }),
        })
      ).status,
      200
    )
    assert.equal(
      (
        await fetch(`${baseUrl}/api/v1/databases`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${developerToken}` },
          body: JSON.stringify({ name: 'dev-nope', type: 'postgres' }),
        })
      ).status,
      403
    )
    assert.equal(
      (await fetch(`${baseUrl}/api/v1/users`, { headers: { Authorization: `Bearer ${developerToken}` } })).status,
      403
    )

    // Operator: can manage databases & access terminal, cannot manage users or settings
    assert.equal(
      (
        await fetch(`${baseUrl}/api/v1/databases`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${operatorToken}` },
          body: JSON.stringify({ name: 'op-db', type: 'redis', password: 'op-secret-password' }),
        })
      ).status,
      200
    )
    assert.equal(
      (
        await fetch(`${baseUrl}/api/v1/settings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${operatorToken}` },
          body: JSON.stringify({ serverName: 'Unauthorized Change' }),
        })
      ).status,
      403
    )

    // Administrator: can read audit & manage non-Owner users, CANNOT rotate vault keys, CANNOT assign Owner, CANNOT change own role
    assert.equal(
      (await fetch(`${baseUrl}/api/v1/audit?paginated=1`, { headers: { Authorization: `Bearer ${adminToken}` } })).status,
      200
    )
    assert.equal(
      (
        await fetch(`${baseUrl}/api/v1/vault/rotate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
          body: '{}',
        })
      ).status,
      403
    )
    assert.equal(
      (
        await fetch(`${baseUrl}/api/v1/users/${viewerId}/roles`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
          body: JSON.stringify({ roles: ['Owner'] }),
        })
      ).status,
      403
    )
    assert.equal(
      (
        await fetch(`${baseUrl}/api/v1/users/${adminId}/roles`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
          body: JSON.stringify({ roles: ['Viewer'] }),
        })
      ).status,
      403
    )

    // Final active Owner cannot be demoted or deactivated
    assert.equal(
      (
        await fetch(`${baseUrl}/api/v1/users/${ownerId}/roles`, {
          method: 'PUT',
          headers: ownerHeaders,
          body: JSON.stringify({ roles: ['Viewer'] }),
        })
      ).status,
      400
    )

    // Owner CAN rotate vault keys via HTTP API
    const rotateRes = await fetch(`${baseUrl}/api/v1/vault/rotate`, {
      method: 'POST',
      headers: ownerHeaders,
      body: '{}',
    })
    assert.equal(rotateRes.status, 200)
    const rotateJson = (await rotateRes.json()) as { status: string; newKid: string }
    assert.equal(rotateJson.status, 'rotated')
    assert.ok(rotateJson.newKid)
  })

  it('enforces lockout, password reset tokens, session expiration, deactivation, and password-change revocation', async () => {
    const ownerHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ownerToken}`,
    }

    // 1. Account lockout after 5 wrong password attempts on viewer account
    for (let i = 0; i < 4; i++) {
      const r = await fetch(`${baseUrl}/api/v1/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'viewer@kathal.local', password: 'WrongPassword1!' }),
      })
      assert.equal(r.status, 401)
    }
    const fifth = await fetch(`${baseUrl}/api/v1/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'viewer@kathal.local', password: 'WrongPassword1!' }),
    })
    assert.equal(fifth.status, 429)

    // 2. Admin/Owner issues single-use reset token, clears lockout & resets password
    const resetReq = await fetch(`${baseUrl}/api/v1/auth/password-reset/request`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ userId: viewerId }),
    })
    assert.equal(resetReq.status, 200)
    const { resetToken } = (await resetReq.json()) as { resetToken: string }
    assert.ok(resetToken)

    const confirmRes = await fetch(`${baseUrl}/api/v1/auth/password-reset/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resetToken, newPassword: 'ViewerNewPass123!' }),
    })
    assert.equal(confirmRes.status, 200)

    // Replaying same reset token fails
    const replayReset = await fetch(`${baseUrl}/api/v1/auth/password-reset/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resetToken, newPassword: 'AnotherPass123!' }),
    })
    assert.equal(replayReset.status, 400)

    // Old viewer token was revoked by password reset
    assert.equal(
      (await fetch(`${baseUrl}/api/v1/auth/session`, { headers: { Authorization: `Bearer ${viewerToken}` } })).status,
      401
    )

    // Login with new password & create two concurrent sessions; changing password revokes the other
    const s1 = (await fetch(`${baseUrl}/api/v1/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'viewer@kathal.local', password: 'ViewerNewPass123!' }),
    }).then((r) => r.json())) as { token: string }

    const s2 = (await fetch(`${baseUrl}/api/v1/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'viewer@kathal.local', password: 'ViewerNewPass123!' }),
    }).then((r) => r.json())) as { token: string }

    const pwChangeRes = await fetch(`${baseUrl}/api/v1/auth/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s2.token}` },
      body: JSON.stringify({ currentPassword: 'ViewerNewPass123!', newPassword: 'ViewerFinal123!' }),
    })
    assert.equal(pwChangeRes.status, 200)
    const pwChangeJson = (await pwChangeRes.json()) as { token: string }

    // Session 1 and previous s2 token must now be invalid; rotated token is valid
    assert.equal(
      (await fetch(`${baseUrl}/api/v1/auth/session`, { headers: { Authorization: `Bearer ${s1.token}` } })).status,
      401
    )
    assert.equal(
      (await fetch(`${baseUrl}/api/v1/auth/session`, { headers: { Authorization: `Bearer ${s2.token}` } })).status,
      401
    )
    assert.equal(
      (await fetch(`${baseUrl}/api/v1/auth/session`, { headers: { Authorization: `Bearer ${pwChangeJson.token}` } })).status,
      200
    )

    // 3. Idle expiration enforcement via SQLite row expiry
    const sTemp = (await fetch(`${baseUrl}/api/v1/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'viewer@kathal.local', password: 'ViewerFinal123!' }),
    }).then((r) => r.json())) as { token: string; sessionId: string }

    const directDb = new DatabaseSync(dbPath)
    directDb
      .prepare('UPDATE sessions SET idle_expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 60_000).toISOString(), sTemp.sessionId)
    directDb.close()

    assert.equal(
      (await fetch(`${baseUrl}/api/v1/auth/session`, { headers: { Authorization: `Bearer ${sTemp.token}` } })).status,
      401
    )

    // 4. Deactivated user cannot sign in and active sessions are invalidated
    const deact = await fetch(`${baseUrl}/api/v1/users/${viewerId}`, {
      method: 'PATCH',
      headers: ownerHeaders,
      body: JSON.stringify({ isActive: false }),
    })
    assert.equal(deact.status, 200)
    const loginDeact = await fetch(`${baseUrl}/api/v1/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'viewer@kathal.local', password: 'ViewerFinal123!' }),
    })
    assert.equal(loginDeact.status, 403)
  })

  it('hardens WebSocket terminal with Origin checks, session ownership, and instant close on session revocation', async () => {
    const opLogin = (await fetch(`${baseUrl}/api/v1/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'operator@kathal.local', password: 'OperatorPass123!' }),
    }).then((r) => r.json())) as { token: string; sessionId: string }

    const termSess = (await fetch(`${baseUrl}/api/v1/terminal/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opLogin.token}` },
      body: JSON.stringify({ cols: 80, rows: 24 }),
    }).then((r) => r.json())) as { id: string; wsTicket: string }

    // Cross-user delete must fail with 403
    const crossDelete = await fetch(`${baseUrl}/api/v1/terminal/sessions/${termSess.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${developerToken}` },
    })
    assert.equal(crossDelete.status, 403)

    // Cross-origin WebSocket upgrade must fail
    await assert.rejects(
      () =>
        new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(`${wsBaseUrl}/api/v1/terminal/ws/${termSess.id}?ticket=${termSess.wsTicket}`, {
            headers: { Origin: 'https://malicious.example' },
          })
          ws.once('open', () => {
            ws.close()
            resolve()
          })
          ws.once('error', reject)
        })
    )

    // Valid connection opens cleanly, then closes with 4001 as soon as auth session is logged out
    const closedPromise = new Promise<{ code: number }>((resolve, reject) => {
      const ws = new WebSocket(`${wsBaseUrl}/api/v1/terminal/ws/${termSess.id}?ticket=${termSess.wsTicket}`)
      ws.once('open', async () => {
        await fetch(`${baseUrl}/api/v1/auth/logout`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${opLogin.token}` },
        })
      })
      ws.once('close', (code) => resolve({ code }))
      ws.once('error', reject)
    })

    const closed = await closedPromise
    assert.equal(closed.code, 4001)
  })

  it('enforces Fleet SSRF rules, records server status history & agent heartbeats, and queries paginated Audit logs', async () => {
    const ownerHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ownerToken}`,
    }

    // SSRF checks: loopback, metadata, IPv4-mapped IPv6 metadata, and private IP (since KATHAL_FLEET_ALLOW_PRIVATE_NETWORKS=false)
    for (const badHost of ['127.0.0.1', '169.254.169.254', '::ffff:169.254.169.254', 'metadata.google.internal', '10.0.0.5']) {
      const r = await fetch(`${baseUrl}/api/v1/fleet/servers`, {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ name: 'bad-node', host: badHost, port: 22 }),
      })
      assert.equal(r.status, 400, `Expected 400 for blocked host ${badHost}`)
    }

    // Valid public documentation IP (TEST-NET-3) with agent-token
    const createdNode = (await fetch(`${baseUrl}/api/v1/fleet/servers`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({
        name: 'edge-public-1',
        host: '203.0.113.10',
        port: 22,
        authMethod: 'agent-token',
        group: 'eu-west',
      }),
    }).then((r) => r.json())) as { id: string; agentId: string; agentToken: string }

    assert.ok(createdNode.id)
    assert.ok(createdNode.agentId)
    assert.ok(createdNode.agentToken.startsWith('kat_'))

    // Invalid agent token rejected -> 401
    const badHb = await fetch(`${baseUrl}/api/v1/fleet/agent/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer kat_wrong_token',
        'x-kathal-agent-id': createdNode.agentId,
      },
      body: JSON.stringify({ cpuPercent: 12 }),
    })
    assert.equal(badHb.status, 401)

    // Valid agent heartbeat marks server online and writes history entry
    const goodHb = await fetch(`${baseUrl}/api/v1/fleet/agent/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${createdNode.agentToken}`,
        'x-kathal-agent-id': createdNode.agentId,
      },
      body: JSON.stringify({
        agentVersion: '0.2.0',
        os: 'Ubuntu 24.04',
        arch: 'x64',
        cpuPercent: 21.5,
        memoryPercent: 48.2,
        diskPercent: 33.0,
      }),
    })
    assert.equal(goodHb.status, 200)
    const hbJson = (await goodHb.json()) as { server: { status: string; agentVersion: string } }
    assert.equal(hbJson.server.status, 'online')
    assert.equal(hbJson.server.agentVersion, '0.2.0')

    // Rotate agent token and verify old token stops working
    const rot = (await fetch(`${baseUrl}/api/v1/fleet/servers/${createdNode.id}/agent-token`, {
      method: 'POST',
      headers: ownerHeaders,
      body: '{}',
    }).then((r) => r.json())) as { agentId: string; agentToken: string }
    assert.notEqual(rot.agentToken, createdNode.agentToken)

    const oldTokHb = await fetch(`${baseUrl}/api/v1/fleet/agent/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${createdNode.agentToken}`,
        'x-kathal-agent-id': rot.agentId,
      },
      body: JSON.stringify({ cpuPercent: 10 }),
    })
    assert.equal(oldTokHb.status, 401)

    const historyRes = (await fetch(`${baseUrl}/api/v1/fleet/servers/${createdNode.id}/history`, {
      headers: ownerHeaders,
    }).then((r) => r.json())) as Array<{ status: string; cpuPercent: number | null }>
    assert.ok(Array.isArray(historyRes) && historyRes.length >= 1)
    assert.equal(historyRes[0].status, 'online')
    assert.equal(historyRes[0].cpuPercent, 21.5)

    // Paginated audit filter query must include rbac.denied events
    const auditPage = (await fetch(
      `${baseUrl}/api/v1/audit?paginated=1&action=rbac.denied&outcome=denied&page=1&pageSize=10`,
      { headers: ownerHeaders }
    ).then((r) => r.json())) as { events: Array<{ action: string; outcome: string }>; total: number; page: number }
    assert.equal(auditPage.page, 1)
    assert.ok(auditPage.total >= 1)
    assert.ok(auditPage.events.every((e) => e.action === 'rbac.denied' && e.outcome === 'denied'))
  })
})
