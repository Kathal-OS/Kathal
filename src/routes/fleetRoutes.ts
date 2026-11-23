import os from 'node:os'
import { Router, type Response } from 'express'
import type { FleetService } from '../fleet/fleetService.ts'
import type { AuditService } from '../audit/auditService.ts'
import type { MemoryStore } from '../store.ts'
import { getPlatformLabel } from '../platform.ts'
import { requirePermission, type AuthedRequest } from '../middleware/authMiddleware.ts'

export function createFleetRouter(deps: {
  fleetService: FleetService
  audit: AuditService
  store: MemoryStore
  getVersion: () => string
  getRunningAppsCount: () => number
}): Router {
  const router = Router()
  const { fleetService, audit, store, getVersion, getRunningAppsCount } = deps
  const ipOf = (req: AuthedRequest): string => req.ip || req.socket?.remoteAddress || '127.0.0.1'

  router.get('/fleet/servers', requirePermission('servers.read', audit), (_req, res: Response) => {
    const sys = store.collectSystemMetrics()
    const runningCount = getRunningAppsCount()
    const servers = fleetService.listServers().map((node) => {
      if (node.isLocal) {
        return {
          ...node,
          status: 'online' as const,
          os: `${getPlatformLabel()} (${os.platform()})`,
          arch: os.arch(),
          agentVersion: getVersion(),
          lastCheckedAt: new Date().toISOString(),
          telemetry: {
            cpuPercent: sys.cpu,
            memoryPercent: sys.memory.percent,
            diskPercent: sys.disk.percent,
            runningApps: runningCount,
          },
        }
      }
      return {
        ...node,
        telemetry: null,
      }
    })

    res.json({
      servers,
      summary: {
        total: servers.length,
        online: servers.filter((s) => s.status === 'online').length,
        pending: servers.filter((s) => s.status === 'pending').length,
        unreachable: servers.filter((s) => s.status === 'unreachable').length,
      },
    })
  })

  router.get('/fleet/groups', requirePermission('servers.read', audit), (_req, res: Response) => {
    res.json(fleetService.listGroups())
  })

  router.post('/fleet/servers', requirePermission('servers.create', audit), (req: AuthedRequest, res: Response) => {
    try {
      const { server, agentToken } = fleetService.registerServer(
        {
          name: String(req.body?.name || ''),
          host: String(req.body?.host || ''),
          port: req.body?.port !== undefined && req.body?.port !== '' ? Number(req.body.port) : 22,
          authMethod: req.body?.authMethod,
          group: req.body?.group,
          tags: Array.isArray(req.body?.tags) ? req.body.tags : [],
          os: typeof req.body?.os === 'string' ? req.body.os : undefined,
          arch: typeof req.body?.arch === 'string' ? req.body.arch : undefined,
        },
        req.auth!.user.id
      )
      audit.record({
        userId: req.auth!.user.id,
        actor: req.auth!.user.email,
        action: 'fleet.register',
        resourceType: 'server',
        resourceId: server.id,
        outcome: 'success',
        ip: ipOf(req),
        correlationId: req.requestId || '',
        detail: `${server.name} (${server.host}:${server.port})`,
      })
      res.status(201).json({
        ...server,
        ...(agentToken ? { agentToken } : {}),
      })
    } catch (err) {
      const e = err as Error & { status?: number }
      res.status(e.status || 400).json({ error: e.message || 'Invalid server parameters' })
    }
  })

  router.post('/fleet/servers/:id/probe', requirePermission('servers.update', audit), async (req: AuthedRequest, res: Response) => {
    try {
      const allowPrivate = typeof req.body?.allowPrivate === 'boolean' ? req.body.allowPrivate : undefined
      const result = await fleetService.probeServer(String(req.params.id), allowPrivate)
      audit.record({
        userId: req.auth!.user.id,
        actor: req.auth!.user.email,
        action: 'fleet.probe',
        resourceType: 'server',
        resourceId: result.server.id,
        outcome: result.reachable ? 'success' : 'error',
        ip: ipOf(req),
        correlationId: req.requestId || '',
        detail: result.error || `${result.server.host}:${result.server.port}`,
      })
      res.json(result)
    } catch (err) {
      const e = err as Error & { status?: number }
      res.status(e.status || 400).json({ error: e.message || 'Probe failed' })
    }
  })

  router.get('/fleet/servers/:id/history', requirePermission('servers.read', audit), (req: AuthedRequest, res: Response) => {
    try {
      const limit = Number(req.query.limit) || 50
      res.json(fleetService.getServerHistory(String(req.params.id), limit))
    } catch (err) {
      const e = err as Error & { status?: number }
      res.status(e.status || 404).json({ error: e.message || 'Server not found' })
    }
  })

  router.post('/fleet/servers/:id/agent-token', requirePermission('servers.update', audit), (req: AuthedRequest, res: Response) => {
    try {
      const rotated = fleetService.rotateAgentToken(String(req.params.id))
      audit.record({
        userId: req.auth!.user.id,
        actor: req.auth!.user.email,
        action: 'fleet.agent_token_rotate',
        resourceType: 'server',
        resourceId: String(req.params.id),
        outcome: 'success',
        ip: ipOf(req),
        correlationId: req.requestId || '',
        metadata: { agentId: rotated.agentId },
      })
      res.json(rotated)
    } catch (err) {
      const e = err as Error & { status?: number }
      res.status(e.status || 400).json({ error: e.message || 'Failed to rotate agent token' })
    }
  })

  router.delete('/fleet/servers/:id', requirePermission('servers.delete', audit), (req: AuthedRequest, res: Response) => {
    try {
      const removed = fleetService.deleteServer(String(req.params.id))
      audit.record({
        userId: req.auth!.user.id,
        actor: req.auth!.user.email,
        action: 'fleet.remove',
        resourceType: 'server',
        resourceId: removed.id,
        outcome: 'success',
        ip: ipOf(req),
        correlationId: req.requestId || '',
        detail: `${removed.name} (${removed.host})`,
      })
      res.json({ status: 'deleted' })
    } catch (err) {
      const e = err as Error & { status?: number }
      res.status(e.status || 400).json({ error: e.message || 'Failed to delete server' })
    }
  })

  // Agent-plane authenticated heartbeat endpoint
  router.post('/fleet/agent/heartbeat', (req: AuthedRequest, res: Response) => {
    const authHeader = String(req.headers.authorization || '')
    const rawToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
    const agentId = String(req.headers['x-kathal-agent-id'] || req.body?.agentId || '').trim()
    if (!agentId || !rawToken) {
      res.status(401).json({ error: 'agentId and Bearer agent token are required' })
      return
    }
    try {
      const updated = fleetService.recordAgentHeartbeat(agentId, rawToken, {
        agentVersion: typeof req.body?.agentVersion === 'string' ? req.body.agentVersion : undefined,
        os: typeof req.body?.os === 'string' ? req.body.os : undefined,
        arch: typeof req.body?.arch === 'string' ? req.body.arch : undefined,
        cpuPercent: req.body?.cpuPercent !== undefined ? Number(req.body.cpuPercent) : undefined,
        memoryPercent: req.body?.memoryPercent !== undefined ? Number(req.body.memoryPercent) : undefined,
        diskPercent: req.body?.diskPercent !== undefined ? Number(req.body.diskPercent) : undefined,
      })
      res.json({ status: 'acknowledged', server: updated })
    } catch (err) {
      const e = err as Error & { status?: number }
      audit.record({
        actor: agentId,
        action: 'fleet.agent_heartbeat',
        resourceType: 'server',
        resourceId: agentId,
        outcome: 'denied',
        ip: ipOf(req),
        correlationId: req.requestId || '',
      })
      res.status(e.status || 401).json({ error: e.message || 'Invalid agent credentials' })
    }
  })

  return router
}
