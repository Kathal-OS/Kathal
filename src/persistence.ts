import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { getDataDir, getPlatformLabel } from './platform.ts'
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
} from './store.ts'

export interface PersistedAuthState {
  email: string
  passwordHash: string
  updatedAt: string
}

export interface AuditEvent {
  id: string
  timestamp: string
  actor: string
  action: string
  target: string
  outcome: 'success' | 'denied' | 'error'
  ip: string
  detail?: string
}

export interface FleetServerRecord {
  id: string
  name: string
  host: string
  port: number
  authMethod: 'local-agent' | 'ssh-key' | 'agent-token'
  role: 'control-plane' | 'worker'
  group: string
  tags: string[]
  status: 'online' | 'pending' | 'unreachable'
  isLocal: boolean
  os: string
  arch: string
  lastCheckedAt: string | null
  latencyMs: number | null
  agentVersion: string | null
  createdAt: string
}

interface PersistedPlatformPayload {
  schemaVersion: 1
  updatedAt: string
  settings: PlatformSettings
  databases: ManagedDatabase[]
  envVars: EnvVar[]
  registries: RegistryCredential[]
  gitRepos: GitRepo[]
  gitHistory: Record<string, GitDeployLog[]>
  composeProjects: ComposeProject[]
  networks: NetworkRecord[]
  volumes: VolumeRecord[]
  backups: BackupRecord[]
  fleetServers: FleetServerRecord[]
}

const ENC_PREFIX = 'enc:v1:'
const MAX_AUDIT_EVENTS = 1000

function atomicWriteJson(filePath: string, data: unknown, mode = 0o600): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tmpPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode })
  fs.renameSync(tmpPath, filePath)
}

export class PersistenceManager {
  private vaultKeyCache: Buffer | null = null
  private vaultKeyDir: string | null = null

  private getDataPath(filename: string): string {
    return path.resolve(getDataDir(), filename)
  }

  private getVaultKey(): Buffer {
    const dataDir = path.resolve(getDataDir())
    const envSecret = (process.env.KATHAL_VAULT_KEY || '').trim()
    if (envSecret) {
      if (/^[0-9a-fA-F]{64}$/.test(envSecret)) {
        return Buffer.from(envSecret, 'hex')
      }
      return crypto.createHash('sha256').update(envSecret).digest()
    }

    if (this.vaultKeyCache && this.vaultKeyDir === dataDir) {
      return this.vaultKeyCache
    }

    const keyFile = path.join(dataDir, '.vault-key')
    fs.mkdirSync(dataDir, { recursive: true })
    if (fs.existsSync(keyFile)) {
      const hex = fs.readFileSync(keyFile, 'utf8').trim()
      if (/^[0-9a-fA-F]{64}$/.test(hex)) {
        this.vaultKeyCache = Buffer.from(hex, 'hex')
        this.vaultKeyDir = dataDir
        return this.vaultKeyCache
      }
    }

    const generated = crypto.randomBytes(32)
    fs.writeFileSync(keyFile, generated.toString('hex') + '\n', { mode: 0o600 })
    this.vaultKeyCache = generated
    this.vaultKeyDir = dataDir
    return generated
  }

  encryptSecret(plaintext: string): string {
    if (!plaintext) return ''
    if (plaintext.startsWith(ENC_PREFIX)) return plaintext
    const key = this.getVaultKey()
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return `${ENC_PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`
  }

  decryptSecret(stored: string): string {
    if (!stored) return ''
    if (!stored.startsWith(ENC_PREFIX)) return stored
    const body = stored.slice(ENC_PREFIX.length)
    const [ivHex, tagHex, cipherHex] = body.split(':')
    if (!ivHex || !tagHex || !cipherHex) {
      throw new Error('Malformed encrypted vault payload')
    }
    const key = this.getVaultKey()
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'))
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
    const plain = Buffer.concat([
      decipher.update(Buffer.from(cipherHex, 'hex')),
      decipher.final(),
    ])
    return plain.toString('utf8')
  }

  // ---- Auth State ----

  loadAuthState(): PersistedAuthState | null {
    const file = this.getDataPath('auth-state.json')
    try {
      if (!fs.existsSync(file)) return null
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<PersistedAuthState>
      if (
        typeof parsed.email === 'string' &&
        parsed.email.includes('@') &&
        typeof parsed.passwordHash === 'string' &&
        parsed.passwordHash.startsWith('$2')
      ) {
        return {
          email: parsed.email.toLowerCase(),
          passwordHash: parsed.passwordHash,
          updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
        }
      }
    } catch {
      // ignore corrupted auth state file
    }
    return null
  }

  saveAuthState(email: string, passwordHash: string): PersistedAuthState {
    const state: PersistedAuthState = {
      email: email.trim().toLowerCase(),
      passwordHash,
      updatedAt: new Date().toISOString(),
    }
    atomicWriteJson(this.getDataPath('auth-state.json'), state, 0o600)
    return state
  }

  // ---- Platform State ----

  createDefaultLocalFleetServer(): FleetServerRecord {
    return {
      id: 'local-primary',
      name: os.hostname() || 'KATHAL Primary Node',
      host: '127.0.0.1',
      port: Number(process.env.PORT) || 3000,
      authMethod: 'local-agent',
      role: 'control-plane',
      group: 'default',
      tags: ['local', process.platform, os.arch()],
      status: 'online',
      isLocal: true,
      os: `${getPlatformLabel()} (${os.platform()})`,
      arch: os.arch(),
      lastCheckedAt: new Date().toISOString(),
      latencyMs: 0,
      agentVersion: process.env.KATHAL_VERSION || '0.1.0',
      createdAt: new Date().toISOString(),
    }
  }

  loadPlatformState(store: MemoryStore): FleetServerRecord[] {
    const file = this.getDataPath('platform-state.json')
    const defaultFleet = [this.createDefaultLocalFleetServer()]
    if (!fs.existsSync(file)) {
      return defaultFleet
    }
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<PersistedPlatformPayload>
      if (raw.settings && typeof raw.settings === 'object') {
        const nextSettings = { ...store.settings, ...raw.settings }
        if (typeof nextSettings.webhookSecret === 'string' && nextSettings.webhookSecret) {
          try {
            nextSettings.webhookSecret = this.decryptSecret(nextSettings.webhookSecret)
          } catch {
            // keep existing webhookSecret if vault key changed
            nextSettings.webhookSecret = store.settings.webhookSecret
          }
        }
        store.settings = nextSettings
      }

      if (Array.isArray(raw.databases)) {
        store.databases = raw.databases.map((db) => ({
          ...db,
          password: db.password ? this.safeDecrypt(db.password) : '',
        }))
      }

      if (Array.isArray(raw.envVars)) {
        store.envVars = raw.envVars.map((item) => ({
          ...item,
          value: item.secret && item.value ? this.safeDecrypt(item.value) : item.value,
        }))
      }

      if (Array.isArray(raw.registries)) {
        store.registries = raw.registries.map((reg) => ({
          ...reg,
          password: reg.password ? this.safeDecrypt(reg.password) : '',
        }))
      }

      if (Array.isArray(raw.gitRepos)) store.gitRepos = raw.gitRepos
      if (raw.gitHistory && typeof raw.gitHistory === 'object') {
        store.gitHistory = new Map(Object.entries(raw.gitHistory))
      }
      if (Array.isArray(raw.composeProjects)) store.composeProjects = raw.composeProjects
      if (Array.isArray(raw.networks) && raw.networks.length > 0) store.networks = raw.networks
      if (Array.isArray(raw.volumes)) store.volumes = raw.volumes
      if (Array.isArray(raw.backups)) {
        for (const b of raw.backups) {
          if (!store.backups.some((existing) => existing.id === b.id)) {
            store.backups.push(b)
          }
        }
      }

      if (Array.isArray(raw.fleetServers) && raw.fleetServers.length > 0) {
        const hasLocal = raw.fleetServers.some((s) => s.id === 'local-primary' || s.isLocal)
        return hasLocal ? raw.fleetServers : [this.createDefaultLocalFleetServer(), ...raw.fleetServers]
      }
    } catch {
      // non-fatal: fall back to defaults
    }
    return defaultFleet
  }

  private safeDecrypt(val: string): string {
    try {
      return this.decryptSecret(val)
    } catch {
      return ''
    }
  }

  savePlatformState(store: MemoryStore, fleetServers: FleetServerRecord[]): void {
    const payload: PersistedPlatformPayload = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      settings: {
        ...store.settings,
        webhookSecret: store.settings.webhookSecret
          ? this.encryptSecret(store.settings.webhookSecret)
          : '',
      },
      databases: store.databases.map((db) => ({
        ...db,
        password: db.password ? this.encryptSecret(db.password) : '',
      })),
      envVars: store.envVars.map((item) => ({
        ...item,
        value: item.secret && item.value ? this.encryptSecret(item.value) : item.value,
      })),
      registries: store.registries.map((reg) => ({
        ...reg,
        password: reg.password ? this.encryptSecret(reg.password) : '',
      })),
      gitRepos: store.gitRepos,
      gitHistory: Object.fromEntries(store.gitHistory.entries()),
      composeProjects: store.composeProjects,
      networks: store.networks,
      volumes: store.volumes,
      backups: store.backups,
      fleetServers,
    }
    atomicWriteJson(this.getDataPath('platform-state.json'), payload, 0o600)
  }

  // ---- Audit Log ----

  loadAuditLog(): AuditEvent[] {
    const file = this.getDataPath('audit-log.json')
    try {
      if (!fs.existsSync(file)) return []
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      return Array.isArray(parsed) ? (parsed as AuditEvent[]) : []
    } catch {
      return []
    }
  }

  appendAuditEvent(event: Omit<AuditEvent, 'id' | 'timestamp'>): AuditEvent {
    const entry: AuditEvent = {
      id: `aud-${crypto.randomBytes(6).toString('hex')}`,
      timestamp: new Date().toISOString(),
      ...event,
    }
    const existing = this.loadAuditLog()
    existing.unshift(entry)
    const trimmed = existing.slice(0, MAX_AUDIT_EVENTS)
    atomicWriteJson(this.getDataPath('audit-log.json'), trimmed, 0o600)
    return entry
  }
}
