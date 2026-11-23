import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite'
import { getDataDir } from '../platform.ts'
import { MIGRATIONS, migrationChecksum, type MigrationDef } from './migrations.ts'

export interface AppliedMigrationRow {
  version: number
  name: string
  checksum: string
  applied_at: string
}

export interface DatabaseStatusReport {
  engine: 'sqlite'
  dbPath: string
  sizeBytes: number
  walMode: string
  foreignKeysEnabled: boolean
  integrityOk: boolean
  migrationVersion: number
  appliedMigrations: AppliedMigrationRow[]
  tableCounts: Record<string, number>
}

export class DatabaseManager {
  private db: DatabaseSync | null = null
  private dbPath: string
  private migrations: MigrationDef[]

  constructor(customDbPath?: string, migrations: MigrationDef[] = MIGRATIONS) {
    this.dbPath = customDbPath || path.resolve(getDataDir(), 'kathal.db')
    this.migrations = migrations
  }

  getDbPath(): string {
    return this.dbPath
  }

  getConnection(): DatabaseSync {
    if (!this.db) {
      this.initialize()
    }
    return this.db!
  }

  initialize(): DatabaseSync {
    if (this.db) return this.db
    const dir = path.dirname(this.dbPath)
    fs.mkdirSync(dir, { recursive: true })

    const db = new DatabaseSync(this.dbPath)
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec('PRAGMA synchronous = NORMAL;')
    db.exec('PRAGMA foreign_keys = ON;')
    db.exec('PRAGMA busy_timeout = 5000;')
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `)

    this.db = db
    this.runMigrations()
    return db
  }

  runMigrations(): AppliedMigrationRow[] {
    const db = this.db
    if (!db) throw new Error('Database connection not initialized')

    const appliedRows = db
      .prepare('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version ASC')
      .all() as unknown as AppliedMigrationRow[]
    const appliedVersions = new Set(appliedRows.map((r) => r.version))

    const newlyApplied: AppliedMigrationRow[] = []
    for (const mig of [...this.migrations].sort((a, b) => a.version - b.version)) {
      if (appliedVersions.has(mig.version)) continue
      const sum = migrationChecksum(mig)
      const now = new Date().toISOString()
      this.transaction(() => {
        mig.up(db)
        db.prepare(
          'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)'
        ).run(mig.version, mig.name, sum, now)
      })
      newlyApplied.push({ version: mig.version, name: mig.name, checksum: sum, applied_at: now })
    }
    return newlyApplied
  }

  rollbackLastMigration(): AppliedMigrationRow | null {
    const db = this.getConnection()
    const latest = db
      .prepare('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version DESC LIMIT 1')
      .get() as AppliedMigrationRow | undefined
    if (!latest) return null

    const def = this.migrations.find((m) => m.version === latest.version)
    if (!def) {
      throw new Error(`Migration definition not found for version ${latest.version}`)
    }

    // Temporarily disable FK checks during full schema teardown if rolling back base migration
    const fkReset = latest.version === 1
    if (fkReset) db.exec('PRAGMA foreign_keys = OFF;')
    try {
      this.transaction(() => {
        def.down(db)
        db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(latest.version)
      })
    } finally {
      if (fkReset) db.exec('PRAGMA foreign_keys = ON;')
    }
    return latest
  }

  transaction<T>(fn: () => T): T {
    const db = this.getConnection()
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      db.exec('COMMIT')
      return result
    } catch (err) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // ignore double rollback error
      }
      throw err
    }
  }

  integrityCheck(): { ok: boolean; messages: string[] } {
    const db = this.getConnection()
    const rows = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>
    const messages = rows.map((r) => String(r.integrity_check))
    const ok = messages.length === 1 && messages[0].toLowerCase() === 'ok'
    return { ok, messages }
  }

  async backupTo(destinationPath: string): Promise<string> {
    const db = this.getConnection()
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true })
    await sqliteBackup(db, destinationPath)
    return destinationPath
  }

  getStatus(): DatabaseStatusReport {
    const db = this.getConnection()
    const fkRow = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number } | undefined
    const walRow = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string } | undefined
    const integrity = this.integrityCheck()
    const appliedMigrations = db
      .prepare('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version ASC')
      .all() as unknown as AppliedMigrationRow[]

    const tablesToCount = [
      'users',
      'roles',
      'permissions',
      'sessions',
      'servers',
      'applications',
      'deployments',
      'databases',
      'domains',
      'secrets',
      'backups',
      'audit_events',
      'vault_keys',
    ]
    const tableCounts: Record<string, number> = {}
    for (const tbl of tablesToCount) {
      try {
        const row = db.prepare(`SELECT COUNT(*) as cnt FROM ${tbl}`).get() as { cnt: number }
        tableCounts[tbl] = row.cnt
      } catch {
        tableCounts[tbl] = 0
      }
    }

    let sizeBytes = 0
    try {
      sizeBytes = fs.statSync(this.dbPath).size
    } catch {
      sizeBytes = 0
    }

    return {
      engine: 'sqlite',
      dbPath: this.dbPath,
      sizeBytes,
      walMode: walRow?.journal_mode || 'unknown',
      foreignKeysEnabled: Boolean(fkRow?.foreign_keys),
      integrityOk: integrity.ok,
      migrationVersion: appliedMigrations.length
        ? appliedMigrations[appliedMigrations.length - 1].version
        : 0,
      appliedMigrations,
      tableCounts,
    }
  }

  close(): void {
    if (this.db) {
      try {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
      } catch {
        // ignore if already closed or read-only
      }
      this.db.close()
      this.db = null
    }
  }
}
