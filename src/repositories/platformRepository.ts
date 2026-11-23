import crypto from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { VaultManager } from '../security/vault.ts'
import type {
  BackupRecord,
  ComposeProject,
  EnvVar,
  GitDeployLog,
  GitRepo,
  ManagedDatabase,
  MemoryStore,
  NetworkRecord,
  PlatformSettings,
  RegistryCredential,
  VolumeRecord,
} from '../store.ts'

export class PlatformRepository {
  private db: DatabaseSync
  private vault: VaultManager

  constructor(db: DatabaseSync, vault: VaultManager) {
    this.db = db
    this.vault = vault
  }

  private safeDecrypt(val: string): string {
    if (!val) return ''
    try {
      return this.vault.decryptSecret(val)
    } catch {
      return ''
    }
  }

  /**
   * Hydrate MemoryStore from SQLite tables so existing runtimes, BackupManager,
   * and reverse proxy stay synchronized across restarts.
   */
  loadIntoStore(store: MemoryStore): void {
    const settingsRow = this.db
      .prepare('SELECT * FROM system_settings WHERE id = ?')
      .get('default') as
      | {
          server_name: string
          server_domain: string
          wildcard_domain: string
          lets_encrypt_email: string
          auto_ssl: number
          force_https: number
          auto_deploy_webhook: number
          prune_stopped_after_deploy: number
          default_deploy_strategy: 'rolling' | 'recreate'
          webhook_secret_enc: string
          cpu_alert_threshold: number
          memory_alert_threshold: number
        }
      | undefined

    if (settingsRow) {
      store.settings = {
        serverName: settingsRow.server_name,
        serverDomain: settingsRow.server_domain,
        wildcardDomain: settingsRow.wildcard_domain,
        letsEncryptEmail: settingsRow.lets_encrypt_email,
        autoSsl: Boolean(settingsRow.auto_ssl),
        forceHttps: Boolean(settingsRow.force_https),
        autoDeployWebhook: Boolean(settingsRow.auto_deploy_webhook),
        pruneStoppedAfterDeploy: Boolean(settingsRow.prune_stopped_after_deploy),
        defaultDeployStrategy: settingsRow.default_deploy_strategy || 'rolling',
        webhookSecret:
          this.safeDecrypt(settingsRow.webhook_secret_enc) || store.settings.webhookSecret,
        cpuAlertThreshold: settingsRow.cpu_alert_threshold,
        memoryAlertThreshold: settingsRow.memory_alert_threshold,
      }
    } else {
      this.saveSettings(store.settings)
    }

    const dbRows = this.db.prepare('SELECT * FROM databases ORDER BY created_at DESC').all() as Array<{
      id: string
      name: string
      type: 'postgres' | 'mysql' | 'mongodb' | 'redis'
      port: number
      username: string
      password_enc: string
      status: 'running' | 'stopped'
    }>
    store.databases = dbRows.map((d) => ({
      id: d.id,
      name: d.name,
      type: d.type,
      port: d.port,
      user: d.username,
      password: this.safeDecrypt(d.password_enc),
      status: d.status,
    }))

    const secretRows = this.db
      .prepare("SELECT key_name, value_enc, description, is_secret FROM secrets WHERE scope = 'global' ORDER BY key_name ASC")
      .all() as Array<{ key_name: string; value_enc: string; description: string; is_secret: number }>

    if (secretRows.length > 0) {
      store.envVars = secretRows.map((s) => ({
        key: s.key_name,
        value: s.is_secret ? this.safeDecrypt(s.value_enc) : s.value_enc,
        description: s.description || '',
        secret: Boolean(s.is_secret),
      }))
    } else {
      for (const env of store.envVars) {
        this.upsertSecret(env)
      }
    }

    const regRows = this.db.prepare('SELECT * FROM registries ORDER BY created_at DESC').all() as Array<{
      id: string
      name: string
      registry_url: string
      username: string
      password_enc: string
      email: string
      status: 'connected' | 'unverified'
      created_at: string
      last_used_at: string | null
    }>
    store.registries = regRows.map((r) => ({
      id: r.id,
      name: r.name,
      registryUrl: r.registry_url,
      username: r.username,
      password: this.safeDecrypt(r.password_enc),
      email: r.email || '',
      status: r.status,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at || undefined,
    }))

    const gitRows = this.db.prepare('SELECT * FROM git_repos ORDER BY created_at DESC').all() as Array<{
      id: string
      name: string
      url: string
      branch: string
      deploy_cmd: string
      domain: string | null
      port: number | null
      container_id: string | null
      status: 'idle' | 'success' | 'failed'
      last_deploy: string | null
    }>
    store.gitRepos = gitRows.map((g) => ({
      id: g.id,
      name: g.name,
      url: g.url,
      branch: g.branch,
      deploy_cmd: g.deploy_cmd,
      domain: g.domain || undefined,
      port: g.port ?? undefined,
      container_id: g.container_id || undefined,
      status: g.status,
      last_deploy: g.last_deploy || undefined,
    }))

    store.gitHistory.clear()
    const gitLogs = this.db.prepare('SELECT * FROM git_deploy_logs ORDER BY timestamp ASC').all() as Array<{
      repo_id: string
      timestamp: string
      commit_sha: string | null
      output: string | null
      error: string | null
    }>
    for (const row of gitLogs) {
      const list = store.gitHistory.get(row.repo_id) || []
      list.push({
        timestamp: row.timestamp,
        commit: row.commit_sha || undefined,
        output: row.output || undefined,
        error: row.error || undefined,
      })
      store.gitHistory.set(row.repo_id, list)
    }

    const compRows = this.db.prepare('SELECT * FROM compose_projects ORDER BY updated_at DESC').all() as Array<{
      name: string
      working_dir: string
      file_path: string | null
      status: 'running' | 'stopped' | 'created'
      services_json: string
      config: string
      updated_at: string
    }>
    store.composeProjects = compRows.map((c) => ({
      name: c.name,
      workingDir: c.working_dir,
      filePath: c.file_path || undefined,
      status: c.status,
      services: JSON.parse(c.services_json || '[]') as string[],
      config: c.config,
      updatedAt: c.updated_at,
    }))

    const netRows = this.db.prepare('SELECT * FROM networks').all() as Array<{
      id: string
      name: string
      driver: string
      scope: string
      internal: number
      attachable: number
      ingress: number
      containers_json: string
    }>
    if (netRows.length > 0) {
      store.networks = netRows.map((n) => ({
        id: n.id,
        name: n.name,
        driver: n.driver,
        scope: n.scope,
        internal: Boolean(n.internal),
        attachable: Boolean(n.attachable),
        ingress: Boolean(n.ingress),
        containers: JSON.parse(n.containers_json || '[]') as string[],
      }))
    } else {
      for (const n of store.networks) {
        this.saveNetwork(n)
      }
    }

    const volRows = this.db.prepare('SELECT * FROM volumes ORDER BY created_at DESC').all() as Array<{
      name: string
      driver: string
      mountpoint: string
      scope: string
      size_bytes: number
      created_at: string
    }>
    store.volumes = volRows.map((v) => ({
      name: v.name,
      driver: v.driver,
      mountpoint: v.mountpoint,
      scope: v.scope,
      sizeBytes: v.size_bytes,
      createdAt: v.created_at,
    }))

    const bkpRows = this.db.prepare('SELECT * FROM backups ORDER BY created_at DESC').all() as Array<{
      id: string
      name: string
      size_label: string
      created_at: string
    }>
    for (const b of bkpRows) {
      if (!store.backups.some((x) => x.id === b.id)) {
        store.backups.push({
          id: b.id,
          name: b.name,
          size: b.size_label,
          created_at: b.created_at,
        })
      }
    }
  }

  saveSettings(s: PlatformSettings): void {
    const now = new Date().toISOString()
    const webhookEnc = s.webhookSecret ? this.vault.encryptSecret(s.webhookSecret) : ''
    this.db
      .prepare(
        `INSERT INTO system_settings (
          id, server_name, server_domain, wildcard_domain, lets_encrypt_email,
          auto_ssl, force_https, auto_deploy_webhook, prune_stopped_after_deploy,
          default_deploy_strategy, webhook_secret_enc, cpu_alert_threshold, memory_alert_threshold, updated_at
        ) VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          server_name = excluded.server_name,
          server_domain = excluded.server_domain,
          wildcard_domain = excluded.wildcard_domain,
          lets_encrypt_email = excluded.lets_encrypt_email,
          auto_ssl = excluded.auto_ssl,
          force_https = excluded.force_https,
          auto_deploy_webhook = excluded.auto_deploy_webhook,
          prune_stopped_after_deploy = excluded.prune_stopped_after_deploy,
          default_deploy_strategy = excluded.default_deploy_strategy,
          webhook_secret_enc = excluded.webhook_secret_enc,
          cpu_alert_threshold = excluded.cpu_alert_threshold,
          memory_alert_threshold = excluded.memory_alert_threshold,
          updated_at = excluded.updated_at`
      )
      .run(
        s.serverName,
        s.serverDomain,
        s.wildcardDomain,
        s.letsEncryptEmail,
        s.autoSsl ? 1 : 0,
        s.forceHttps ? 1 : 0,
        s.autoDeployWebhook ? 1 : 0,
        s.pruneStoppedAfterDeploy ? 1 : 0,
        s.defaultDeployStrategy,
        webhookEnc,
        s.cpuAlertThreshold,
        s.memoryAlertThreshold,
        now
      )
  }

  upsertSecret(env: EnvVar, actorUserId?: string): void {
    const now = new Date().toISOString()
    const valEnc = env.secret ? this.vault.encryptSecret(env.value) : env.value
    const id = `sec-${crypto.createHash('sha256').update(env.key).digest('hex').slice(0, 12)}`
    this.db
      .prepare(
        `INSERT INTO secrets (id, scope, key_name, value_enc, description, is_secret, key_version, created_by, created_at, updated_at)
         VALUES (?, 'global', ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope, key_name) DO UPDATE SET
           value_enc = excluded.value_enc,
           description = excluded.description,
           is_secret = excluded.is_secret,
           key_version = excluded.key_version,
           updated_at = excluded.updated_at`
      )
      .run(
        id,
        env.key,
        valEnc,
        env.description || '',
        env.secret ? 1 : 0,
        this.vault.getActiveKid(),
        actorUserId || null,
        now,
        now
      )
  }

  rotateSecretValue(keyName: string, newValue: string): boolean {
    const now = new Date().toISOString()
    const existing = this.db
      .prepare("SELECT id, is_secret FROM secrets WHERE scope = 'global' AND key_name = ?")
      .get(keyName) as { id: string; is_secret: number } | undefined
    if (!existing) return false
    const stored = existing.is_secret ? this.vault.encryptSecret(newValue) : newValue
    this.db
      .prepare('UPDATE secrets SET value_enc = ?, key_version = ?, rotated_at = ?, updated_at = ? WHERE id = ?')
      .run(stored, this.vault.getActiveKid(), now, now, existing.id)
    return true
  }

  saveNetwork(n: NetworkRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO networks (id, name, driver, scope, internal, attachable, ingress, containers_json)
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
  }

  /**
   * Synchronize full MemoryStore operational tables atomically into SQLite.
   * Keeps backward compatibility while backing every mutation with ACID SQLite persistence.
   */
  syncFromStore(store: MemoryStore): void {
    const now = new Date().toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.saveSettings(store.settings)

      // Databases
      this.db.exec('DELETE FROM databases')
      const insDb = this.db.prepare(
        `INSERT INTO databases (id, name, type, port, username, password_enc, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      for (const d of store.databases) {
        insDb.run(
          d.id,
          d.name,
          d.type,
          d.port,
          d.user,
          d.password ? this.vault.encryptSecret(d.password) : '',
          d.status,
          now,
          now
        )
      }

      // Global Env / Secrets
      this.db.exec("DELETE FROM secrets WHERE scope = 'global'")
      for (const env of store.envVars) {
        this.upsertSecret(env)
      }

      // Registries
      this.db.exec('DELETE FROM registries')
      const insReg = this.db.prepare(
        `INSERT INTO registries (id, name, registry_url, username, password_enc, email, status, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      for (const r of store.registries) {
        insReg.run(
          r.id,
          r.name,
          r.registryUrl,
          r.username,
          r.password ? this.vault.encryptSecret(r.password) : '',
          r.email || '',
          r.status,
          r.createdAt || now,
          r.lastUsedAt || null
        )
      }

      // Git Repos & Logs
      this.db.exec('DELETE FROM git_repos')
      const insGit = this.db.prepare(
        `INSERT INTO git_repos (id, name, url, branch, deploy_cmd, domain, port, container_id, status, last_deploy, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      const insLog = this.db.prepare(
        `INSERT OR IGNORE INTO git_deploy_logs (id, repo_id, timestamp, commit_sha, output, error)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      for (const g of store.gitRepos) {
        insGit.run(
          g.id,
          g.name,
          g.url,
          g.branch,
          g.deploy_cmd,
          g.domain || null,
          g.port ?? null,
          g.container_id || null,
          g.status,
          g.last_deploy || null,
          now
        )
        const logs = store.gitHistory.get(g.id) || []
        for (let idx = 0; idx < logs.length; idx++) {
          const entry = logs[idx]
          const logId = `glog-${crypto
            .createHash('sha256')
            .update(`${g.id}:${idx}:${entry.timestamp}`)
            .digest('hex')
            .slice(0, 12)}`
          insLog.run(logId, g.id, entry.timestamp, entry.commit || null, entry.output || null, entry.error || null)
        }
      }

      // Compose
      this.db.exec('DELETE FROM compose_projects')
      const insComp = this.db.prepare(
        `INSERT INTO compose_projects (name, working_dir, file_path, status, services_json, config, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      for (const c of store.composeProjects) {
        insComp.run(
          c.name,
          c.workingDir,
          c.filePath || null,
          c.status,
          JSON.stringify(c.services || []),
          c.config,
          c.updatedAt || now
        )
      }

      // Networks & Volumes & Backups
      this.db.exec('DELETE FROM networks')
      for (const n of store.networks) this.saveNetwork(n)

      this.db.exec('DELETE FROM volumes')
      const insVol = this.db.prepare(
        `INSERT INTO volumes (name, driver, mountpoint, scope, size_bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      for (const v of store.volumes) {
        insVol.run(v.name, v.driver, v.mountpoint, v.scope, v.sizeBytes || 0, v.createdAt || now)
      }

      this.db.exec('DELETE FROM backups')
      const insBkp = this.db.prepare(
        `INSERT INTO backups (id, name, size_label, kind, created_at)
         VALUES (?, ?, ?, 'snapshot', ?)`
      )
      for (const b of store.backups) {
        insBkp.run(b.id, b.name, b.size, b.created_at)
      }

      // Proxy Domains
      this.db.exec('DELETE FROM domains')
      const insDom = this.db.prepare(
        `INSERT OR IGNORE INTO domains (id, domain, target, port, ssl, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      for (const p of store.proxyRoutes) {
        insDom.run(p.id, p.domain, p.target, p.port, p.ssl ? 1 : 0, p.enabled ? 1 : 0, now, now)
      }

      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }
}
