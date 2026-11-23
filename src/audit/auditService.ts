import crypto from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export interface AuditEventRecord {
  id: string
  userId: string | null
  actor: string
  action: string
  resourceType: string
  resourceId: string
  target: string
  outcome: 'success' | 'denied' | 'error'
  ip: string
  correlationId: string
  detail: string | null
  metadata: Record<string, unknown>
  timestamp: string
}

export interface AuditInput {
  userId?: string | null
  actor?: string
  action: string
  resourceType?: string
  resourceId?: string
  target?: string
  outcome?: 'success' | 'denied' | 'error'
  ip?: string
  correlationId?: string
  detail?: string
  metadata?: Record<string, unknown>
}

export interface AuditQuery {
  page?: number
  pageSize?: number
  limit?: number
  action?: string
  outcome?: string
  resourceType?: string
  userId?: string
  search?: string
  from?: string
  to?: string
}

const SENSITIVE_KEY_RE =
  /password|secret|token|apikey|api_key|privatekey|private_key|authorization|vault|credential|hash|value_enc/i

export function sanitizeAuditMetadata(input: unknown, depth = 0): unknown {
  if (depth > 4) return '[TRUNCATED]'
  if (input === null || input === undefined) return input
  if (typeof input === 'string') {
    if (input.startsWith('enc:v1:') || input.startsWith('enc:v2:') || input.startsWith('$scrypt$') || input.startsWith('$2')) {
      return '[REDACTED]'
    }
    return input.length > 500 ? input.slice(0, 500) + '…' : input
  }
  if (Array.isArray(input)) {
    return input.slice(0, 25).map((item) => sanitizeAuditMetadata(item, depth + 1))
  }
  if (typeof input === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (SENSITIVE_KEY_RE.test(k)) {
        out[k] = '[REDACTED]'
      } else {
        out[k] = sanitizeAuditMetadata(v, depth + 1)
      }
    }
    return out
  }
  return input
}

export class AuditService {
  private db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  record(input: AuditInput): AuditEventRecord {
    const id = `aud-${crypto.randomBytes(6).toString('hex')}`
    const timestamp = new Date().toISOString()
    const resourceType = input.resourceType || inferResourceType(input.action)
    const resourceId = input.resourceId ?? input.target ?? ''
    const sanitizedMeta = (sanitizeAuditMetadata(input.metadata || {}) as Record<string, unknown>) || {}
    const safeDetail = input.detail ? String(sanitizeAuditMetadata(input.detail)) : null

    this.db
      .prepare(
        `INSERT INTO audit_events (
          id, user_id, actor_email, action, resource_type, resource_id,
          outcome, source_ip, correlation_id, detail, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.userId || null,
        input.actor || 'system',
        input.action,
        resourceType,
        resourceId,
        input.outcome || 'success',
        input.ip || '127.0.0.1',
        input.correlationId || '',
        safeDetail,
        JSON.stringify(sanitizedMeta),
        timestamp
      )

    return {
      id,
      userId: input.userId || null,
      actor: input.actor || 'system',
      action: input.action,
      resourceType,
      resourceId,
      target: resourceId,
      outcome: input.outcome || 'success',
      ip: input.ip || '127.0.0.1',
      correlationId: input.correlationId || '',
      detail: safeDetail,
      metadata: sanitizedMeta,
      timestamp,
    }
  }

  query(q: AuditQuery = {}): {
    events: AuditEventRecord[]
    total: number
    page: number
    pageSize: number
    totalPages: number
  } {
    const page = Math.max(1, Number(q.page) || 1)
    const pageSize = Math.min(200, Math.max(1, Number(q.pageSize || q.limit) || 50))
    const offset = (page - 1) * pageSize

    const where: string[] = []
    const params: Array<string | number> = []

    if (q.action && q.action.trim()) {
      where.push('LOWER(action) LIKE ?')
      params.push(`%${q.action.trim().toLowerCase()}%`)
    }
    if (q.outcome && ['success', 'denied', 'error'].includes(q.outcome.trim().toLowerCase())) {
      where.push('outcome = ?')
      params.push(q.outcome.trim().toLowerCase())
    }
    if (q.resourceType && q.resourceType.trim()) {
      where.push('LOWER(resource_type) = ?')
      params.push(q.resourceType.trim().toLowerCase())
    }
    if (q.userId && q.userId.trim()) {
      where.push('user_id = ?')
      params.push(q.userId.trim())
    }
    if (q.from && q.from.trim()) {
      where.push('created_at >= ?')
      params.push(q.from.trim())
    }
    if (q.to && q.to.trim()) {
      where.push('created_at <= ?')
      params.push(q.to.trim())
    }
    if (q.search && q.search.trim()) {
      const term = `%${q.search.trim().toLowerCase()}%`
      where.push(
        '(LOWER(actor_email) LIKE ? OR LOWER(action) LIKE ? OR LOWER(resource_id) LIKE ? OR LOWER(COALESCE(detail, \'\')) LIKE ?)'
      )
      params.push(term, term, term, term)
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM audit_events ${whereClause}`)
      .get(...params) as { cnt: number }

    const rows = this.db
      .prepare(
        `SELECT id, user_id, actor_email, action, resource_type, resource_id, outcome,
                source_ip, correlation_id, detail, metadata_json, created_at
         FROM audit_events
         ${whereClause}
         ORDER BY created_at DESC, rowid DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset) as Array<{
      id: string
      user_id: string | null
      actor_email: string
      action: string
      resource_type: string
      resource_id: string
      outcome: 'success' | 'denied' | 'error'
      source_ip: string
      correlation_id: string
      detail: string | null
      metadata_json: string
      created_at: string
    }>

    const events: AuditEventRecord[] = rows.map((r) => {
      let metadata: Record<string, unknown> = {}
      try {
        metadata = JSON.parse(r.metadata_json || '{}') as Record<string, unknown>
      } catch {
        metadata = {}
      }
      return {
        id: r.id,
        userId: r.user_id,
        actor: r.actor_email,
        action: r.action,
        resourceType: r.resource_type,
        resourceId: r.resource_id,
        target: r.resource_id,
        outcome: r.outcome,
        ip: r.source_ip,
        correlationId: r.correlation_id,
        detail: r.detail,
        metadata,
        timestamp: r.created_at,
      }
    })

    const total = totalRow.cnt
    return {
      events,
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    }
  }
}

function inferResourceType(action: string): string {
  const prefix = action.split('.')[0]
  return prefix || 'system'
}
