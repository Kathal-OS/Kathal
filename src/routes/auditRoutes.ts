import { Router, type Response } from 'express'
import type { AuditService } from '../audit/auditService.ts'
import { requirePermission, type AuthedRequest } from '../middleware/authMiddleware.ts'

export function createAuditRouter(deps: { audit: AuditService }): Router {
  const router = Router()
  const { audit } = deps

  router.get('/audit', requirePermission('audit.read', audit), (req: AuthedRequest, res: Response) => {
    const result = audit.query({
      page: req.query.page !== undefined ? Number(req.query.page) : undefined,
      pageSize: req.query.pageSize !== undefined ? Number(req.query.pageSize) : undefined,
      limit: req.query.limit !== undefined ? Number(req.query.limit) : undefined,
      action: typeof req.query.action === 'string' ? req.query.action : undefined,
      outcome: typeof req.query.outcome === 'string' ? req.query.outcome : undefined,
      resourceType: typeof req.query.resourceType === 'string' ? req.query.resourceType : undefined,
      userId: typeof req.query.userId === 'string' ? req.query.userId : undefined,
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      from: typeof req.query.from === 'string' ? req.query.from : undefined,
      to: typeof req.query.to === 'string' ? req.query.to : undefined,
    })

    res.setHeader('X-Total-Count', String(result.total))
    res.setHeader('X-Page', String(result.page))
    res.setHeader('X-Page-Size', String(result.pageSize))

    // Support paginated envelope when ?page= or ?paginated=1 is explicitly requested,
    // while preserving array response shape for existing ?limit=50 API consumers.
    if (req.query.page !== undefined || req.query.paginated === '1' || req.query.paginated === 'true') {
      res.json(result)
      return
    }
    res.json(result.events)
  })

  return router
}
