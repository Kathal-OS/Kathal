import crypto from 'node:crypto'
import net from 'node:net'
import type { DatabaseSync } from 'node:sqlite'
import type { AuditService } from '../audit/auditService.ts'
import type { DockerAdapter } from '../adapters/containers/dockerAdapter.ts'
import type { HealthCheckConfig, HealthState } from '../types/phase2.ts'

export interface HealthCheckStatus {
  id: string
  applicationId: string
  config: HealthCheckConfig
  currentState: HealthState
  consecutiveFailures: number
  consecutiveSuccesses: number
  restartCount: number
  restartWindowStartedAt: string | null
  lastCheckedAt: string | null
  lastError: string | null
  updatedAt: string
}

export interface HealthHistoryItem {
  id: string
  applicationId: string
  state: HealthState
  latencyMs: number | null
  statusCode: number | null
  detail: string | null
  checkedAt: string
}

export type AppRestartCallback = (applicationId: string) => Promise<void>

export class HealthCheckService {
  private db: DatabaseSync
  private dockerAdapter: DockerAdapter
  private audit: AuditService
  private onAutoRestart?: AppRestartCallback
  private timer: NodeJS.Timeout | null = null

  constructor(
    db: DatabaseSync,
    dockerAdapter: DockerAdapter,
    audit: AuditService,
    onAutoRestart?: AppRestartCallback
  ) {
    this.db = db
    this.dockerAdapter = dockerAdapter
    this.audit = audit
    this.onAutoRestart = onAutoRestart
  }

  setRestartHandler(cb: AppRestartCallback): void {
    this.onAutoRestart = cb
  }

  start(intervalMs = 15_000): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.runDueChecks()
    }, intervalMs)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  upsertConfig(applicationId: string, partial: Partial<HealthCheckConfig>): HealthCheckStatus {
    const existing = this.getStatus(applicationId)
    const now = new Date().toISOString()
    const merged: HealthCheckConfig = {
      enabled: partial.enabled ?? existing?.config.enabled ?? true,
      type: partial.type ?? existing?.config.type ?? 'http',
      path: partial.path ?? existing?.config.path ?? '/',
      port: partial.port ?? existing?.config.port,
      intervalSeconds: Math.max(5, Math.min(3600, partial.intervalSeconds ?? existing?.config.intervalSeconds ?? 30)),
      timeoutSeconds: Math.max(1, Math.min(60, partial.timeoutSeconds ?? existing?.config.timeoutSeconds ?? 5)),
      failureThreshold: Math.max(1, Math.min(20, partial.failureThreshold ?? existing?.config.failureThreshold ?? 3)),
      recoveryThreshold: Math.max(1, Math.min(20, partial.recoveryThreshold ?? existing?.config.recoveryThreshold ?? 2)),
      autoRestart: partial.autoRestart ?? existing?.config.autoRestart ?? true,
      maxRestarts: Math.max(0, Math.min(20, partial.maxRestarts ?? existing?.config.maxRestarts ?? 3)),
      restartWindowSeconds: Math.max(30, Math.min(86400, partial.restartWindowSeconds ?? existing?.config.restartWindowSeconds ?? 300)),
    }

    const id = existing?.id || `hc-${crypto.randomBytes(6).toString('hex')}`
    this.db
      .prepare(
        `INSERT INTO health_checks (
          id, application_id, enabled, check_type, path, port, interval_seconds, timeout_seconds,
          failure_threshold, recovery_threshold, auto_restart, max_restarts, restart_window_seconds,
          current_state, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(application_id) DO UPDATE SET
          enabled = excluded.enabled,
          check_type = excluded.check_type,
          path = excluded.path,
          port = excluded.port,
          interval_seconds = excluded.interval_seconds,
          timeout_seconds = excluded.timeout_seconds,
          failure_threshold = excluded.failure_threshold,
          recovery_threshold = excluded.recovery_threshold,
          auto_restart = excluded.auto_restart,
          max_restarts = excluded.max_restarts,
          restart_window_seconds = excluded.restart_window_seconds,
          updated_at = excluded.updated_at`
      )
      .run(
        id,
        applicationId,
        merged.enabled ? 1 : 0,
        merged.type,
        merged.path,
        merged.port ?? null,
        merged.intervalSeconds,
        merged.timeoutSeconds,
        merged.failureThreshold,
        merged.recoveryThreshold,
        merged.autoRestart ? 1 : 0,
        merged.maxRestarts,
        merged.restartWindowSeconds,
        existing?.currentState || 'unknown',
        now
      )

    return this.getStatus(applicationId)!
  }

  getStatus(applicationId: string): HealthCheckStatus | null {
    const row = this.db
      .prepare('SELECT * FROM health_checks WHERE application_id = ?')
      .get(applicationId) as Record<string, unknown> | undefined
    return row ? this.mapRow(row) : null
  }

  getHistory(applicationId: string, limit = 50): HealthHistoryItem[] {
    const rows = this.db
      .prepare(
        `SELECT id, application_id, state, latency_ms, status_code, detail, checked_at
         FROM health_check_results
         WHERE application_id = ?
         ORDER BY checked_at DESC
         LIMIT ?`
      )
      .all(applicationId, Math.min(200, Math.max(1, limit))) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      id: String(r.id),
      applicationId: String(r.application_id),
      state: String(r.state) as HealthState,
      latencyMs: r.latency_ms !== null ? Number(r.latency_ms) : null,
      statusCode: r.status_code !== null ? Number(r.status_code) : null,
      detail: r.detail ? String(r.detail) : null,
      checkedAt: String(r.checked_at),
    }))
  }

  async runDueChecks(): Promise<void> {
    const rows = this.db
      .prepare(
        `SELECT hc.*, a.port as app_port, a.status as app_status
         FROM health_checks hc
         JOIN applications a ON a.id = hc.application_id
         WHERE hc.enabled = 1 AND a.archived_at IS NULL`
      )
      .all() as Array<Record<string, unknown>>

    const nowMs = Date.now()
    for (const row of rows) {
      const last = row.last_checked_at ? Date.parse(String(row.last_checked_at)) : 0
      const intervalMs = Number(row.interval_seconds || 30) * 1000
      if (last && nowMs - last < intervalMs) continue
      await this.evaluateApplication(String(row.application_id))
    }
  }

  async evaluateApplication(applicationId: string): Promise<{ status: HealthCheckStatus; probeOk: boolean; autoRestartTriggered: boolean }> {
    const appRow = this.db
      .prepare('SELECT id, name, port, status FROM applications WHERE id = ?')
      .get(applicationId) as { id: string; name: string; port: number; status: string } | undefined
    if (!appRow) throw new Error('Application not found')

    let status = this.getStatus(applicationId)
    if (!status) {
      status = this.upsertConfig(applicationId, {})
    }

    const now = new Date().toISOString()
    if (appRow.status === 'stopped') {
      this.db
        .prepare(
          `UPDATE health_checks SET current_state = 'stopped', last_checked_at = ?, updated_at = ? WHERE id = ?`
        )
        .run(now, now, status.id)
      this.recordHistory(status.id, applicationId, 'stopped', null, null, 'Application is stopped', now)
      return { status: this.getStatus(applicationId)!, probeOk: false, autoRestartTriggered: false }
    }

    const targetPort = status.config.port || appRow.port
    const probe = await this.performProbe(status.config, targetPort, appRow.name)
    let nextFailures = probe.ok ? 0 : status.consecutiveFailures + 1
    let nextSuccesses = probe.ok ? status.consecutiveSuccesses + 1 : 0
    let nextState: HealthState = status.currentState

    if (probe.ok) {
      if (nextSuccesses >= status.config.recoveryThreshold || status.currentState === 'unknown' || status.currentState === 'starting') {
        nextState = 'healthy'
      } else if (status.currentState === 'unhealthy' || status.currentState === 'degraded') {
        nextState = 'degraded'
      }
    } else {
      if (nextFailures >= status.config.failureThreshold) {
        nextState = 'unhealthy'
      } else {
        nextState = 'degraded'
      }
    }

    let restartCount = status.restartCount
    let windowStart = status.restartWindowStartedAt
    const nowMs = Date.now()
    const windowMs = status.config.restartWindowSeconds * 1000
    if (windowStart && nowMs - Date.parse(windowStart) > windowMs) {
      restartCount = 0
      windowStart = null
    }

    let autoRestartTriggered = false
    if (nextState === 'unhealthy' && status.config.autoRestart && this.onAutoRestart) {
      if (restartCount < status.config.maxRestarts) {
        if (!windowStart) windowStart = now
        restartCount += 1
        autoRestartTriggered = true
        this.audit.record({
          actor: 'system:healthcheck',
          action: 'app.auto_restart',
          resourceType: 'application',
          resourceId: applicationId,
          outcome: 'success',
          detail: `Attempt ${restartCount}/${status.config.maxRestarts} after ${nextFailures} failed probes`,
        })
        try {
          await this.onAutoRestart(applicationId)
          nextState = 'starting'
          nextFailures = 0
        } catch (err) {
          this.audit.record({
            actor: 'system:healthcheck',
            action: 'app.auto_restart',
            resourceType: 'application',
            resourceId: applicationId,
            outcome: 'error',
            detail: (err as Error).message,
          })
        }
      } else {
        this.audit.record({
          actor: 'system:healthcheck',
          action: 'app.auto_restart_exhausted',
          resourceType: 'application',
          resourceId: applicationId,
          outcome: 'denied',
          detail: `Bounded restart limit (${status.config.maxRestarts}) reached within ${status.config.restartWindowSeconds}s`,
        })
      }
    }

    this.db
      .prepare(
        `UPDATE health_checks
         SET current_state = ?, consecutive_failures = ?, consecutive_successes = ?,
             restart_count = ?, restart_window_started_at = ?, last_checked_at = ?, last_error = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        nextState,
        nextFailures,
        nextSuccesses,
        restartCount,
        windowStart,
        now,
        probe.ok ? null : probe.detail,
        now,
        status.id
      )

    this.recordHistory(status.id, applicationId, nextState, probe.latencyMs, probe.statusCode, probe.detail, now)
    return { status: this.getStatus(applicationId)!, probeOk: probe.ok, autoRestartTriggered }
  }

  private async performProbe(
    config: HealthCheckConfig,
    port: number,
    appName: string
  ): Promise<{ ok: boolean; latencyMs: number; statusCode: number | null; detail: string }> {
    const start = Date.now()
    const timeoutMs = config.timeoutSeconds * 1000

    if (config.type === 'docker') {
      try {
        const inspect = await this.dockerAdapter.inspectContainerHealth(`kathal-${appName}`)
        return {
          ok: inspect.running && inspect.healthStatus !== 'unhealthy',
          latencyMs: Date.now() - start,
          statusCode: null,
          detail: `Docker running=${inspect.running} health=${inspect.healthStatus}`,
        }
      } catch (err) {
        return {
          ok: false,
          latencyMs: Date.now() - start,
          statusCode: null,
          detail: (err as Error).message || 'Docker health inspect failed',
        }
      }
    }

    if (config.type === 'tcp') {
      const ok = await new Promise<boolean>((resolve) => {
        const sock = net.createConnection({ host: '127.0.0.1', port })
        let settled = false
        const finish = (res: boolean) => {
          if (settled) return
          settled = true
          sock.destroy()
          resolve(res)
        }
        sock.setTimeout(timeoutMs)
        sock.once('connect', () => finish(true))
        sock.once('timeout', () => finish(false))
        sock.once('error', () => finish(false))
      })
      return {
        ok,
        latencyMs: Date.now() - start,
        statusCode: null,
        detail: ok ? `TCP :${port} connected` : `TCP :${port} unreachable`,
      }
    }

    const urlPath = config.path.startsWith('/') ? config.path : `/${config.path}`
    try {
      const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
        signal: AbortSignal.timeout(timeoutMs),
      })
      const ok = res.status >= 200 && res.status < 500
      return {
        ok,
        latencyMs: Date.now() - start,
        statusCode: res.status,
        detail: `HTTP ${res.status} on 127.0.0.1:${port}${urlPath}`,
      }
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        statusCode: null,
        detail: (err as Error).message || `HTTP probe failed on :${port}${urlPath}`,
      }
    }
  }

  private recordHistory(
    healthCheckId: string,
    applicationId: string,
    state: HealthState,
    latencyMs: number | null,
    statusCode: number | null,
    detail: string | null,
    checkedAt: string
  ): void {
    this.db
      .prepare(
        `INSERT INTO health_check_results (id, health_check_id, application_id, state, latency_ms, status_code, detail, checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(`hcr-${crypto.randomBytes(6).toString('hex')}`, healthCheckId, applicationId, state, latencyMs, statusCode, detail, checkedAt)
  }

  private mapRow(row: Record<string, unknown>): HealthCheckStatus {
    return {
      id: String(row.id),
      applicationId: String(row.application_id),
      config: {
        enabled: Boolean(row.enabled),
        type: String(row.check_type || 'http') as HealthCheckConfig['type'],
        path: String(row.path || '/'),
        port: row.port !== null ? Number(row.port) : undefined,
        intervalSeconds: Number(row.interval_seconds || 30),
        timeoutSeconds: Number(row.timeout_seconds || 5),
        failureThreshold: Number(row.failure_threshold || 3),
        recoveryThreshold: Number(row.recovery_threshold || 2),
        autoRestart: Boolean(row.auto_restart),
        maxRestarts: Number(row.max_restarts ?? 3),
        restartWindowSeconds: Number(row.restart_window_seconds || 300),
      },
      currentState: String(row.current_state || 'unknown') as HealthState,
      consecutiveFailures: Number(row.consecutive_failures || 0),
      consecutiveSuccesses: Number(row.consecutive_successes || 0),
      restartCount: Number(row.restart_count || 0),
      restartWindowStartedAt: row.restart_window_started_at ? String(row.restart_window_started_at) : null,
      lastCheckedAt: row.last_checked_at ? String(row.last_checked_at) : null,
      lastError: row.last_error ? String(row.last_error) : null,
      updatedAt: String(row.updated_at),
    }
  }
}
