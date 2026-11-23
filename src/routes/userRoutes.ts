import { Router, type Response } from 'express'
import type { AuthService } from '../auth/authService.ts'
import type { RbacService } from '../auth/rbac.ts'
import type { AuditService } from '../audit/auditService.ts'
import { requirePermission, type AuthedRequest } from '../middleware/authMiddleware.ts'

export function createUserRouter(deps: {
  authService: AuthService
  rbac: RbacService
  audit: AuditService
}): Router {
  const router = Router()
  const { authService, rbac, audit } = deps
  const ipOf = (req: AuthedRequest): string => req.ip || req.socket?.remoteAddress || '127.0.0.1'

  router.get('/roles', requirePermission('users.read', audit), (_req, res: Response) => {
    res.json(rbac.listRoles())
  })

  router.get('/permissions', requirePermission('users.read', audit), (_req, res: Response) => {
    res.json(rbac.listPermissions())
  })

  router.get('/users', requirePermission('users.read', audit), (_req, res: Response) => {
    res.json(authService.listUsers())
  })

  router.post('/users', requirePermission('users.manage', audit), async (req: AuthedRequest, res: Response) => {
    try {
      const created = await authService.createUser(
        {
          email: String(req.body?.email || ''),
          password: String(req.body?.password || ''),
          displayName: typeof req.body?.displayName === 'string' ? req.body.displayName : undefined,
          roles: Array.isArray(req.body?.roles)
            ? req.body.roles.map((r: unknown) => String(r))
            : req.body?.role
            ? [String(req.body.role)]
            : ['Viewer'],
          isActive: req.body?.isActive !== false,
          mustChangePassword: Boolean(req.body?.mustChangePassword),
        },
        req.auth!.user.id
      )
      audit.record({
        userId: req.auth!.user.id,
        actor: req.auth!.user.email,
        action: 'user.create',
        resourceType: 'user',
        resourceId: created.id,
        outcome: 'success',
        ip: ipOf(req),
        correlationId: req.requestId || '',
        metadata: { email: created.email, roles: created.roles },
      })
      res.status(201).json(created)
    } catch (err) {
      const e = err as Error & { status?: number }
      res.status(e.status || 400).json({ error: e.message || 'Failed to create user' })
    }
  })

  router.patch('/users/:id', requirePermission('users.manage', audit), (req: AuthedRequest, res: Response) => {
    try {
      const targetId = String(req.params.id)
      const target = authService.getUserById(targetId)
      if (!target) {
        res.status(404).json({ error: 'User not found' })
        return
      }
      if (typeof req.body?.isActive === 'boolean') {
        const updated = authService.updateUserStatus(targetId, req.body.isActive, req.auth!.user.id)
        audit.record({
          userId: req.auth!.user.id,
          actor: req.auth!.user.email,
          action: req.body.isActive ? 'user.activate' : 'user.deactivate',
          resourceType: 'user',
          resourceId: targetId,
          outcome: 'success',
          ip: ipOf(req),
          correlationId: req.requestId || '',
          metadata: { email: updated.email },
        })
        res.json(updated)
        return
      }
      res.json(target)
    } catch (err) {
      const e = err as Error & { status?: number }
      res.status(e.status || 400).json({ error: e.message || 'Failed to update user' })
    }
  })

  router.put('/users/:id/roles', requirePermission('users.manage', audit), (req: AuthedRequest, res: Response) => {
    const targetId = String(req.params.id)
    const target = authService.getUserById(targetId)
    if (!target) {
      res.status(404).json({ error: 'User not found' })
      return
    }
    const roles: string[] = Array.isArray(req.body?.roles)
      ? req.body.roles.map((r: unknown) => String(r))
      : req.body?.role
      ? [String(req.body.role)]
      : []

    if (roles.length === 0) {
      res.status(400).json({ error: 'roles array is required' })
      return
    }

    // Prevent users from escalating their own privileges unless they hold Owner
    const actorIsOwner = req.auth!.user.roles.includes('Owner')
    if (targetId === req.auth!.user.id && !actorIsOwner) {
      audit.record({
        userId: req.auth!.user.id,
        actor: req.auth!.user.email,
        action: 'user.role_assign',
        resourceType: 'user',
        resourceId: targetId,
        outcome: 'denied',
        ip: ipOf(req),
        correlationId: req.requestId || '',
        detail: 'self_role_modification_forbidden',
      })
      res.status(403).json({ error: 'Users cannot modify their own assigned roles.' })
      return
    }

    try {
      rbac.assignRoles(targetId, roles, req.auth!.user.id)
      const updated = authService.getUserById(targetId)!
      audit.record({
        userId: req.auth!.user.id,
        actor: req.auth!.user.email,
        action: 'user.role_assign',
        resourceType: 'user',
        resourceId: targetId,
        outcome: 'success',
        ip: ipOf(req),
        correlationId: req.requestId || '',
        metadata: { email: updated.email, roles: updated.roles },
      })
      res.json(updated)
    } catch (err) {
      const msg = (err as Error).message || 'Failed to assign roles'
      const isForbidden = msg.includes('Only an existing Owner')
      audit.record({
        userId: req.auth!.user.id,
        actor: req.auth!.user.email,
        action: 'user.role_assign',
        resourceType: 'user',
        resourceId: targetId,
        outcome: 'denied',
        ip: ipOf(req),
        correlationId: req.requestId || '',
        detail: msg,
      })
      res.status(isForbidden ? 403 : 400).json({ error: msg })
    }
  })

  router.delete('/users/:id', requirePermission('users.manage', audit), (req: AuthedRequest, res: Response) => {
    try {
      const targetId = String(req.params.id)
      const target = authService.getUserById(targetId)
      authService.deleteUser(targetId, req.auth!.user.id)
      audit.record({
        userId: req.auth!.user.id,
        actor: req.auth!.user.email,
        action: 'user.delete',
        resourceType: 'user',
        resourceId: targetId,
        outcome: 'success',
        ip: ipOf(req),
        correlationId: req.requestId || '',
        metadata: { email: target?.email },
      })
      res.json({ status: 'deleted' })
    } catch (err) {
      const e = err as Error & { status?: number }
      res.status(e.status || 400).json({ error: e.message || 'Failed to delete user' })
    }
  })

  router.get('/users/:id/sessions', (req: AuthedRequest, res: Response) => {
    const targetId = String(req.params.id)
    if (targetId !== req.auth!.user.id && !req.auth!.user.permissions.includes('users.read')) {
      res.status(403).json({ error: 'Forbidden: missing required permission "users.read"' })
      return
    }
    res.json(authService.listUserSessions(targetId, req.auth!.sessionId))
  })

  router.delete('/users/:id/sessions/:sessionId', (req: AuthedRequest, res: Response) => {
    const targetId = String(req.params.id)
    if (targetId !== req.auth!.user.id && !req.auth!.user.permissions.includes('users.manage')) {
      res.status(403).json({ error: 'Forbidden: missing required permission "users.manage"' })
      return
    }
    const revoked = authService.revokeSession(String(req.params.sessionId))
    if (!revoked) {
      res.status(404).json({ error: 'Session not found or already revoked' })
      return
    }
    audit.record({
      userId: req.auth!.user.id,
      actor: req.auth!.user.email,
      action: 'user.session_revoke',
      resourceType: 'session',
      resourceId: String(req.params.sessionId),
      outcome: 'success',
      ip: ipOf(req),
      correlationId: req.requestId || '',
    })
    res.json({ status: 'revoked' })
  })

  return router
}
