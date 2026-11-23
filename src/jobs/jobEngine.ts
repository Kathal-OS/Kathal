import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { DatabaseSync } from 'node:sqlite'
import type { DeploymentStatus, JobRecord } from '../types/phase2.ts'

export interface JobRunContext {
  job: JobRecord
  signal: AbortSignal
  isCancelled: () => boolean
  setStage: (stage: DeploymentStatus, message?: string) => void
  heartbeatLease: () => void
}

export type JobHandler = (ctx: JobRunContext) => Promise<Record<string, unknown> | void>

const ACTIVE_STATUSES = [
  'queued',
  'validating',
  'preparing',
  'cloning',
  'building',
  'deploying',
  'starting',
  'health_check',
  'cancelling',
  'rolling_back',
]

export class JobEngine extends EventEmitter {
  private db: DatabaseSync
  private handlers = new Map<string, JobHandler>()
  private controllers = new Map<string, AbortController>()
  private running = new Set<string>()
  private pollTimer: NodeJS.Timeout | null = null
  private workerId: string
  private maxConcurrency: number
  private leaseMs: number

  constructor(
    db: DatabaseSync,
    options: { workerId?: string; maxConcurrency?: number; leaseMs?: number } = {}
  ) {
    super()
    this.db = db
    this.workerId = options.workerId || `ctrl-${process.pid}-${crypto.randomBytes(3).toString('hex')}`
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? 3)
    this.leaseMs = Math.max(5_000, options.leaseMs ?? 120_000)
  }

  registerHandler(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler)
  }

  /**
   * Startup reconciliation: any active/in-flight job left behind by a prior
   * process crash or restart MUST NOT be falsely marked succeeded. Mark failed cleanly.
   */
  reconcileStaleJobsOnStartup(): { reconciledCount: number; jobIds: string[] } {
    const now = new Date().toISOString()
    const placeholders = ACTIVE_STATUSES.map(() => '?').join(',')
    const stale = this.db
      .prepare(`SELECT id, status, target_type, target_id FROM background_jobs WHERE status IN (${placeholders})`)
      .all(...ACTIVE_STATUSES) as Array<{ id: string; status: string; target_type: string; target_id: string }>

    if (stale.length === 0) return { reconciledCount: 0, jobIds: [] }

    const reason = 'Interrupted by control-plane restart before completion'
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const updJob = this.db.prepare(
        `UPDATE background_jobs
         SET status = 'failed', error_message = ?, lease_owner = NULL, lease_expires_at = NULL, finished_at = ?, updated_at = ?
         WHERE id = ?`
      )
      const updAttempts = this.db.prepare(
        `UPDATE job_attempts
         SET status = 'failed', error_message = ?, finished_at = ?
         WHERE job_id = ? AND finished_at IS NULL`
      )
      const updDeploy = this.db.prepare(
        `UPDATE deployments
         SET status = 'failed', stage = 'failed', error_detail = ?, finished_at = ?
         WHERE job_id = ? AND finished_at IS NULL`
      )

      for (const row of stale) {
        updJob.run(reason, now, now, row.id)
        updAttempts.run(reason, now, row.id)
        updDeploy.run(reason, now, row.id)
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }

    for (const row of stale) {
      this.emit('job:updated', this.getJob(row.id))
    }
    return { reconciledCount: stale.length, jobIds: stale.map((s) => s.id) }
  }

  start(intervalMs = 500): void {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => {
      void this.tick()
    }, intervalMs)
    this.pollTimer.unref()
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    for (const ctrl of this.controllers.values()) {
      ctrl.abort(new Error('JobEngine shutting down'))
    }
  }

  enqueue(input: {
    type: string
    targetType: string
    targetId: string
    payload?: Record<string, unknown>
    dedupeKey?: string | null
    maxAttempts?: number
    createdBy?: string | null
  }): { job: JobRecord; deduplicated: boolean } {
    const dedupeKey = input.dedupeKey?.trim() || null
    if (dedupeKey) {
      const placeholders = ACTIVE_STATUSES.map(() => '?').join(',')
      const existing = this.db
        .prepare(`SELECT * FROM background_jobs WHERE dedupe_key = ? AND status IN (${placeholders}) ORDER BY created_at DESC LIMIT 1`)
        .get(dedupeKey, ...ACTIVE_STATUSES) as Record<string, unknown> | undefined
      if (existing) {
        return { job: this.mapRow(existing), deduplicated: true }
      }
    }

    const id = `job-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO background_jobs (
          id, type, target_type, target_id, dedupe_key, status, payload_json,
          attempt, max_attempts, cancel_requested, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'queued', ?, 0, ?, 0, ?, ?, ?)`
      )
      .run(
        id,
        input.type,
        input.targetType,
        input.targetId,
        dedupeKey,
        JSON.stringify(input.payload || {}),
        Math.max(1, input.maxAttempts ?? 1),
        input.createdBy || null,
        now,
        now
      )

    const job = this.getJob(id)!
    this.emit('job:created', job)
    // Trigger immediate asynchronous dispatch if handler is already attached
    queueMicrotask(() => {
      void this.tick()
    })
    return { job, deduplicated: false }
  }

  getJob(id: string): JobRecord | null {
    const row = this.db.prepare('SELECT * FROM background_jobs WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? this.mapRow(row) : null
  }

  listJobs(filter: { status?: string; targetType?: string; targetId?: string; limit?: number } = {}): JobRecord[] {
    const clauses: string[] = []
    const params: Array<string | number> = []
    if (filter.status) {
      clauses.push('status = ?')
      params.push(filter.status)
    }
    if (filter.targetType) {
      clauses.push('target_type = ?')
      params.push(filter.targetType)
    }
    if (filter.targetId) {
      clauses.push('target_id = ?')
      params.push(filter.targetId)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = Math.min(200, Math.max(1, filter.limit ?? 50))
    const rows = this.db
      .prepare(`SELECT * FROM background_jobs ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, limit) as Array<Record<string, unknown>>
    return rows.map((r) => this.mapRow(r))
  }

  listAttempts(jobId: string): Array<{
    id: string
    jobId: string
    attempt: number
    status: string
    errorMessage: string | null
    startedAt: string
    finishedAt: string | null
  }> {
    const rows = this.db
      .prepare('SELECT * FROM job_attempts WHERE job_id = ? ORDER BY attempt ASC')
      .all(jobId) as Array<{
      id: string
      job_id: string
      attempt: number
      status: string
      error_message: string | null
      started_at: string
      finished_at: string | null
    }>
    return rows.map((r) => ({
      id: r.id,
      jobId: r.job_id,
      attempt: r.attempt,
      status: r.status,
      errorMessage: r.error_message,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
    }))
  }

  requestCancel(id: string): JobRecord | null {
    const existing = this.getJob(id)
    if (!existing) return null
    if (existing.status === 'succeeded' || existing.status === 'failed' || existing.status === 'cancelled') {
      return existing
    }
    const now = new Date().toISOString()
    if (existing.status === 'queued') {
      this.db
        .prepare(
          `UPDATE background_jobs
           SET status = 'cancelled', cancel_requested = 1, error_message = 'Cancelled before execution', finished_at = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(now, now, id)
    } else {
      this.db
        .prepare(`UPDATE background_jobs SET cancel_requested = 1, status = 'cancelling', updated_at = ? WHERE id = ?`)
        .run(now, id)
      const ctrl = this.controllers.get(id)
      if (ctrl) ctrl.abort(new Error('Cancelled by user'))
    }
    const updated = this.getJob(id)
    if (updated) this.emit('job:updated', updated)
    return updated
  }

  retryJob(id: string): JobRecord | null {
    const existing = this.getJob(id)
    if (!existing) return null
    if (existing.status !== 'failed' && existing.status !== 'cancelled') {
      throw new Error(`Cannot retry job in "${existing.status}" state`)
    }
    const now = new Date().toISOString()
    this.db
      .prepare(
        `UPDATE background_jobs
         SET status = 'queued', cancel_requested = 0, error_message = NULL,
             lease_owner = NULL, lease_expires_at = NULL, finished_at = NULL, updated_at = ?
         WHERE id = ?`
      )
      .run(now, id)
    const updated = this.getJob(id)
    if (updated) this.emit('job:updated', updated)
    queueMicrotask(() => {
      void this.tick()
    })
    return updated
  }

  async tick(): Promise<void> {
    while (this.running.size < this.maxConcurrency) {
      const claimed = this.claimNextJob()
      if (!claimed) break
      void this.executeClaimedJob(claimed)
    }
  }

  private claimNextJob(): JobRecord | null {
    const now = new Date().toISOString()
    const leaseExpires = new Date(Date.now() + this.leaseMs).toISOString()

    this.db.exec('BEGIN IMMEDIATE')
    try {
      const candidate = this.db
        .prepare(
          `SELECT * FROM background_jobs
           WHERE status = 'queued' AND cancel_requested = 0
           ORDER BY created_at ASC
           LIMIT 1`
        )
        .get() as Record<string, unknown> | undefined

      if (!candidate) {
        this.db.exec('COMMIT')
        return null
      }

      const nextAttempt = Number(candidate.attempt || 0) + 1
      this.db
        .prepare(
          `UPDATE background_jobs
           SET status = 'validating', attempt = ?, lease_owner = ?, lease_expires_at = ?,
               started_at = COALESCE(started_at, ?), updated_at = ?
           WHERE id = ? AND status = 'queued'`
        )
        .run(nextAttempt, this.workerId, leaseExpires, now, now, String(candidate.id))

      const attemptId = `jatt-${crypto.randomBytes(5).toString('hex')}`
      this.db
        .prepare(
          `INSERT INTO job_attempts (id, job_id, attempt, status, started_at)
           VALUES (?, ?, ?, 'running', ?)`
        )
        .run(attemptId, String(candidate.id), nextAttempt, now)

      this.db.exec('COMMIT')
      const fresh = this.getJob(String(candidate.id))!
      this.running.add(fresh.id)
      this.emit('job:updated', fresh)
      return fresh
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // ignore rollback failure
      }
      throw err
    }
  }

  private async executeClaimedJob(job: JobRecord): Promise<void> {
    const handler = this.handlers.get(job.type)
    const ctrl = new AbortController()
    this.controllers.set(job.id, ctrl)

    const setStage = (stage: DeploymentStatus, message?: string) => {
      const now = new Date().toISOString()
      this.db
        .prepare('UPDATE background_jobs SET status = ?, updated_at = ? WHERE id = ?')
        .run(stage, now, job.id)
      const latest = this.getJob(job.id)
      if (latest) {
        this.emit('job:updated', latest, message)
      }
    }

    const heartbeatLease = () => {
      const now = new Date().toISOString()
      const leaseExpires = new Date(Date.now() + this.leaseMs).toISOString()
      this.db
        .prepare('UPDATE background_jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ?')
        .run(leaseExpires, now, job.id)
    }

    const isCancelled = () => {
      if (ctrl.signal.aborted) return true
      const row = this.db
        .prepare('SELECT cancel_requested FROM background_jobs WHERE id = ?')
        .get(job.id) as { cancel_requested: number } | undefined
      return Boolean(row?.cancel_requested)
    }

    try {
      if (!handler) {
        throw new Error(`No job handler registered for job type "${job.type}"`)
      }
      const result = await handler({
        job,
        signal: ctrl.signal,
        isCancelled,
        setStage,
        heartbeatLease,
      })

      const finishedAt = new Date().toISOString()
      if (isCancelled()) {
        this.finalizeJob(job.id, job.attempt, 'cancelled', null, 'Cancelled during execution', finishedAt)
      } else {
        this.finalizeJob(job.id, job.attempt, 'succeeded', result || {}, null, finishedAt)
      }
    } catch (err) {
      const msg = (err as Error)?.message || 'Job execution failed'
      const finishedAt = new Date().toISOString()
      if (isCancelled() || ctrl.signal.aborted) {
        this.finalizeJob(job.id, job.attempt, 'cancelled', null, msg || 'Cancelled', finishedAt)
      } else if (job.attempt < job.maxAttempts) {
        // Re-queue for bounded retry
        this.db.exec('BEGIN IMMEDIATE')
        try {
          this.db
            .prepare(
              `UPDATE background_jobs
               SET status = 'queued', error_message = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
               WHERE id = ?`
            )
            .run(msg, finishedAt, job.id)
          this.db
            .prepare(
              `UPDATE job_attempts SET status = 'failed', error_message = ?, finished_at = ? WHERE job_id = ? AND attempt = ?`
            )
            .run(msg, finishedAt, job.id, job.attempt)
          this.db.exec('COMMIT')
        } catch {
          this.db.exec('ROLLBACK')
        }
        const requeued = this.getJob(job.id)
        if (requeued) this.emit('job:updated', requeued)
      } else {
        this.finalizeJob(job.id, job.attempt, 'failed', null, msg, finishedAt)
      }
    } finally {
      this.controllers.delete(job.id)
      this.running.delete(job.id)
    }
  }

  private finalizeJob(
    jobId: string,
    attempt: number,
    status: 'succeeded' | 'failed' | 'cancelled',
    result: Record<string, unknown> | null,
    errorMessage: string | null,
    finishedAt: string
  ): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare(
          `UPDATE background_jobs
           SET status = ?, result_json = ?, error_message = ?, lease_owner = NULL,
               lease_expires_at = NULL, finished_at = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          status,
          result ? JSON.stringify(result) : null,
          errorMessage,
          finishedAt,
          finishedAt,
          jobId
        )
      this.db
        .prepare(
          `UPDATE job_attempts SET status = ?, error_message = ?, finished_at = ? WHERE job_id = ? AND attempt = ?`
        )
        .run(status, errorMessage, finishedAt, jobId, attempt)
      this.db.exec('COMMIT')
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // ignore
      }
      throw err
    }
    const updated = this.getJob(jobId)
    if (updated) this.emit('job:updated', updated)
  }

  private mapRow(row: Record<string, unknown>): JobRecord {
    return {
      id: String(row.id),
      type: String(row.type),
      targetType: String(row.target_type),
      targetId: String(row.target_id),
      dedupeKey: row.dedupe_key ? String(row.dedupe_key) : null,
      status: String(row.status) as DeploymentStatus,
      payload: JSON.parse(String(row.payload_json || '{}')) as Record<string, unknown>,
      result: row.result_json ? (JSON.parse(String(row.result_json)) as Record<string, unknown>) : null,
      errorMessage: row.error_message ? String(row.error_message) : null,
      attempt: Number(row.attempt || 0),
      maxAttempts: Number(row.max_attempts || 1),
      leaseOwner: row.lease_owner ? String(row.lease_owner) : null,
      leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : null,
      cancelRequested: Boolean(row.cancel_requested),
      createdBy: row.created_by ? String(row.created_by) : null,
      createdAt: String(row.created_at),
      startedAt: row.started_at ? String(row.started_at) : null,
      finishedAt: row.finished_at ? String(row.finished_at) : null,
      updatedAt: String(row.updated_at),
    }
  }
}
