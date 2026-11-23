import { Router, type Response } from 'express'
import type { DatabaseSync } from 'node:sqlite'
import type { VaultManager } from '../security/vault.ts'
import type { PlatformRepository } from '../repositories/platformRepository.ts'
import type { MemoryStore } from '../store.ts'
import type { AuditService } from '../audit/auditService.ts'
import { requirePermission, type AuthedRequest } from '../middleware/authMiddleware.ts'

export function createVaultRouter(deps: {
  db: DatabaseSync
  vault: VaultManager
  platformRepo: PlatformRepository
  store: MemoryStore
  audit: AuditService
}): Router {
  const router = Router()
  const { db, vault, platformRepo, store, audit } = deps
  const ipOf = (req: AuthedRequest): string => req.ip || req.socket?.remoteAddress || '127.0.0.1'

  router.get('/vault/status', requirePermission('settings.read', audit), (_req, res: Response) => {
    res.json(vault.getStatus(db))
  })

  router.get('/vault/recovery', requirePermission('settings.read', audit), (_req, res: Response) => {
    const status = vault.getStatus(db)
    res.json({
      locked: status.needsRecovery,
      reason: status.recoveryReason,
      keySource: status.keySource,
      keyFilePath: status.keyFilePath,
      activeKid: status.activeKid,
      steps: status.needsRecovery
        ? [
            'Locate your original KATHAL_VAULT_KEY 64-character hex key or .vault-key backup.',
            'Restore it via KATHAL_VAULT_KEY environment variable or place it at ' + status.keyFilePath + ' with 0600 permissions.',
            'Restart KATHAL OS so encrypted secrets and database credentials decrypt without data loss.',
          ]
        : ['Vault is unlocked and operating normally with authenticated AES-256-GCM encryption.'],
    })
  })

  router.post('/vault/rotate', requirePermission('settings.manage', audit), (req: AuthedRequest, res: Response) => {
    if (!req.auth!.user.roles.includes('Owner')) {
      audit.record({
        userId: req.auth!.user.id,
        actor: req.auth!.user.email,
        action: 'vault.rotate',
        resourceType: 'vault',
        resourceId: vault.getActiveKid(),
        outcome: 'denied',
        ip: ipOf(req),
        correlationId: req.requestId || '',
        detail: 'owner_role_required',
      })
      res.status(403).json({ error: 'Forbidden: Only a platform Owner may rotate vault encryption keys.' })
      return
    }
    try {
      const customKey = typeof req.body?.newKey === 'string' ? req.body.newKey : undefined
      const result = vault.rotateKey(db, customKey)
      platformRepo.loadIntoStore(store)
      audit.record({
        userId: req.auth!.user.id,
        actor: req.auth!.user.email,
        action: 'vault.rotate',
        resourceType: 'vault',
        resourceId: result.newKid,
        outcome: 'success',
        ip: ipOf(req),
        correlationId: req.requestId || '',
        metadata: {
          previousKid: result.previousKid,
          newKid: result.newKid,
          reencryptedCount: result.reencryptedCount,
        },
      })
      res.json({
        status: 'rotated',
        previousKid: result.previousKid,
        newKid: result.newKid,
        reencryptedCount: result.reencryptedCount,
        keySource: result.keySource,
      })
    } catch (err) {
      const msg = (err as Error).message || 'Vault key rotation failed'
      res.status(409).json({ error: msg })
    }
  })

  router.get('/vault/secrets', requirePermission('secrets.read', audit), (_req, res: Response) => {
    const rows = db
      .prepare('SELECT id, scope, key_name, description, is_secret, key_version, rotated_at, created_at, updated_at FROM secrets ORDER BY key_name ASC')
      .all() as Array<{
      id: string
      scope: string
      key_name: string
      description: string
      is_secret: number
      key_version: string
      rotated_at: string | null
      created_at: string
      updated_at: string
    }>
    res.json(
      rows.map((r) => ({
        id: r.id,
        scope: r.scope,
        key: r.key_name,
        description: r.description,
        secret: Boolean(r.is_secret),
        keyVersion: r.key_version,
        maskedValue: r.is_secret ? '••••••••' : '[plain]',
        rotatedAt: r.rotated_at,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }))
    )
  })

  router.post('/vault/secrets/:key/reveal', requirePermission('secrets.reveal', audit), (req: AuthedRequest, res: Response) => {
    const key = decodeURIComponent(String(req.params.key))
    const item = store.envVars.find((e) => e.key === key)
    if (!item) {
      res.status(404).json({ error: 'Secret not found' })
      return
    }
    audit.record({
      userId: req.auth!.user.id,
      actor: req.auth!.user.email,
      action: 'vault.secret_reveal',
      resourceType: 'secret',
      resourceId: key,
      outcome: 'success',
      ip: ipOf(req),
      correlationId: req.requestId || '',
    })
    res.json({ key: item.key, value: item.value })
  })

  router.post('/vault/secrets/:key/rotate', requirePermission('secrets.reveal', audit), (req: AuthedRequest, res: Response) => {
    const key = decodeURIComponent(String(req.params.key))
    const newValue = String(req.body?.value || '')
    if (!newValue) {
      res.status(400).json({ error: 'New secret value is required' })
      return
    }
    const existing = store.envVars.find((e) => e.key === key)
    if (!existing) {
      res.status(404).json({ error: 'Secret not found' })
      return
    }
    existing.value = newValue
    platformRepo.rotateSecretValue(key, newValue)
    audit.record({
      userId: req.auth!.user.id,
      actor: req.auth!.user.email,
      action: 'vault.secret_rotate',
      resourceType: 'secret',
      resourceId: key,
      outcome: 'success',
      ip: ipOf(req),
      correlationId: req.requestId || '',
    })
    res.json({ status: 'rotated', key })
  })

  return router
}
