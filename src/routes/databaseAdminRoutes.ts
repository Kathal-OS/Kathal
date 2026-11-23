import fs from 'node:fs'
import path from 'node:path'
import { Router, type Response } from 'express'
import type { DatabaseManager } from '../database/sqlite.ts'
import type { JsonMigrationSummary } from '../database/jsonMigrator.ts'
import type { AuditService } from '../audit/auditService.ts'
import { getDataDir } from '../platform.ts'
import { requirePermission, type AuthedRequest } from '../middleware/authMiddleware.ts'

export function createDatabaseAdminRouter(deps: {
  dbManager: DatabaseManager
  getJsonMigrationSummary: () => JsonMigrationSummary | null
  audit: AuditService
}): Router {
  const router = Router()
  const { dbManager, getJsonMigrationSummary, audit } = deps
  const ipOf = (req: AuthedRequest): string => req.ip || req.socket?.remoteAddress || '127.0.0.1'

  router.get('/system/database/status', requirePermission('settings.read', audit), (_req, res: Response) => {
    const status = dbManager.getStatus()
    const db = dbManager.getConnection()
    const runs = db
      .prepare('SELECT id, source_name, status, records_imported, completed_at FROM migration_runs ORDER BY completed_at DESC LIMIT 10')
      .all()
    res.json({
      ...status,
      jsonMigration: getJsonMigrationSummary(),
      migrationRuns: runs,
    })
  })

  router.get('/system/database/migrations', requirePermission('settings.read', audit), (_req, res: Response) => {
    const status = dbManager.getStatus()
    res.json({
      currentVersion: status.migrationVersion,
      appliedMigrations: status.appliedMigrations,
    })
  })

  router.post('/system/database/integrity', requirePermission('settings.manage', audit), (req: AuthedRequest, res: Response) => {
    const check = dbManager.integrityCheck()
    audit.record({
      userId: req.auth!.user.id,
      actor: req.auth!.user.email,
      action: 'database.integrity_check',
      resourceType: 'database',
      resourceId: 'kathal.db',
      outcome: check.ok ? 'success' : 'error',
      ip: ipOf(req),
      correlationId: req.requestId || '',
    })
    res.json(check)
  })

  router.post('/system/database/backup', requirePermission('backups.create', audit), async (req: AuthedRequest, res: Response) => {
    try {
      const filename = `kathal-db-${Date.now()}.db`
      const destPath = path.join(getDataDir(), 'backups', filename)
      await dbManager.backupTo(destPath)
      const stat = fs.statSync(destPath)
      audit.record({
        userId: req.auth!.user.id,
        actor: req.auth!.user.email,
        action: 'database.backup',
        resourceType: 'database',
        resourceId: filename,
        outcome: 'success',
        ip: ipOf(req),
        correlationId: req.requestId || '',
      })
      res.status(201).json({
        status: 'created',
        filename,
        path: destPath,
        sizeBytes: stat.size,
      })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message || 'Database backup failed' })
    }
  })

  return router
}
