import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { getDataDir } from '../platform.ts'

const ENC_V1_PREFIX = 'enc:v1:'
const ENC_V2_PREFIX = 'enc:v2:'

export interface VaultKeyRecord {
  kid: string
  algorithm: string
  source: 'env' | 'keyfile'
  fingerprint: string
  status: 'active' | 'retired'
  created_at: string
  rotated_at: string | null
}

export interface VaultStatusReport {
  status: 'ready' | 'locked' | 'uninitialized'
  activeKid: string
  keySource: 'env' | 'keyfile' | 'none'
  keyFilePath: string
  keyFilePermissionsOk: boolean
  needsRecovery: boolean
  recoveryReason: string | null
  keyCount: number
  keys: VaultKeyRecord[]
  secretCount: number
}

function deriveKeyFromInput(rawInput: string): Buffer {
  const trimmed = rawInput.trim()
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex')
  }
  return crypto.createHash('sha256').update(trimmed, 'utf8').digest()
}

function keyFingerprint(key: Buffer): string {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)
}

export class VaultLockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VaultLockedError'
  }
}

export class VaultManager {
  private cachedKeys = new Map<string, Buffer>()
  private activeKid = 'vk-v1'
  private keySource: 'env' | 'keyfile' | 'none' = 'none'
  private lockedReason: string | null = null
  private initializedDataDir: string | null = null

  getKeyFilePath(): string {
    return path.resolve(getDataDir(), '.vault-key')
  }

  private checkKeyFilePermissions(keyFile: string): boolean {
    if (process.platform === 'win32') return true
    try {
      const st = fs.statSync(keyFile)
      // Disallow group/other read/write/execute bits
      return (st.mode & 0o077) === 0
    } catch {
      return false
    }
  }

  private tightenKeyFilePermissions(keyFile: string): void {
    if (process.platform === 'win32') return
    try {
      fs.chmodSync(keyFile, 0o600)
    } catch {
      // ignore if filesystem does not support chmod
    }
  }

  /**
   * Initialize vault keyring against SQLite metadata without silently generating
   * a replacement key if encrypted payloads already exist.
   */
  initialize(db?: DatabaseSync): void {
    const dataDir = path.resolve(getDataDir())
    if (this.initializedDataDir !== dataDir) {
      this.cachedKeys.clear()
      this.lockedReason = null
      this.initializedDataDir = dataDir
    }

    const envRaw = (process.env.KATHAL_VAULT_KEY || '').trim()
    const keyFile = this.getKeyFilePath()
    fs.mkdirSync(dataDir, { recursive: true })

    let primaryKey: Buffer | null = null
    let source: 'env' | 'keyfile' | 'none' = 'none'

    if (envRaw) {
      primaryKey = deriveKeyFromInput(envRaw)
      source = 'env'
    } else if (fs.existsSync(keyFile)) {
      const fileContent = fs.readFileSync(keyFile, 'utf8').trim()
      if (!/^[0-9a-fA-F]{64}$/.test(fileContent)) {
        this.lockedReason =
          'Existing .vault-key file is malformed. Restore a valid 64-character hex key or set KATHAL_VAULT_KEY.'
        this.keySource = 'none'
        return
      }
      this.tightenKeyFilePermissions(keyFile)
      primaryKey = Buffer.from(fileContent, 'hex')
      source = 'keyfile'
    }

    const hasExistingEncryptedData = db ? this.hasEncryptedPayloads(db) : false
    const existingKeys = db
      ? (db.prepare('SELECT kid, algorithm, source, fingerprint, status, created_at, rotated_at FROM vault_keys ORDER BY created_at DESC').all() as unknown as VaultKeyRecord[])
      : []

    if (!primaryKey) {
      if (hasExistingEncryptedData || existingKeys.length > 0) {
        this.lockedReason =
          'Encrypted secrets exist in the database, but neither KATHAL_VAULT_KEY nor .vault-key is present. Refusing to overwrite vault key; provide the original key to unlock.'
        this.keySource = 'none'
        return
      }
      // Safe fresh initialization: generate a brand-new 256-bit key
      const generated = crypto.randomBytes(32)
      fs.writeFileSync(keyFile, generated.toString('hex') + '\n', { mode: 0o600 })
      this.tightenKeyFilePermissions(keyFile)
      primaryKey = generated
      source = 'keyfile'
    }

    const fp = keyFingerprint(primaryKey)
    this.keySource = source

    if (db) {
      const activeMeta = existingKeys.find((k) => k.status === 'active')
      if (activeMeta) {
        if (activeMeta.fingerprint !== fp && (hasExistingEncryptedData || existingKeys.length > 0)) {
          // Allow loading ONLY if caller explicitly rotated or if key matches one of the active records
          this.lockedReason = `Provided vault key fingerprint (${fp}) does not match active database key (${activeMeta.fingerprint}). Supply the matching KATHAL_VAULT_KEY or perform a recovery workflow.`
          this.cachedKeys.set(activeMeta.kid, primaryKey)
          this.activeKid = activeMeta.kid
          return
        }
        this.activeKid = activeMeta.kid
        this.cachedKeys.set(activeMeta.kid, primaryKey)
      } else {
        this.activeKid = 'vk-v1'
        this.cachedKeys.set(this.activeKid, primaryKey)
        db.prepare(
          `INSERT INTO vault_keys (kid, algorithm, source, fingerprint, status, created_at, rotated_at)
           VALUES (?, 'aes-256-gcm', ?, ?, 'active', ?, NULL)`
        ).run(this.activeKid, source, fp, new Date().toISOString())
      }
    } else {
      this.activeKid = 'vk-v1'
      this.cachedKeys.set(this.activeKid, primaryKey)
    }

    this.lockedReason = null
  }

  private hasEncryptedPayloads(db: DatabaseSync): boolean {
    try {
      const secCount = (db.prepare("SELECT COUNT(*) as cnt FROM secrets WHERE value_enc LIKE 'enc:%'").get() as { cnt: number }).cnt
      const dbCount = (db.prepare("SELECT COUNT(*) as cnt FROM databases WHERE password_enc LIKE 'enc:%'").get() as { cnt: number }).cnt
      const regCount = (db.prepare("SELECT COUNT(*) as cnt FROM registries WHERE password_enc LIKE 'enc:%'").get() as { cnt: number }).cnt
      const setCount = (db.prepare("SELECT COUNT(*) as cnt FROM system_settings WHERE webhook_secret_enc LIKE 'enc:%'").get() as { cnt: number }).cnt
      let p2Count = 0
      for (const q of [
        "SELECT COUNT(*) as cnt FROM application_environments WHERE value_enc LIKE 'enc:%'",
        "SELECT COUNT(*) as cnt FROM application_sources WHERE token_enc LIKE 'enc:%' OR deploy_key_enc LIKE 'enc:%' OR webhook_secret_enc LIKE 'enc:%'",
        "SELECT COUNT(*) as cnt FROM database_instances WHERE password_enc LIKE 'enc:%'",
        "SELECT COUNT(*) as cnt FROM certificates WHERE key_enc LIKE 'enc:%'",
      ]) {
        try {
          p2Count += (db.prepare(q).get() as { cnt: number }).cnt
        } catch {
          // table may not exist yet before migration 002
        }
      }
      return secCount + dbCount + regCount + setCount + p2Count > 0
    } catch {
      return false
    }
  }

  isLocked(): boolean {
    return Boolean(this.lockedReason)
  }

  getActiveKid(): string {
    return this.activeKid
  }

  private resolveKeyForKid(kid?: string): Buffer {
    if (this.lockedReason) {
      throw new VaultLockedError(this.lockedReason)
    }
    if (kid && this.cachedKeys.has(kid)) {
      return this.cachedKeys.get(kid)!
    }
    const active = this.cachedKeys.get(this.activeKid)
    if (active) return active
    this.initialize()
    if (this.lockedReason) {
      throw new VaultLockedError(this.lockedReason)
    }
    const afterInit = this.cachedKeys.get(this.activeKid)
    if (!afterInit) {
      throw new VaultLockedError('Vault key is unavailable.')
    }
    return afterInit
  }

  encryptSecret(plaintext: string): string {
    if (!plaintext) return ''
    if (plaintext.startsWith(ENC_V2_PREFIX)) return plaintext
    const key = this.resolveKeyForKid(this.activeKid)
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(this.activeKid, 'utf8'))
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return `${ENC_V2_PREFIX}${this.activeKid}:${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`
  }

  decryptSecret(stored: string): string {
    if (!stored) return ''
    if (stored.startsWith(ENC_V2_PREFIX)) {
      const body = stored.slice(ENC_V2_PREFIX.length)
      const [kid, ivHex, tagHex, cipherHex] = body.split(':')
      if (!kid || !ivHex || !tagHex || !cipherHex) {
        throw new Error('Malformed encrypted v2 vault payload')
      }
      const key = this.resolveKeyForKid(kid)
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'))
      decipher.setAAD(Buffer.from(kid, 'utf8'))
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
      const plain = Buffer.concat([
        decipher.update(Buffer.from(cipherHex, 'hex')),
        decipher.final(),
      ])
      return plain.toString('utf8')
    }

    if (stored.startsWith(ENC_V1_PREFIX)) {
      const body = stored.slice(ENC_V1_PREFIX.length)
      const [ivHex, tagHex, cipherHex] = body.split(':')
      if (!ivHex || !tagHex || !cipherHex) {
        throw new Error('Malformed encrypted v1 vault payload')
      }
      const key = this.resolveKeyForKid(this.activeKid)
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'))
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
      const plain = Buffer.concat([
        decipher.update(Buffer.from(cipherHex, 'hex')),
        decipher.final(),
      ])
      return plain.toString('utf8')
    }

    return stored
  }

  /**
   * Transactional key rotation: decrypts every encrypted secret with the active key,
   * provisions a new key ID & 256-bit key, re-encrypts all records inside one SQLite
   * transaction, and persists the updated keyfile (unless KATHAL_VAULT_KEY env overrides).
   */
  rotateKey(
    db: DatabaseSync,
    newKeyInput?: string
  ): {
    previousKid: string
    newKid: string
    reencryptedCount: number
    keySource: 'env' | 'keyfile'
    newKeyHex?: string
  } {
    if (this.lockedReason) {
      throw new VaultLockedError(this.lockedReason)
    }

    const oldKid = this.activeKid
    const nextKey = newKeyInput && newKeyInput.trim()
      ? deriveKeyFromInput(newKeyInput.trim())
      : crypto.randomBytes(32)
    const nextKid = `vk-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
    const nextFp = keyFingerprint(nextKey)
    const oldKey = this.resolveKeyForKid(oldKid)
    const source: 'env' | 'keyfile' = process.env.KATHAL_VAULT_KEY?.trim() ? 'env' : 'keyfile'

    // Helper using explicit key buffers so decryption/encryption stays atomic
    const decryptWith = (stored: string): string => {
      if (!stored) return ''
      if (stored.startsWith(ENC_V2_PREFIX)) {
        const [kid, ivHex, tagHex, cipherHex] = stored.slice(ENC_V2_PREFIX.length).split(':')
        const k = kid === oldKid ? oldKey : this.cachedKeys.get(kid) || oldKey
        const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(ivHex, 'hex'))
        d.setAAD(Buffer.from(kid, 'utf8'))
        d.setAuthTag(Buffer.from(tagHex, 'hex'))
        return Buffer.concat([d.update(Buffer.from(cipherHex, 'hex')), d.final()]).toString('utf8')
      }
      if (stored.startsWith(ENC_V1_PREFIX)) {
        const [ivHex, tagHex, cipherHex] = stored.slice(ENC_V1_PREFIX.length).split(':')
        const d = crypto.createDecipheriv('aes-256-gcm', oldKey, Buffer.from(ivHex, 'hex'))
        d.setAuthTag(Buffer.from(tagHex, 'hex'))
        return Buffer.concat([d.update(Buffer.from(cipherHex, 'hex')), d.final()]).toString('utf8')
      }
      return stored
    }

    const encryptWithNew = (plain: string): string => {
      if (!plain) return ''
      const iv = crypto.randomBytes(12)
      const c = crypto.createCipheriv('aes-256-gcm', nextKey, iv)
      c.setAAD(Buffer.from(nextKid, 'utf8'))
      const out = Buffer.concat([c.update(plain, 'utf8'), c.final()])
      return `${ENC_V2_PREFIX}${nextKid}:${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${out.toString('hex')}`
    }

    let reencryptedCount = 0
    const now = new Date().toISOString()

    db.exec('BEGIN IMMEDIATE')
    try {
      const secrets = db.prepare("SELECT id, value_enc FROM secrets WHERE is_secret = 1 AND value_enc != ''").all() as Array<{ id: string; value_enc: string }>
      for (const row of secrets) {
        const plain = decryptWith(row.value_enc)
        db.prepare('UPDATE secrets SET value_enc = ?, key_version = ?, updated_at = ? WHERE id = ?').run(
          encryptWithNew(plain),
          nextKid,
          now,
          row.id
        )
        reencryptedCount++
      }

      const dbs = db.prepare("SELECT id, password_enc FROM databases WHERE password_enc != ''").all() as Array<{ id: string; password_enc: string }>
      for (const row of dbs) {
        const plain = decryptWith(row.password_enc)
        db.prepare('UPDATE databases SET password_enc = ?, updated_at = ? WHERE id = ?').run(
          encryptWithNew(plain),
          now,
          row.id
        )
        reencryptedCount++
      }

      const regs = db.prepare("SELECT id, password_enc FROM registries WHERE password_enc != ''").all() as Array<{ id: string; password_enc: string }>
      for (const row of regs) {
        const plain = decryptWith(row.password_enc)
        db.prepare('UPDATE registries SET password_enc = ? WHERE id = ?').run(encryptWithNew(plain), row.id)
        reencryptedCount++
      }

      const settingsRows = db.prepare("SELECT id, webhook_secret_enc FROM system_settings WHERE webhook_secret_enc != ''").all() as Array<{ id: string; webhook_secret_enc: string }>
      for (const row of settingsRows) {
        const plain = decryptWith(row.webhook_secret_enc)
        db.prepare('UPDATE system_settings SET webhook_secret_enc = ?, updated_at = ? WHERE id = ?').run(
          encryptWithNew(plain),
          now,
          row.id
        )
        reencryptedCount++
      }

      // Phase 2 encrypted tables (safe if migration 002 is applied)
      const hasTable = (tbl: string): boolean =>
        Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tbl))

      if (hasTable('application_environments')) {
        const envRows = db
          .prepare("SELECT id, value_enc FROM application_environments WHERE is_secret = 1 AND value_enc != ''")
          .all() as Array<{ id: string; value_enc: string }>
        for (const row of envRows) {
          const plain = decryptWith(row.value_enc)
          db.prepare('UPDATE application_environments SET value_enc = ?, key_version = ?, updated_at = ? WHERE id = ?').run(
            encryptWithNew(plain),
            nextKid,
            now,
            row.id
          )
          reencryptedCount++
        }
      }

      if (hasTable('application_sources')) {
        const srcRows = db
          .prepare('SELECT id, token_enc, deploy_key_enc, webhook_secret_enc FROM application_sources')
          .all() as Array<{ id: string; token_enc: string; deploy_key_enc: string; webhook_secret_enc: string }>
        for (const row of srcRows) {
          if (!row.token_enc && !row.deploy_key_enc && !row.webhook_secret_enc) continue
          const tok = row.token_enc ? encryptWithNew(decryptWith(row.token_enc)) : ''
          const dk = row.deploy_key_enc ? encryptWithNew(decryptWith(row.deploy_key_enc)) : ''
          const wh = row.webhook_secret_enc ? encryptWithNew(decryptWith(row.webhook_secret_enc)) : ''
          db.prepare(
            'UPDATE application_sources SET token_enc = ?, deploy_key_enc = ?, webhook_secret_enc = ?, updated_at = ? WHERE id = ?'
          ).run(tok, dk, wh, now, row.id)
          reencryptedCount++
        }
      }

      if (hasTable('database_instances')) {
        const dbiRows = db
          .prepare("SELECT id, password_enc FROM database_instances WHERE password_enc != ''")
          .all() as Array<{ id: string; password_enc: string }>
        for (const row of dbiRows) {
          const plain = decryptWith(row.password_enc)
          db.prepare('UPDATE database_instances SET password_enc = ?, updated_at = ? WHERE id = ?').run(
            encryptWithNew(plain),
            now,
            row.id
          )
          reencryptedCount++
        }
      }

      if (hasTable('certificates')) {
        const certRows = db
          .prepare("SELECT id, key_enc FROM certificates WHERE key_enc != ''")
          .all() as Array<{ id: string; key_enc: string }>
        for (const row of certRows) {
          const plain = decryptWith(row.key_enc)
          db.prepare('UPDATE certificates SET key_enc = ?, updated_at = ? WHERE id = ?').run(
            encryptWithNew(plain),
            now,
            row.id
          )
          reencryptedCount++
        }
      }

      if (hasTable('deployment_snapshots')) {
        const snapRows = db
          .prepare("SELECT id, env_snapshot_enc FROM deployment_snapshots WHERE env_snapshot_enc != ''")
          .all() as Array<{ id: string; env_snapshot_enc: string }>
        for (const row of snapRows) {
          const plain = decryptWith(row.env_snapshot_enc)
          db.prepare('UPDATE deployment_snapshots SET env_snapshot_enc = ? WHERE id = ?').run(
            encryptWithNew(plain),
            row.id
          )
          reencryptedCount++
        }
      }

      db.prepare("UPDATE vault_keys SET status = 'retired', rotated_at = ? WHERE status = 'active'").run(now)
      db.prepare(
        `INSERT INTO vault_keys (kid, algorithm, source, fingerprint, status, created_at, rotated_at)
         VALUES (?, 'aes-256-gcm', ?, ?, 'active', ?, NULL)`
      ).run(nextKid, source, nextFp, now)

      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }

    if (source === 'keyfile') {
      const keyFile = this.getKeyFilePath()
      const tmp = `${keyFile}.tmp-${process.pid}`
      fs.writeFileSync(tmp, nextKey.toString('hex') + '\n', { mode: 0o600 })
      fs.renameSync(tmp, keyFile)
      this.tightenKeyFilePermissions(keyFile)
    }

    this.cachedKeys.set(nextKid, nextKey)
    this.activeKid = nextKid

    return {
      previousKid: oldKid,
      newKid: nextKid,
      reencryptedCount,
      keySource: source,
      newKeyHex: source === 'env' ? nextKey.toString('hex') : undefined,
    }
  }

  getStatus(db: DatabaseSync): VaultStatusReport {
    const keyFile = this.getKeyFilePath()
    const keys = db
      .prepare('SELECT kid, algorithm, source, fingerprint, status, created_at, rotated_at FROM vault_keys ORDER BY created_at DESC')
      .all() as unknown as VaultKeyRecord[]
    const secretCount = (db.prepare('SELECT COUNT(*) as cnt FROM secrets WHERE is_secret = 1').get() as { cnt: number }).cnt
    return {
      status: this.lockedReason ? 'locked' : this.cachedKeys.size > 0 ? 'ready' : 'uninitialized',
      activeKid: this.activeKid,
      keySource: this.keySource,
      keyFilePath: keyFile,
      keyFilePermissionsOk: fs.existsSync(keyFile) ? this.checkKeyFilePermissions(keyFile) : true,
      needsRecovery: Boolean(this.lockedReason),
      recoveryReason: this.lockedReason,
      keyCount: keys.length,
      keys,
      secretCount,
    }
  }
}
