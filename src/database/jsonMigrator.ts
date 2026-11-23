import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { getDataDir } from '../platform.ts'
import type { DatabaseManager } from './sqlite.ts'
import type { VaultManager } from '../security/vault.ts'
import type { AuditEvent, FleetServerRecord, PersistedAuthState } from '../persistence.ts'
import type {
  BackupRecord,
  ComposeProject,
  EnvVar,
  GitDeployLog,
  GitRepo,
  ManagedDatabase,
  NetworkRecord,
  PlatformSettings,
  RegistryCredential,
  VolumeRecord,
} from '../store.ts'

export interface JsonMigrationSummary {
  executed: boolean
  alreadyCompleted: boolean
  backupPath: string | null
  importedCounts: {
    authUsers: number
    settings: number
    databases: number
    secrets: number
    registries: number
    gitRepos: number
    gitLogs: number
    composeProjects: number
    networks: number
    volumes: number
    backups: number
    servers: number
    auditEvents: number
  }
  verified: boolean
  retainedOriginalFiles: string[]
}

const MIGRATION_KEY = 'legacy_json_v1'

export async function migrateLegacyJsonToSqlite(
  dbManager: DatabaseManager,
  vault: VaultManager,
  customDataDir?: string
): Promise<JsonMigrationSummary> {
  const db = dbManager.getConnection()
  const dataDir = path.resolve(customDataDir || getDataDir())

  const existingRun = db
    .prepare('SELECT source_name, status, records_imported, details_json FROM migration_runs WHERE source_name = ?')
    .get(MIGRATION_KEY) as { status: string; records_imported: number; details_json: string } | undefined

  if (existingRun && existingRun.status === 'completed') {
    let prevCounts: JsonMigrationSummary['importedCounts'] = {
      authUsers: 0,
      settings: 0,
      databases: 0,
      secrets: 0,
      registries: 0,
      gitRepos: 0,
      gitLogs: 0,
      composeProjects: 0,
      networks: 0,
      volumes: 0,
      backups: 0,
      servers: 0,
      auditEvents: 0,
    }
    try {
      prevCounts = JSON.parse(existingRun.details_json) as JsonMigrationSummary['importedCounts']
    } catch {
      // ignore parse errors
    }
    return {
      executed: false,
      alreadyCompleted: true,
      backupPath: null,
      importedCounts: prevCounts,
      verified: true,
      retainedOriginalFiles: [],
    }
  }

  const authFile = path.join(dataDir, 'auth-state.json')
  const platformFile = path.join(dataDir, 'platform-state.json')
  const auditFile = path.join(dataDir, 'audit-log.json')
  const proxyFile = path.join(dataDir, 'reverse-proxy.json')

  const presentFiles = [authFile, platformFile, auditFile, proxyFile].filter((f) => fs.existsSync(f))
  if (presentFiles.length === 0) {
    const emptyCounts = {
      authUsers: 0,
      settings: 0,
      databases: 0,
      secrets: 0,
      registries: 0,
      gitRepos: 0,
      gitLogs: 0,
      composeProjects: 0,
      networks: 0,
      volumes: 0,
      backups: 0,
      servers: 0,
      auditEvents: 0,
    }
    db.prepare(
      `INSERT OR IGNORE INTO migration_runs (id, source_name, status, records_imported, details_json, completed_at)
       VALUES (?, ?, 'completed', 0, ?, ?)`
    ).run(`mig-${crypto.randomBytes(4).toString('hex')}`, MIGRATION_KEY, JSON.stringify(emptyCounts), new Date().toISOString())
    return {
      executed: true,
      alreadyCompleted: false,
      backupPath: null,
      importedCounts: emptyCounts,
      verified: true,
      retainedOriginalFiles: [],
    }
  }

  // Validate JSON files before touching SQLite
  let authData: PersistedAuthState | null = null
  if (fs.existsSync(authFile)) {
    const parsed = JSON.parse(fs.readFileSync(authFile, 'utf8')) as Partial<PersistedAuthState>
    if (
      typeof parsed.email === 'string' &&
      parsed.email.includes('@') &&
      typeof parsed.passwordHash === 'string' &&
      parsed.passwordHash.length > 10
    ) {
      authData = {
        email: parsed.email.toLowerCase(),
        passwordHash: parsed.passwordHash,
        updatedAt: parsed.updatedAt || new Date().toISOString(),
      }
    }
  }

  let platformData: {
    settings?: Partial<PlatformSettings>
    databases?: ManagedDatabase[]
    envVars?: EnvVar[]
    registries?: RegistryCredential[]
    gitRepos?: GitRepo[]
    gitHistory?: Record<string, GitDeployLog[]>
    composeProjects?: ComposeProject[]
    networks?: NetworkRecord[]
    volumes?: VolumeRecord[]
    backups?: BackupRecord[]
    fleetServers?: FleetServerRecord[]
  } = {}

  if (fs.existsSync(platformFile)) {
    const raw = JSON.parse(fs.readFileSync(platformFile, 'utf8'))
    if (raw && typeof raw === 'object') {
      platformData = raw
    }
  }

  let auditEntries: AuditEvent[] = []
  if (fs.existsSync(auditFile)) {
    const rawAudit = JSON.parse(fs.readFileSync(auditFile, 'utf8'))
    if (Array.isArray(rawAudit)) {
      auditEntries = rawAudit
    }
  }

  // Backup existing SQLite DB before importing
  const backupPath = path.join(dataDir, 'backups', `pre-json-migration-${Date.now()}.db`)
  await dbManager.backupTo(backupPath)

  const counts = {
    authUsers: 0,
    settings: 0,
    databases: 0,
    secrets: 0,
    registries: 0,
    gitRepos: 0,
    gitLogs: 0,
    composeProjects: 0,
    networks: 0,
    volumes: 0,
    backups: 0,
    servers: 0,
    auditEvents: 0,
  }

  const now = new Date().toISOString()

  dbManager.transaction(() => {
    // 1. Auth user (Owner)
    if (authData) {
      const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(authData.email) as { id: string } | undefined
      const userId = existing?.id || 'usr-owner-primary'
      if (!existing) {
        db.prepare(
          `INSERT INTO users (id, email, display_name, password_hash, is_active, failed_attempts, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, 0, ?, ?)`
        ).run(userId, authData.email, 'Primary Owner', authData.passwordHash, authData.updatedAt, authData.updatedAt)
        db.prepare(
          `INSERT OR IGNORE INTO user_roles (user_id, role_id, assigned_by, assigned_at)
           VALUES (?, 'role-owner', ?, ?)`
        ).run(userId, userId, authData.updatedAt)
        counts.authUsers++
      }
    }

    // 2. Settings
    if (platformData.settings) {
      const s = platformData.settings
      const whEnc = s.webhookSecret
        ? s.webhookSecret.startsWith('enc:')
          ? s.webhookSecret
          : vault.encryptSecret(s.webhookSecret)
        : ''
      const res = db
        .prepare(
          `INSERT OR IGNORE INTO system_settings (
            id, server_name, server_domain, wildcard_domain, lets_encrypt_email,
            auto_ssl, force_https, auto_deploy_webhook, prune_stopped_after_deploy,
            default_deploy_strategy, webhook_secret_enc, cpu_alert_threshold, memory_alert_threshold, updated_at
          ) VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          s.serverName || 'KATHAL Primary Node',
          s.serverDomain || 'kathal.local',
          s.wildcardDomain || 'apps.kathal.local',
          s.letsEncryptEmail || 'admin@kathal.local',
          s.autoSsl === false ? 0 : 1,
          s.forceHttps === false ? 0 : 1,
          s.autoDeployWebhook === false ? 0 : 1,
          s.pruneStoppedAfterDeploy ? 1 : 0,
          s.defaultDeployStrategy || 'rolling',
          whEnc,
          Number(s.cpuAlertThreshold ?? 85),
          Number(s.memoryAlertThreshold ?? 85),
          now
        )
      counts.settings += Number(res.changes || 0)
    }

    // 3. Databases
    for (const d of platformData.databases || []) {
      const pwEnc = d.password
        ? d.password.startsWith('enc:')
          ? d.password
          : vault.encryptSecret(d.password)
        : ''
      const res = db
        .prepare(
          `INSERT OR IGNORE INTO databases (id, name, type, port, username, password_enc, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(d.id, d.name, d.type, d.port, d.user, pwEnc, d.status || 'running', now, now)
      counts.databases += Number(res.changes || 0)
    }

    // 4. Env Vars / Secrets
    for (const env of platformData.envVars || []) {
      const valEnc = env.secret
        ? env.value.startsWith('enc:')
          ? env.value
          : vault.encryptSecret(env.value)
        : env.value
      const res = db
        .prepare(
          `INSERT OR IGNORE INTO secrets (id, scope, key_name, value_enc, description, is_secret, key_version, created_at, updated_at)
           VALUES (?, 'global', ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          `sec-${crypto.createHash('sha256').update(env.key).digest('hex').slice(0, 12)}`,
          env.key,
          valEnc,
          env.description || '',
          env.secret ? 1 : 0,
          vault.getActiveKid(),
          now,
          now
        )
      counts.secrets += Number(res.changes || 0)
    }

    // 5. Registries
    for (const r of platformData.registries || []) {
      const pwEnc = r.password
        ? r.password.startsWith('enc:')
          ? r.password
          : vault.encryptSecret(r.password)
        : ''
      const res = db
        .prepare(
          `INSERT OR IGNORE INTO registries (id, name, registry_url, username, password_enc, email, status, created_at, last_used_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          r.id,
          r.name,
          r.registryUrl,
          r.username,
          pwEnc,
          r.email || '',
          r.status || 'connected',
          r.createdAt || now,
          r.lastUsedAt || null
        )
      counts.registries += Number(res.changes || 0)
    }

    // 6. Git Repos & History
    for (const g of platformData.gitRepos || []) {
      const res = db
        .prepare(
          `INSERT OR IGNORE INTO git_repos (id, name, url, branch, deploy_cmd, domain, port, container_id, status, last_deploy, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          g.id,
          g.name,
          g.url,
          g.branch || 'main',
          g.deploy_cmd || '',
          g.domain || null,
          g.port ?? null,
          g.container_id || null,
          g.status || 'idle',
          g.last_deploy || null,
          now
        )
      counts.gitRepos += Number(res.changes || 0)
    }
    if (platformData.gitHistory && typeof platformData.gitHistory === 'object') {
      for (const [repoId, logs] of Object.entries(platformData.gitHistory)) {
        for (const entry of logs || []) {
          const logId = `glog-${crypto
            .createHash('sha256')
            .update(`${repoId}:${entry.timestamp}:${entry.commit || ''}`)
            .digest('hex')
            .slice(0, 12)}`
          const res = db
            .prepare(
              `INSERT OR IGNORE INTO git_deploy_logs (id, repo_id, timestamp, commit_sha, output, error)
               VALUES (?, ?, ?, ?, ?, ?)`
            )
            .run(logId, repoId, entry.timestamp || now, entry.commit || null, entry.output || null, entry.error || null)
          counts.gitLogs += Number(res.changes || 0)
        }
      }
    }

    // 7. Compose, Networks, Volumes, Backups
    for (const c of platformData.composeProjects || []) {
      const res = db
        .prepare(
          `INSERT OR IGNORE INTO compose_projects (name, working_dir, file_path, status, services_json, config, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          c.name,
          c.workingDir,
          c.filePath || null,
          c.status || 'created',
          JSON.stringify(c.services || []),
          c.config || '',
          c.updatedAt || now
        )
      counts.composeProjects += Number(res.changes || 0)
    }

    for (const n of platformData.networks || []) {
      const res = db
        .prepare(
          `INSERT OR IGNORE INTO networks (id, name, driver, scope, internal, attachable, ingress, containers_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          n.id,
          n.name,
          n.driver,
          n.scope,
          n.internal ? 1 : 0,
          n.attachable ? 1 : 0,
          n.ingress ? 1 : 0,
          JSON.stringify(n.containers || [])
        )
      counts.networks += Number(res.changes || 0)
    }

    for (const v of platformData.volumes || []) {
      const res = db
        .prepare(
          `INSERT OR IGNORE INTO volumes (name, driver, mountpoint, scope, size_bytes, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(v.name, v.driver, v.mountpoint, v.scope, v.sizeBytes || 0, v.createdAt || now)
      counts.volumes += Number(res.changes || 0)
    }

    for (const b of platformData.backups || []) {
      const res = db
        .prepare(
          `INSERT OR IGNORE INTO backups (id, name, size_label, kind, created_at)
           VALUES (?, ?, ?, 'snapshot', ?)`
        )
        .run(b.id, b.name, b.size || '0 KB', b.created_at || now)
      counts.backups += Number(res.changes || 0)
    }

    // 8. Fleet Servers
    for (const srv of platformData.fleetServers || []) {
      const groupName = srv.group || 'default'
      db.prepare(
        `INSERT OR IGNORE INTO server_groups (id, name, description, created_at)
         VALUES (?, ?, '', ?)`
      ).run(`grp-${groupName.replace(/[^a-z0-9_-]/gi, '') || 'default'}`, groupName, now)
      const res = db
        .prepare(
          `INSERT OR IGNORE INTO servers (
            id, name, host, port, auth_method, role, group_name, tags_json,
            status, is_local, os, arch, agent_version, last_checked_at, latency_ms, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          srv.id,
          srv.name,
          srv.host,
          srv.port,
          srv.authMethod,
          srv.role,
          groupName,
          JSON.stringify(srv.tags || []),
          srv.status,
          srv.isLocal ? 1 : 0,
          srv.os,
          srv.arch,
          srv.agentVersion,
          srv.lastCheckedAt,
          srv.latencyMs,
          srv.createdAt || now,
          now
        )
      counts.servers += Number(res.changes || 0)
    }

    // 9. Audit Log
    for (const ev of auditEntries) {
      const res = db
        .prepare(
          `INSERT OR IGNORE INTO audit_events (
            id, actor_email, action, resource_type, resource_id, outcome, source_ip, detail, created_at
          ) VALUES (?, ?, ?, 'legacy', ?, ?, ?, ?, ?)`
        )
        .run(
          ev.id,
          ev.actor || 'system',
          ev.action,
          ev.target || '',
          ev.outcome || 'success',
          ev.ip || '127.0.0.1',
          ev.detail || null,
          ev.timestamp || now
        )
      counts.auditEvents += Number(res.changes || 0)
    }

    const totalImported = Object.values(counts).reduce((a, b) => a + b, 0)
    db.prepare(
      `INSERT INTO migration_runs (id, source_name, status, records_imported, details_json, completed_at)
       VALUES (?, ?, 'completed', ?, ?, ?)`
    ).run(
      `mig-${crypto.randomBytes(4).toString('hex')}`,
      MIGRATION_KEY,
      totalImported,
      JSON.stringify(counts),
      now
    )
  })

  // Retain original JSON files intact after migration for safe operator verification/recovery
  return {
    executed: true,
    alreadyCompleted: false,
    backupPath,
    importedCounts: counts,
    verified: dbManager.integrityCheck().ok,
    retainedOriginalFiles: presentFiles,
  }
}
