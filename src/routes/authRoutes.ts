import { Router, type Response } from 'express'
import type { AuthService } from '../auth/authService.ts'
import type { AuditService } from '../audit/auditService.ts'
import { getRuntimeConfig } from '../config/runtimeConfig.ts'
import {
  buildClearSessionCookieHeader,
  buildSessionCookieHeader,
  createSimpleRateLimiter,
  requirePermission,
  type AuthedRequest,
} from '../middleware/authMiddleware.ts'

export function createAuthRouter(deps: {
  authService: AuthService
  audit: AuditService
  onOwnerClaimed?: (userId: string) => void
}): Router {
  const router = Router()
  const { authService, audit, onOwnerClaimed } = deps
  const authRateLimiter = createSimpleRateLimiter(40, 60_000)

  const ipOf = (req: AuthedRequest): string => req.ip || req.socket?.remoteAddress || '127.0.0.1'
  const uaOf = (req: AuthedRequest): string => String(req.headers['user-agent'] || '')

  router.get('/auth/status', (_req, res: Response) => {
    res.json(authService.getAuthStatus())
  })

  router.post('/auth/setup', authRateLimiter, async (req: AuthedRequest, res: Response) => {
    try {
      const email = String(req.body?.email || '')
      const password = String(req.body?.password || '')
      const displayName = typeof req.body?.displayName === 'string' ? req.body.displayName : undefined
      const result = await authService.claimInitialOwner(email, password, {
        ip: ipOf(req),
        userAgent: uaOf(req),
        displayName,
      })

      onOwnerClaimed?.(result.user.id)

      const cfg = getRuntimeConfig()
      res.setHeader('Set-Cookie', buildSessionCookieHeader(req, result.token, Math.floor(cfg.sessionAbsoluteMs / 1000)))
      audit.record({
        userId: result.user.id,
        actor: result.user.email,
        action: 'auth.setup',
        resourceType: 'user',
        resourceId: result.user.email,
        outcome: 'success',
        ip: ipOf(req),
        correlationId: req.requestId || '',
      })
      res.json({ token: result.token, user: { ...result.user, role: result.user.roles[0] || 'Owner' }, sessionId: result.sessionId })
    } catch (err) {
      const e = err as Error & { status?: number }
      res.status(e.status || 400).json({ error: e.message || 'Setup failed' })
    }
  })

  router.post('/auth/register', authRateLimiter, async (req: AuthedRequest, res: Response) => {
    const cfg = getRuntimeConfig()
    if (!cfg.allowSelfRegistration) {
      audit.record({
        actor: String(req.body?.email || 'anonymous'),
        action: 'auth.register',
        resourceType: 'user',
        resourceId: String(req.body?.email || ''),
        outcome: 'denied',
        ip: ipOf(req),
        correlationId: req.requestId || '',
        detail: 'self_registration_disabled',
      })
      res.status(403).json({
        error: 'Self-registration is disabled by administrator policy. Ask an administrator to create an account.',
      })
      return
    }
    if (authService.needsSetup()) {
      res.status(403).json({
        error: 'Platform setup has not been completed yet. Complete initial Owner setup first.',
        needsSetup: true,
      })
      return
    }

    try {
      const email = String(req.body?.email || '')
      const password = String(req.body?.password || '')
      const displayName = typeof req.body?.displayName === 'string' ? req.body.displayName : undefined

      // Self-registered accounts always receive least-privilege Viewer role and cannot specify elevated roles
      const user = await authService.createUser(
        {
          email,
          password,
          displayName,
          roles: ['Viewer'],
          isActive: true,
        },
        'self-registration'
      )
      const session = authService.issueSession(user.id, {
        ip: ipOf(req),
        userAgent: uaOf(req),
        authMethod: 'registration',
      })
      res.setHeader('Set-Cookie', buildSessionCookieHeader(req, session.token, Math.floor(cfg.sessionAbsoluteMs / 1000)))
      audit.record({
        userId: user.id,
        actor: user.email,
        action: 'auth.register',
        resourceType: 'user',
        resourceId: user.id,
        outcome: 'success',
        ip: ipOf(req),
        correlationId: req.requestId || '',
      })
      res.status(201).json({
        token: session.token,
        user: { ...user, role: user.roles[0] || 'Viewer' },
        sessionId: session.sessionId,
      })
    } catch (err) {
      const e = err as Error & { status?: number }
      res.status(e.status || 400).json({ error: e.message || 'Registration failed' })
    }
  })

  async function handleLogin(req: AuthedRequest, res: Response) {
    const email = String(req.body?.email || '').trim().toLowerCase()
    const password = String(req.body?.password || '')
    try {
      const result = await authService.authenticate(email, password, {
        ip: ipOf(req),
        userAgent: uaOf(req),
      })
      const cfg = getRuntimeConfig()
      res.setHeader('Set-Cookie', buildSessionCookieHeader(req, result.token, Math.floor(cfg.sessionAbsoluteMs / 1000)))
      audit.record({
        userId: result.user.id,
        actor: result.user.email,
        action: 'auth.login',
        resourceType: 'session',
        resourceId: result.sessionId,
        outcome: 'success',
        ip: ipOf(req),
        correlationId: req.requestId || '',
      })
      res.json({
        token: result.token,
        user: { ...result.user, role: result.user.roles[0] || 'Viewer' },
        sessionId: result.sessionId,
      })
    } catch (err) {
      const e = err as Error & { status?: number; reason?: string; userId?: string; needsSetup?: boolean }
      if (e.status === 401 || e.status === 429 || e.reason) {
        audit.record({
          userId: e.userId || null,
          actor: email || 'anonymous',
          action: 'auth.login',
          resourceType: 'user',
          resourceId: email || 'unknown',
          outcome: 'denied',
          ip: ipOf(req),
          correlationId: req.requestId || '',
          detail: e.reason || 'invalid_credentials',
        })
      }
      res.status(e.status || 401).json({
        error: e.message || 'Authentication failed',
        ...(e.needsSetup ? { needsSetup: true } : {}),
      })
    }
  }

  router.post('/login', authRateLimiter, handleLogin)
  router.post('/auth/login', authRateLimiter, handleLogin)

  router.post('/auth/logout', (req: AuthedRequest, res: Response) => {
    if (req.auth) {
      authService.revokeSession(req.auth.sessionId)
      audit.record({
        userId: req.auth.user.id,
        actor: req.auth.user.email,
        action: 'auth.logout',
        resourceType: 'session',
        resourceId: req.auth.sessionId,
        outcome: 'success',
        ip: ipOf(req),
        correlationId: req.requestId || '',
      })
    }
    res.setHeader('Set-Cookie', buildClearSessionCookieHeader(req))
    res.json({ status: 'logged_out' })
  })

  function handleSessionRead(req: AuthedRequest, res: Response) {
    if (!req.auth) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }
    res.json({
      user: { ...req.auth.user, role: req.auth.user.roles[0] || 'Viewer' },
      sessionId: req.auth.sessionId,
      authMethod: req.auth.authMethod,
    })
  }

  router.get('/auth/session', handleSessionRead)
  router.get('/auth/me', handleSessionRead)

  router.post('/auth/change-password', async (req: AuthedRequest, res: Response) => {
    if (!req.auth) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }
    try {
      const currentPassword = String(req.body?.currentPassword || '')
      const newPassword = String(req.body?.newPassword || '')
      await authService.changePassword(
        req.auth.user.id,
        currentPassword,
        newPassword,
        req.auth.sessionId
      )
      // Rotate current session identifier after credential change
      authService.revokeSession(req.auth.sessionId)
      const rotated = authService.issueSession(req.auth.user.id, {
        ip: ipOf(req),
        userAgent: uaOf(req),
        authMethod: req.auth.authMethod,
      })
      const cfg = getRuntimeConfig()
      res.setHeader('Set-Cookie', buildSessionCookieHeader(req, rotated.token, Math.floor(cfg.sessionAbsoluteMs / 1000)))
      audit.record({
        userId: req.auth.user.id,
        actor: req.auth.user.email,
        action: 'auth.password_change',
        resourceType: 'user',
        resourceId: req.auth.user.id,
        outcome: 'success',
        ip: ipOf(req),
        correlationId: req.requestId || '',
      })
      res.json({
        status: 'password_changed',
        token: rotated.token,
        sessionId: rotated.sessionId,
      })
    } catch (err) {
      const e = err as Error & { status?: number }
      res.status(e.status || 400).json({ error: e.message || 'Password change failed' })
    }
  })

  router.get('/auth/sessions', (req: AuthedRequest, res: Response) => {
    if (!req.auth) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }
    res.json(authService.listUserSessions(req.auth.user.id, req.auth.sessionId))
  })

  router.delete('/auth/sessions/:sessionId', (req: AuthedRequest, res: Response) => {
    if (!req.auth) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }
    const targetSessionId = String(req.params.sessionId)
    const ownSessions = authService.listUserSessions(req.auth.user.id, req.auth.sessionId)
    const ownsSession = ownSessions.some((s) => s.id === targetSessionId)
    if (!ownsSession && !req.auth.user.permissions.includes('users.manage')) {
      res.status(403).json({ error: 'Forbidden: cannot revoke another user session' })
      return
    }
    const revoked = authService.revokeSession(targetSessionId)
    if (!revoked) {
      res.status(404).json({ error: 'session not found or already revoked' })
      return
    }
    audit.record({
      userId: req.auth.user.id,
      actor: req.auth.user.email,
      action: 'auth.session_revoke',
      resourceType: 'session',
      resourceId: targetSessionId,
      outcome: 'success',
      ip: ipOf(req),
      correlationId: req.requestId || '',
    })
    res.json({ status: 'revoked', sessionId: targetSessionId })
  })

  // Admin-initiated password reset token issuance
  router.post(
    '/auth/password-reset/request',
    requirePermission('users.manage', audit),
    (req: AuthedRequest, res: Response) => {
      try {
        const userId = String(req.body?.userId || '').trim()
        if (!userId) {
          res.status(400).json({ error: 'userId is required' })
          return
        }
        const issued = authService.issuePasswordResetToken(userId, req.auth!.user.id)
        audit.record({
          userId: req.auth!.user.id,
          actor: req.auth!.user.email,
          action: 'auth.password_reset_request',
          resourceType: 'user',
          resourceId: userId,
          outcome: 'success',
          ip: ipOf(req),
          correlationId: req.requestId || '',
        })
        res.json(issued)
      } catch (err) {
        const e = err as Error & { status?: number }
        res.status(e.status || 400).json({ error: e.message || 'Failed to create reset token' })
      }
    }
  )

  // Public single-use password reset completion using issued reset token
  router.post('/auth/password-reset/confirm', authRateLimiter, async (req: AuthedRequest, res: Response) => {
    try {
      const resetToken = String(req.body?.resetToken || '')
      const newPassword = String(req.body?.newPassword || '')
      const result = await authService.consumePasswordResetToken(resetToken, newPassword)
      audit.record({
        userId: result.userId,
        actor: result.email,
        action: 'auth.password_reset_confirm',
        resourceType: 'user',
        resourceId: result.userId,
        outcome: 'success',
        ip: ipOf(req),
        correlationId: req.requestId || '',
      })
      res.json({ status: 'password_reset', email: result.email })
    } catch (err) {
      const e = err as Error & { status?: number }
      res.status(e.status || 400).json({ error: e.message || 'Password reset failed' })
    }
  })

  return router
}
