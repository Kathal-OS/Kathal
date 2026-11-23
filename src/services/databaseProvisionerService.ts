import crypto from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { VaultManager } from '../security/vault.ts'
import type { DatabaseRuntimeDriver } from '../adapters/databases/databaseAdapter.ts'
import type {
  DatabaseEngineType,
  DatabaseRuntimeStatus,
  DatabaseVerificationReport,
  ManagedDatabaseInstance,
} from '../types/phase2.ts'
import { isValidPort, isValidSlugOrAppName } from '../validation/validators.ts'

const ENGINE_DEFAULTS: Record<DatabaseEngineType, { port: number; user: string; version: string }> = {
  postgres: { port: 5432, user: 'kathal_pg', version: '16' },
  mysql: { port: 3306, user: 'kathal_mysql', version: '8.4' },
  mariadb: { port: 3306, user: 'kathal_maria', version: '11.4' },
  redis: { port: 6379, user: 'default', version: '7' },
  mongodb: { port: 27017, user: 'kathal_mongo', version: '7' },
}

export class DatabaseProvisionerService {
  private db: DatabaseSync
  private vault: VaultManager
  private driver: DatabaseRuntimeDriver

  constructor(db: DatabaseSync, vault: VaultManager, driver: DatabaseRuntimeDriver) {
    this.db = db
    this.vault = vault
    this.driver = driver
  }

  async getCapabilities() {
    return this.driver.detectCapabilities()
  }

  private allocatePort(engine: DatabaseEngineType, requested?: number): number {
    if (requested !== undefined) {
      if (!isValidPort(requested) || requested < 1024) {
        throw new Error('Port must be between 1024 and 65535')
      }
      const conflict = this.db
        .prepare('SELECT id FROM database_instances WHERE port = ?')
        .get(requested) as { id: string } | undefined
      if (conflict) throw new Error(`Port ${requested} is already allocated to another database instance`)
      return requested
    }
    const base = ENGINE_DEFAULTS[engine].port
    const used = new Set(
      (this.db.prepare('SELECT port FROM database_instances').all() as Array<{ port: number }>).map((r) => r.port)
    )
    let p = base + 100
    while (used.has(p) && p < 65000) p += 1
    return p
  }

  listInstances(): ManagedDatabaseInstance[] {
    const rows = this.db
      .prepare('SELECT * FROM database_instances ORDER BY created_at DESC')
      .all() as Array<Record<string, unknown>>
    return rows.map((r) => this.mapRow(r))
  }

  getInstance(id: string): ManagedDatabaseInstance | null {
    const row = this.db.prepare('SELECT * FROM database_instances WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? this.mapRow(row) : null
  }

  async provisionInstance(input: {
    name: string
    engine: DatabaseEngineType
    version?: string
    port?: number
    username?: string
    password?: string
    databaseName?: string
    internalOnly?: boolean
    ownerUserId?: string | null
    serverId?: string | null
  }): Promise<ManagedDatabaseInstance> {
    const name = input.name.trim().toLowerCase()
    if (!isValidSlugOrAppName(name)) {
      throw new Error('Database instance name must match ^[a-z0-9][a-z0-9-_]{1,62}$')
    }
    const engine = input.engine
    if (!ENGINE_DEFAULTS[engine]) {
      throw new Error(`Unsupported database engine "${engine}"`)
    }
    const existing = this.db.prepare('SELECT id FROM database_instances WHERE name = ?').get(name)
    if (existing) {
      throw new Error(`Database instance "${name}" already exists`)
    }

    const def = ENGINE_DEFAULTS[engine]
    const id = `dbi-${crypto.randomBytes(6).toString('hex')}`
    const version = (input.version || def.version).trim()
    const internalOnly = input.internalOnly !== undefined ? Boolean(input.internalOnly) : true
    const host = internalOnly ? '127.0.0.1' : '0.0.0.0'
    const port = this.allocatePort(engine, input.port)
    const username = (input.username || def.user).trim().replace(/[^a-zA-Z0-9_]/g, '_')
    const databaseName = (input.databaseName || name).trim().replace(/[^a-zA-Z0-9_]/g, '_')
    const rawPassword = input.password && input.password.trim()
      ? input.password.trim()
      : crypto.randomBytes(18).toString('base64url')
    const passwordEnc = this.vault.encryptSecret(rawPassword)
    const now = new Date().toISOString()

    this.db
      .prepare(
        `INSERT INTO database_instances (
          id, name, engine, version, host, port, username, password_enc, database_name,
          runtime_mode, internal_only, status, verification_json, owner_user_id, server_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unavailable', ?, 'provisioning', '{}', ?, ?, ?, ?)`
      )
      .run(
        id,
        name,
        engine,
        version,
        host,
        port,
        username,
        passwordEnc,
        databaseName,
        internalOnly ? 1 : 0,
        input.ownerUserId || null,
        input.serverId || null,
        now,
        now
      )

    let status: DatabaseRuntimeStatus = 'unavailable'
    let runtimeMode: ManagedDatabaseInstance['runtimeMode'] = 'unavailable'
    let containerOrPid: string | null = null
    let lastError: string | null = null
    let verification: DatabaseVerificationReport

    try {
      const res = await this.driver.provision({
        id,
        name,
        engine,
        version,
        host: '127.0.0.1',
        port,
        username,
        password: rawPassword,
        databaseName,
        internalOnly,
      })
      runtimeMode = res.runtimeMode
      containerOrPid = res.containerOrPid
      verification = res.verification
      lastError = res.error || null
      if (res.runtimeMode === 'unavailable') {
        status = 'unavailable'
      } else if (
        verification.runtimeRunning &&
        verification.runtimeHealthy &&
        verification.tcpReachable &&
        verification.authVerified &&
        verification.databaseVerified
      ) {
        status = 'running'
      } else {
        status = 'error'
        lastError = lastError || verification.detail
      }
    } catch (err) {
      status = 'error'
      lastError = (err as Error).message || 'Provisioning failed'
      verification = {
        runtimeMode: 'unavailable',
        runtimeRunning: false,
        runtimeHealthy: false,
        tcpReachable: false,
        authVerified: false,
        databaseVerified: false,
        verifiedAt: new Date().toISOString(),
        detail: lastError,
      }
    }

    this.db
      .prepare(
        `UPDATE database_instances
         SET runtime_mode = ?, container_or_pid = ?, status = ?, verification_json = ?, last_error = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        runtimeMode,
        containerOrPid,
        status,
        JSON.stringify(verification),
        lastError,
        new Date().toISOString(),
        id
      )

    return this.getInstance(id)!
  }

  async verifyInstance(id: string): Promise<ManagedDatabaseInstance | null> {
    const inst = this.getInstance(id)
    if (!inst) return null
    const row = this.db.prepare('SELECT password_enc FROM database_instances WHERE id = ?').get(id) as {
      password_enc: string
    }
    const password = row.password_enc ? this.vault.decryptSecret(row.password_enc) : ''
    const report = await this.driver.verifyReadiness(
      {
        id: inst.id,
        name: inst.name,
        engine: inst.engine,
        version: inst.version,
        host: '127.0.0.1',
        port: inst.port,
        username: inst.username,
        password,
        databaseName: inst.databaseName,
        internalOnly: inst.internalOnly,
      },
      inst.containerOrPid,
      inst.runtimeMode
    )

    const ready =
      report.runtimeRunning &&
      report.runtimeHealthy &&
      report.tcpReachable &&
      report.authVerified &&
      report.databaseVerified
    const nextStatus: DatabaseRuntimeStatus =
      report.runtimeMode === 'unavailable' ? 'unavailable' : ready ? 'running' : 'error'

    this.db
      .prepare(
        `UPDATE database_instances SET status = ?, verification_json = ?, last_error = ?, updated_at = ? WHERE id = ?`
      )
      .run(nextStatus, JSON.stringify(report), ready ? null : report.detail, new Date().toISOString(), id)
    return this.getInstance(id)
  }

  async startInstance(id: string): Promise<ManagedDatabaseInstance | null> {
    const inst = this.getInstance(id)
    if (!inst) return null
    if (inst.runtimeMode === 'unavailable' || !inst.containerOrPid) {
      throw new Error(inst.lastError || 'Database runtime unavailable on this host')
    }
    await this.driver.start(inst.containerOrPid, inst.runtimeMode)
    return this.verifyInstance(id)
  }

  async stopInstance(id: string): Promise<ManagedDatabaseInstance | null> {
    const inst = this.getInstance(id)
    if (!inst) return null
    if (inst.runtimeMode === 'unavailable' || !inst.containerOrPid) {
      throw new Error(inst.lastError || 'Database runtime unavailable on this host')
    }
    await this.driver.stop(inst.containerOrPid, inst.runtimeMode)
    this.db
      .prepare("UPDATE database_instances SET status = 'stopped', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id)
    return this.getInstance(id)
  }

  rotateCredentials(id: string, newPassword?: string): ManagedDatabaseInstance | null {
    const inst = this.getInstance(id)
    if (!inst) return null
    const nextSecret = newPassword?.trim() || crypto.randomBytes(18).toString('base64url')
    const enc = this.vault.encryptSecret(nextSecret)
    this.db
      .prepare('UPDATE database_instances SET password_enc = ?, updated_at = ? WHERE id = ?')
      .run(enc, new Date().toISOString(), id)
    return this.getInstance(id)
  }

  revealConnectionString(id: string): { connectionString: string; username: string; password: string } | null {
    const row = this.db.prepare('SELECT * FROM database_instances WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    if (!row) return null
    const inst = this.mapRow(row)
    const password = row.password_enc ? this.vault.decryptSecret(String(row.password_enc)) : ''
    const host = inst.internalOnly ? '127.0.0.1' : inst.host
    let connectionString = ''
    if (inst.engine === 'postgres') {
      connectionString = `postgresql://${inst.username}:${encodeURIComponent(password)}@${host}:${inst.port}/${inst.databaseName}`
    } else if (inst.engine === 'mysql' || inst.engine === 'mariadb') {
      connectionString = `mysql://${inst.username}:${encodeURIComponent(password)}@${host}:${inst.port}/${inst.databaseName}`
    } else if (inst.engine === 'mongodb') {
      connectionString = `mongodb://${inst.username}:${encodeURIComponent(password)}@${host}:${inst.port}/${inst.databaseName}`
    } else {
      connectionString = `redis://:${encodeURIComponent(password)}@${host}:${inst.port}`
    }
    return { connectionString, username: inst.username, password }
  }

  async getLogs(id: string): Promise<string> {
    const inst = this.getInstance(id)
    if (!inst) throw new Error('Database instance not found')
    if (!inst.containerOrPid) return inst.lastError || 'No runtime logs available.'
    return this.driver.logs(inst.containerOrPid, inst.runtimeMode)
  }

  async deleteInstance(id: string): Promise<boolean> {
    const inst = this.getInstance(id)
    if (!inst) return false
    if (inst.containerOrPid && inst.runtimeMode !== 'unavailable') {
      try {
        await this.driver.remove(inst.containerOrPid, inst.runtimeMode)
      } catch {
        // continue DB cleanup
      }
    }
    const info = this.db.prepare('DELETE FROM database_instances WHERE id = ?').run(id)
    return info.changes > 0
  }

  private mapRow(row: Record<string, unknown>): ManagedDatabaseInstance {
    let verification: DatabaseVerificationReport | null = null
    try {
      const parsed = JSON.parse(String(row.verification_json || '{}')) as Partial<DatabaseVerificationReport>
      if (parsed && parsed.verifiedAt) {
        verification = parsed as DatabaseVerificationReport
      }
    } catch {
      verification = null
    }

    return {
      id: String(row.id),
      name: String(row.name),
      engine: String(row.engine) as DatabaseEngineType,
      version: String(row.version),
      host: String(row.host),
      port: Number(row.port),
      username: String(row.username),
      databaseName: String(row.database_name),
      runtimeMode: String(row.runtime_mode) as ManagedDatabaseInstance['runtimeMode'],
      containerOrPid: row.container_or_pid ? String(row.container_or_pid) : null,
      internalOnly: Boolean(row.internal_only),
      status: String(row.status) as DatabaseRuntimeStatus,
      hasPassword: Boolean(row.password_enc),
      passwordMasked: row.password_enc ? '••••••••' : '',
      verification,
      lastError: row.last_error ? String(row.last_error) : null,
      ownerUserId: row.owner_user_id ? String(row.owner_user_id) : null,
      serverId: row.server_id ? String(row.server_id) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }
}
