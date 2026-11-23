import crypto from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { VaultManager } from '../security/vault.ts'
import type { EnvironmentScopeName, EnvironmentVariableItem } from '../types/phase2.ts'
import { isValidEnvKey } from '../validation/validators.ts'

const VALID_SCOPES = new Set<EnvironmentScopeName>(['development', 'staging', 'production'])

export function normalizeEnvScope(raw?: string): EnvironmentScopeName {
  const s = (raw || 'production').trim().toLowerCase() as EnvironmentScopeName
  if (!VALID_SCOPES.has(s)) {
    throw new Error('Environment must be one of: development, staging, production')
  }
  return s
}

export class EnvironmentService {
  private db: DatabaseSync
  private vault: VaultManager

  constructor(db: DatabaseSync, vault: VaultManager) {
    this.db = db
    this.vault = vault
  }

  listAppVariables(
    applicationId: string,
    environment?: string,
    options: { includeGlobal?: boolean } = {}
  ): EnvironmentVariableItem[] {
    const scopeFilter = environment ? normalizeEnvScope(environment) : null
    const rows = (
      scopeFilter
        ? this.db
            .prepare(
              `SELECT * FROM application_environments
               WHERE application_id = ? AND environment = ?
               ORDER BY key_name ASC`
            )
            .all(applicationId, scopeFilter)
        : this.db
            .prepare(
              `SELECT * FROM application_environments
               WHERE application_id = ?
               ORDER BY environment ASC, key_name ASC`
            )
            .all(applicationId)
    ) as Array<{
      id: string
      application_id: string
      environment: EnvironmentScopeName
      key_name: string
      value_enc: string
      is_secret: number
      description: string
      key_version: string
      created_at: string
      updated_at: string
    }>

    const mapped: EnvironmentVariableItem[] = rows.map((r) => {
      const isSecret = Boolean(r.is_secret)
      return {
        id: r.id,
        applicationId: r.application_id,
        environment: r.environment,
        key: r.key_name,
        value: isSecret ? '' : r.value_enc,
        hasValue: Boolean(r.value_enc),
        isSecret,
        description: r.description || '',
        keyVersion: r.key_version,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }
    })

    if (options.includeGlobal) {
      const globalRows = this.db
        .prepare("SELECT id, key_name, value_enc, description, is_secret, key_version, created_at, updated_at FROM secrets WHERE scope = 'global' ORDER BY key_name ASC")
        .all() as Array<{
        id: string
        key_name: string
        value_enc: string
        description: string
        is_secret: number
        key_version: string
        created_at: string
        updated_at: string
      }>
      for (const g of globalRows) {
        const isSecret = Boolean(g.is_secret)
        mapped.push({
          id: g.id,
          applicationId: null,
          environment: 'global',
          key: g.key_name,
          value: isSecret ? '' : g.value_enc,
          hasValue: Boolean(g.value_enc),
          isSecret,
          description: g.description || '',
          keyVersion: g.key_version,
          createdAt: g.created_at,
          updatedAt: g.updated_at,
        })
      }
    }

    return mapped
  }

  upsertAppVariable(input: {
    applicationId: string
    environment: string
    key: string
    value: string
    isSecret?: boolean
    description?: string
    actorUserId?: string | null
  }): EnvironmentVariableItem {
    const scope = normalizeEnvScope(input.environment)
    const key = input.key.trim()
    const keyCheck = isValidEnvKey(key)
    if (!keyCheck.ok) {
      throw new Error(keyCheck.error || 'Invalid environment key')
    }

    const isSecret = input.isSecret !== undefined ? Boolean(input.isSecret) : true
    const rawVal = String(input.value ?? '')
    const storedVal = isSecret ? this.vault.encryptSecret(rawVal) : rawVal
    const now = new Date().toISOString()
    const id = `env-${crypto.createHash('sha256').update(`${input.applicationId}:${scope}:${key}`).digest('hex').slice(0, 12)}`
    const keyVersion = this.vault.getActiveKid()

    this.db
      .prepare(
        `INSERT INTO application_environments (
          id, application_id, environment, key_name, value_enc, is_secret, description, key_version, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(application_id, environment, key_name) DO UPDATE SET
          value_enc = excluded.value_enc,
          is_secret = excluded.is_secret,
          description = excluded.description,
          key_version = excluded.key_version,
          updated_at = excluded.updated_at`
      )
      .run(
        id,
        input.applicationId,
        scope,
        key,
        storedVal,
        isSecret ? 1 : 0,
        (input.description || '').trim(),
        keyVersion,
        input.actorUserId || null,
        now,
        now
      )

    return {
      id,
      applicationId: input.applicationId,
      environment: scope,
      key,
      value: isSecret ? '' : rawVal,
      hasValue: Boolean(rawVal),
      isSecret,
      description: (input.description || '').trim(),
      keyVersion,
      createdAt: now,
      updatedAt: now,
    }
  }

  revealAppVariable(applicationId: string, environment: string, keyName: string): { key: string; value: string } | null {
    const scope = normalizeEnvScope(environment)
    const row = this.db
      .prepare(
        `SELECT key_name, value_enc, is_secret
         FROM application_environments
         WHERE application_id = ? AND environment = ? AND key_name = ?`
      )
      .get(applicationId, scope, keyName.trim()) as
      | { key_name: string; value_enc: string; is_secret: number }
      | undefined
    if (!row) return null
    const value = row.is_secret ? this.vault.decryptSecret(row.value_enc) : row.value_enc
    return { key: row.key_name, value }
  }

  deleteAppVariable(applicationId: string, environment: string, keyName: string): boolean {
    const scope = normalizeEnvScope(environment)
    const info = this.db
      .prepare('DELETE FROM application_environments WHERE application_id = ? AND environment = ? AND key_name = ?')
      .run(applicationId, scope, keyName.trim())
    return info.changes > 0
  }

  /**
   * Resolves effective decrypted environment map for an application deployment
   * (global defaults overridden by app scope-specific values). Never returned unmasked over HTTP.
   */
  resolveRuntimeEnvMap(applicationId: string, environment: string): Record<string, string> {
    const scope = normalizeEnvScope(environment)
    const out: Record<string, string> = {}

    const globalRows = this.db
      .prepare("SELECT key_name, value_enc, is_secret FROM secrets WHERE scope = 'global'")
      .all() as Array<{ key_name: string; value_enc: string; is_secret: number }>
    for (const g of globalRows) {
      out[g.key_name] = g.is_secret ? this.vault.decryptSecret(g.value_enc) : g.value_enc
    }

    const appRows = this.db
      .prepare(
        `SELECT key_name, value_enc, is_secret
         FROM application_environments
         WHERE application_id = ? AND environment = ?`
      )
      .all(applicationId, scope) as Array<{ key_name: string; value_enc: string; is_secret: number }>
    for (const a of appRows) {
      out[a.key_name] = a.is_secret ? this.vault.decryptSecret(a.value_enc) : a.value_enc
    }

    return out
  }

  exportDotEnv(
    applicationId: string,
    environment: string,
    options: { includeSecrets?: boolean } = {}
  ): string {
    const scope = normalizeEnvScope(environment)
    const rows = this.db
      .prepare(
        `SELECT key_name, value_enc, is_secret
         FROM application_environments
         WHERE application_id = ? AND environment = ?
         ORDER BY key_name ASC`
      )
      .all(applicationId, scope) as Array<{ key_name: string; value_enc: string; is_secret: number }>

    const lines = [`# KATHAL Environment Export (${scope})`]
    for (const r of rows) {
      if (r.is_secret && !options.includeSecrets) {
        lines.push(`# ${r.key_name}=<SECRET_OMITTED>`)
      } else {
        const val = r.is_secret ? this.vault.decryptSecret(r.value_enc) : r.value_enc
        const escaped = val.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
        lines.push(`${r.key_name}="${escaped}"`)
      }
    }
    return lines.join('\n') + '\n'
  }

  importFromContent(input: {
    applicationId: string
    environment: string
    content: string
    markSecrets?: boolean
    actorUserId?: string | null
  }): { imported: number; keys: string[] } {
    const scope = normalizeEnvScope(input.environment)
    const trimmed = input.content.trim()
    const pairs: Array<{ key: string; value: string; secret?: boolean }> = []

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const parsed = JSON.parse(trimmed) as unknown
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item === 'object' && 'key' in item) {
            const rec = item as { key: unknown; value: unknown; isSecret?: unknown; secret?: unknown }
            pairs.push({
              key: String(rec.key),
              value: String(rec.value ?? ''),
              secret: rec.isSecret !== undefined ? Boolean(rec.isSecret) : rec.secret !== undefined ? Boolean(rec.secret) : undefined,
            })
          }
        }
      } else if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          pairs.push({ key: k, value: String(v ?? '') })
        }
      }
    } else {
      for (const rawLine of trimmed.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line || line.startsWith('#')) continue
        const eq = line.indexOf('=')
        if (eq <= 0) continue
        const k = line.slice(0, eq).trim()
        let v = line.slice(eq + 1).trim()
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1)
        }
        pairs.push({ key: k, value: v })
      }
    }

    const keys: string[] = []
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const p of pairs) {
        const item = this.upsertAppVariable({
          applicationId: input.applicationId,
          environment: scope,
          key: p.key,
          value: p.value,
          isSecret: p.secret !== undefined ? p.secret : input.markSecrets ?? true,
          actorUserId: input.actorUserId,
        })
        keys.push(item.key)
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return { imported: keys.length, keys }
  }

  encryptSnapshot(envMap: Record<string, string>): string {
    return this.vault.encryptSecret(JSON.stringify(envMap))
  }

  decryptSnapshot(snapshotEnc: string): Record<string, string> {
    if (!snapshotEnc) return {}
    const raw = this.vault.decryptSecret(snapshotEnc)
    return JSON.parse(raw || '{}') as Record<string, string>
  }
}
