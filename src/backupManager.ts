import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import type {
  MemoryStore,
  BackupRecord,
  ProxyRoute,
  PlatformSettings,
  EnvVar,
  ManagedDatabase,
  ComposeProject,
} from './store.ts'
import type { ServiceManager } from './serviceManager.ts'
import type { AppInstallerEngine } from './installerEngine.ts'
import type { NativeProcessService } from './nativeProcess.ts'
import type { LocalRuntimeManager } from './localRuntime.ts'
import type { ProxyConfigManager } from './proxyConfig.ts'
import { getDataDir, getPlatformLabel } from './platform.ts'

export interface ZipEntryInput {
  name: string
  data: Buffer
  mtime?: Date
}

export interface ParsedZipEntry {
  name: string
  data: Buffer
  compressedSize: number
  uncompressedSize: number
}

export interface BackupManifestEntry {
  path: string
  sizeBytes: number
  sha256: string
}

export interface BackupManifest {
  format: 'kathal-backup-v1'
  exportedAt: string
  kathalVersion: string
  platform: string
  entryCount: number
  uncompressedBytes: number
  entries: BackupManifestEntry[]
}

export interface BackupExportResult {
  buffer: Buffer
  filename: string
  entryCount: number
  uncompressedBytes: number
  compressedBytes: number
  compressionRatio: number
  manifest: BackupManifest
}

export interface BackupSnapshotRecord extends BackupRecord {
  archiveFile: string
  entryCount: number
  compressedBytes: number
  uncompressedBytes: number
}

export interface BackupImportSummary {
  format: 'zip' | 'json'
  entriesRead: number
  restoredConfigFiles: number
  restoredRoutes: number
  restoredEnvVars: number
  restoredDatabases: number
  restoredComposeProjects: number
  restoredRegistryFile: boolean
  message: string
}

export interface BackupManagerDeps {
  getVersion: () => string
  store: MemoryStore
  proxyConfig: ProxyConfigManager
  serviceEngine: ServiceManager
  installerEngine: AppInstallerEngine
  nativeProcesses: NativeProcessService
  localRuntime: LocalRuntimeManager
  onReloadRegistry?: () => void
}

const MAX_ZIP_ENTRIES = 500
const MAX_TOTAL_UNCOMPRESSED_BYTES = 50 * 1024 * 1024 // 50 MB
const MAX_SINGLE_APP_CONFIG_BYTES = 2 * 1024 * 1024 // 2 MB

const SKIP_DIRS = new Set([
  'node_modules',
  '.venv',
  'venv',
  '.git',
  'dist',
  'build',
  '__pycache__',
  '.cache',
  'logs',
  'tmp',
])

const CONFIG_EXTENSIONS = new Set([
  '.env',
  '.json',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.conf',
  '.cfg',
  '.properties',
  '.xml',
])

const CONFIG_BASENAMES = new Set([
  '.env',
  'caddyfile',
  'nginx.conf',
  'dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
  'package.json',
  'requirements.txt',
  'pyproject.toml',
])

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  return table
})()

function computeCrc32(buf: Buffer): number {
  const nativeCrc = (zlib as unknown as { crc32?: (data: Buffer) => number }).crc32
  if (typeof nativeCrc === 'function') {
    return nativeCrc(buf) >>> 0
  }
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function toDosTimeDate(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, Math.min(2107, date.getUTCFullYear()))
  const month = date.getUTCMonth() + 1
  const day = date.getUTCDate()
  const hours = date.getUTCHours()
  const minutes = date.getUTCMinutes()
  const seconds = Math.floor(date.getUTCSeconds() / 2)
  const dosTime = (hours << 11) | (minutes << 5) | seconds
  const dosDate = ((year - 1980) << 9) | (month << 5) | day
  return { dosTime, dosDate }
}

function sanitizeZipEntryPath(rawPath: string): string | null {
  if (!rawPath || rawPath.includes('\0')) return null
  const unified = rawPath.replace(/\\/g, '/').replace(/^\/+/, '')
  const segments = unified.split('/').filter(Boolean)
  if (segments.length === 0) return null
  if (segments.some((s) => s === '.' || s === '..')) return null
  return segments.join('/')
}

/**
 * Pure-Node PKZIP 2.0 DEFLATE archive builder compatible with Windows Explorer,
 * macOS Archive Utility, Info-ZIP (`unzip`), and Python `zipfile`.
 */
export function buildZipArchive(entries: ZipEntryInput[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  let entryCount = 0

  for (const entry of entries) {
    const safeName = sanitizeZipEntryPath(entry.name)
    if (!safeName) continue
    entryCount += 1

    const nameBuf = Buffer.from(safeName, 'utf8')
    const raw = entry.data
    const crc = computeCrc32(raw)
    const deflated = raw.length > 0 ? zlib.deflateRawSync(raw, { level: 9 }) : Buffer.alloc(0)
    const useDeflate = raw.length > 0 && deflated.length < raw.length
    const method = useDeflate ? 8 : 0
    const payload = useDeflate ? deflated : raw
    const { dosTime, dosDate } = toDosTimeDate(entry.mtime || new Date())
    const gpFlag = 0x0800 // UTF-8 filename encoding

    // Local File Header (30 bytes + filename)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4) // version needed (2.0)
    localHeader.writeUInt16LE(gpFlag, 6)
    localHeader.writeUInt16LE(method, 8)
    localHeader.writeUInt16LE(dosTime, 10)
    localHeader.writeUInt16LE(dosDate, 12)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(payload.length, 18)
    localHeader.writeUInt32LE(raw.length, 22)
    localHeader.writeUInt16LE(nameBuf.length, 26)
    localHeader.writeUInt16LE(0, 28) // extra len

    localParts.push(localHeader, nameBuf, payload)

    // Central Directory Header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4) // version made by
    centralHeader.writeUInt16LE(20, 6) // version needed
    centralHeader.writeUInt16LE(gpFlag, 8)
    centralHeader.writeUInt16LE(method, 10)
    centralHeader.writeUInt16LE(dosTime, 12)
    centralHeader.writeUInt16LE(dosDate, 14)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(payload.length, 20)
    centralHeader.writeUInt32LE(raw.length, 24)
    centralHeader.writeUInt16LE(nameBuf.length, 28)
    centralHeader.writeUInt16LE(0, 30) // extra len
    centralHeader.writeUInt16LE(0, 32) // comment len
    centralHeader.writeUInt16LE(0, 34) // disk number
    centralHeader.writeUInt16LE(0, 36) // internal attrs
    centralHeader.writeUInt32LE(0, 38) // external attrs
    centralHeader.writeUInt32LE(offset, 42)

    centralParts.push(centralHeader, nameBuf)
    offset += localHeader.length + nameBuf.length + payload.length
  }

  const centralDir = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4) // disk number
  eocd.writeUInt16LE(0, 6) // central dir start disk
  eocd.writeUInt16LE(entryCount, 8)
  eocd.writeUInt16LE(entryCount, 10)
  eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20) // comment len

  return Buffer.concat([...localParts, centralDir, eocd])
}

export function isZipBuffer(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05)
}

/**
 * Safely parses PKZIP archives with zip-slip & decompression bomb protections.
 */
export function parseZipArchive(buf: Buffer): ParsedZipEntry[] {
  if (!isZipBuffer(buf)) {
    throw new Error('Not a valid ZIP archive')
  }

  // Locate End of Central Directory (PK\x05\x06) searching backwards from end
  const minOffset = Math.max(0, buf.length - 65557)
  let eocdOffset = -1
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i
      break
    }
  }
  if (eocdOffset === -1) {
    throw new Error('Corrupt ZIP archive: missing End of Central Directory record')
  }

  const totalEntries = buf.readUInt16LE(eocdOffset + 10)
  const cdSize = buf.readUInt32LE(eocdOffset + 12)
  const cdOffset = buf.readUInt32LE(eocdOffset + 16)

  if (totalEntries > MAX_ZIP_ENTRIES) {
    throw new Error(`ZIP archive exceeds maximum allowed entry count (${MAX_ZIP_ENTRIES})`)
  }
  if (cdOffset + cdSize > eocdOffset) {
    throw new Error('Corrupt ZIP central directory boundaries')
  }

  const entries: ParsedZipEntry[] = []
  let ptr = cdOffset
  let runningUncompressed = 0

  for (let idx = 0; idx < totalEntries; idx++) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== 0x02014b50) {
      throw new Error('Corrupt ZIP central directory header')
    }
    const method = buf.readUInt16LE(ptr + 10)
    const expectedCrc = buf.readUInt32LE(ptr + 16)
    const compressedSize = buf.readUInt32LE(ptr + 20)
    const uncompressedSize = buf.readUInt32LE(ptr + 24)
    const nameLen = buf.readUInt16LE(ptr + 28)
    const extraLen = buf.readUInt16LE(ptr + 30)
    const commentLen = buf.readUInt16LE(ptr + 32)
    const localOffset = buf.readUInt32LE(ptr + 42)

    const rawName = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8')
    ptr += 46 + nameLen + extraLen + commentLen

    // Skip directory markers cleanly
    if (rawName.endsWith('/')) continue

    const safeName = sanitizeZipEntryPath(rawName)
    if (!safeName) {
      throw new Error(`Unsafe ZIP entry path rejected: "${rawName}"`)
    }

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`Corrupt local header for "${safeName}"`)
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26)
    const localExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const dataEnd = dataStart + compressedSize
    if (dataEnd > buf.length) {
      throw new Error(`Truncated data payload for "${safeName}"`)
    }

    runningUncompressed += uncompressedSize
    if (runningUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new Error('ZIP archive uncompressed size exceeds 50 MB safety limit')
    }

    const compressedSlice = buf.subarray(dataStart, dataEnd)
    let data: Buffer
    if (method === 0) {
      data = Buffer.from(compressedSlice)
    } else if (method === 8) {
      data = zlib.inflateRawSync(compressedSlice, { maxOutputLength: MAX_TOTAL_UNCOMPRESSED_BYTES })
    } else {
      throw new Error(`Unsupported ZIP compression method (${method}) for "${safeName}"`)
    }

    if (data.length !== uncompressedSize || computeCrc32(data) !== expectedCrc) {
      throw new Error(`Checksum mismatch for ZIP entry "${safeName}"`)
    }

    entries.push({
      name: safeName,
      data,
      compressedSize,
      uncompressedSize,
    })
  }

  return entries
}

function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function isConfigFilename(filename: string): boolean {
  const lower = filename.toLowerCase()
  if (lower.startsWith('.env')) return true
  if (CONFIG_BASENAMES.has(lower)) return true
  const ext = path.extname(lower)
  return CONFIG_EXTENSIONS.has(ext)
}

export class BackupManager {
  private readonly deps: BackupManagerDeps
  private readonly backupsDir: string
  private readonly snapshots = new Map<string, BackupSnapshotRecord>()

  constructor(deps: BackupManagerDeps) {
    this.deps = deps
    this.backupsDir = path.resolve(getDataDir(), 'backups')
    this.loadExistingSnapshots()
  }

  getBackupsDir(): string {
    return this.backupsDir
  }

  private ensureBackupsDir() {
    fs.mkdirSync(this.backupsDir, { recursive: true })
  }

  private loadExistingSnapshots() {
    try {
      if (!fs.existsSync(this.backupsDir)) return
      const files = fs.readdirSync(this.backupsDir)
      for (const file of files) {
        if (!file.endsWith('.zip')) continue
        const fullPath = path.join(this.backupsDir, file)
        const stat = fs.statSync(fullPath)
        if (!stat.isFile()) continue
        const id = file.replace(/\.zip$/i, '')
        if (!this.deps.store.backups.some((b) => b.id === id)) {
          const rec: BackupSnapshotRecord = {
            id,
            name: id,
            created_at: stat.mtime.toISOString(),
            size: formatByteSize(stat.size),
            archiveFile: file,
            entryCount: 0,
            compressedBytes: stat.size,
            uncompressedBytes: stat.size,
          }
          this.snapshots.set(id, rec)
          this.deps.store.backups.push({
            id: rec.id,
            name: rec.name,
            created_at: rec.created_at,
            size: rec.size,
          })
        }
      }
    } catch {
      // ignore snapshot scan failures
    }
  }

  listBackups(): (BackupRecord & { archiveAvailable: boolean; entryCount?: number })[] {
    return this.deps.store.backups.map((b) => {
      const meta = this.snapshots.get(b.id)
      const archivePath = meta ? path.join(this.backupsDir, meta.archiveFile) : path.join(this.backupsDir, `${b.id}.zip`)
      return {
        ...b,
        archiveAvailable: fs.existsSync(archivePath),
        entryCount: meta?.entryCount,
      }
    })
  }

  private collectAppConfigFiles(): ZipEntryInput[] {
    const collected = new Map<string, ZipEntryInput>()
    const appsRoot = path.resolve(this.deps.localRuntime.getAppsRoot())

    const scanDir = (dirPath: string, prefixInZip: string, depth = 0) => {
      if (depth > 3 || collected.size >= 300) return
      let dirEntries: fs.Dirent[]
      try {
        dirEntries = fs.readdirSync(dirPath, { withFileTypes: true })
      } catch {
        return
      }
      for (const dirent of dirEntries) {
        if (dirent.isSymbolicLink()) continue
        const full = path.join(dirPath, dirent.name)
        if (dirent.isDirectory()) {
          if (SKIP_DIRS.has(dirent.name)) continue
          scanDir(full, `${prefixInZip}/${dirent.name}`, depth + 1)
          continue
        }
        if (!dirent.isFile() || !isConfigFilename(dirent.name)) continue
        try {
          const stat = fs.statSync(full)
          if (stat.size > MAX_SINGLE_APP_CONFIG_BYTES) continue
          const data = fs.readFileSync(full)
          const zipPath = `${prefixInZip}/${dirent.name}`
          collected.set(zipPath, { name: zipPath, data, mtime: stat.mtime })
        } catch {
          // skip unreadable config file
        }
      }
    }

    if (fs.existsSync(appsRoot)) {
      scanDir(appsRoot, 'apps', 0)
    }

    // Also include virtual workspace config files (compose, .env, nginx, caddy) from store.files
    for (const [vPath, node] of this.deps.store.files.entries()) {
      if (node.isDir || typeof node.content !== 'string') continue
      const baseName = path.basename(vPath)
      if (!isConfigFilename(baseName)) continue
      const cleanRel = vPath.replace(/^\/+/, '')
      const zipPath = `workspace/${cleanRel}`
      if (!collected.has(zipPath)) {
        collected.set(zipPath, {
          name: zipPath,
          data: Buffer.from(node.content, 'utf8'),
          mtime: node.updatedAt ? new Date(node.updatedAt) : new Date(),
        })
      }
    }

    return Array.from(collected.values())
  }

  private collectBackupEntries(): { entries: ZipEntryInput[]; manifest: BackupManifest } {
    const exportedAt = new Date().toISOString()
    const version = this.deps.getVersion()
    const entries: ZipEntryInput[] = []

    // 1. Service Registry & Runtime Workloads
    const serviceRegistryPayload = {
      exportedAt,
      version,
      managedServices: this.deps.serviceEngine.listServices().map((s) => ({
        ...s,
        logs: s.logs.slice(-50),
      })),
      installedTemplates: this.deps.installerEngine.listAll().map((app) => ({
        id: app.id,
        templateId: app.templateId,
        name: app.name,
        displayName: app.displayName,
        runtime: app.runtime,
        compatibility: app.compatibility,
        installMethod: app.installMethod,
        appDir: app.appDir,
        dataDir: app.dataDir,
        configFilePath: app.configFilePath,
        executable: app.executable,
        args: app.args,
        port: app.port,
        state: app.state,
        installStatus: app.installStatus,
        env: app.env,
        healthCheckPath: app.healthCheckPath,
        installedAt: app.installedAt,
      })),
      nativeProcesses: this.deps.nativeProcesses.listProcesses().map((p) => ({
        id: p.id,
        name: p.name,
        executable: p.executable,
        args: p.args,
        workingDir: p.workingDir,
        port: p.port,
        state: p.state,
        env: p.env,
      })),
      localApps: this.deps.localRuntime.listApps().map((a) => ({
        id: a.id,
        name: a.name,
        runtime: a.runtime,
        port: a.port,
        state: a.state,
        image: a.image,
        appDir: a.appDir,
        env: a.env,
      })),
    }

    entries.push({
      name: 'registry/service-registry.json',
      data: Buffer.from(JSON.stringify(serviceRegistryPayload, null, 2), 'utf8'),
    })

    // 2. Central App Catalog Registry (data/registry.json)
    const registryDiskPath = path.resolve(getDataDir(), 'registry.json')
    if (fs.existsSync(registryDiskPath)) {
      try {
        entries.push({
          name: 'registry/registry.json',
          data: fs.readFileSync(registryDiskPath),
        })
      } catch {
        // ignore unreadable disk registry
      }
    }

    // 3. Reverse Proxy Config (data/reverse-proxy.json + active routes)
    const persistedProxy = this.deps.proxyConfig.loadFromDisk() || {
      version: 1,
      updatedAt: exportedAt,
      settings: {
        serverDomain: this.deps.store.settings.serverDomain,
        wildcardDomain: this.deps.store.settings.wildcardDomain,
        letsEncryptEmail: this.deps.store.settings.letsEncryptEmail,
        autoSsl: this.deps.store.settings.autoSsl,
        forceHttps: this.deps.store.settings.forceHttps,
      },
      routes: this.deps.store.proxyRoutes,
    }
    entries.push({
      name: 'config/reverse-proxy.json',
      data: Buffer.from(JSON.stringify(persistedProxy, null, 2), 'utf8'),
    })

    // 4. Platform Settings, Env Vars, Databases, Compose Stacks, Registries
    const platformConfigPayload = {
      exportedAt,
      version,
      settings: this.deps.store.settings,
      proxyRoutes: this.deps.store.proxyRoutes,
      envVars: this.deps.store.envVars,
      databases: this.deps.store.databases,
      composeProjects: this.deps.store.composeProjects,
      networks: this.deps.store.networks,
      volumes: this.deps.store.volumes,
      gitRepos: this.deps.store.gitRepos,
    }
    entries.push({
      name: 'config/platform-settings.json',
      data: Buffer.from(JSON.stringify(platformConfigPayload, null, 2), 'utf8'),
    })

    // 5. Optional deploy/apps.json manifest
    const deployAppsPath = path.resolve(process.cwd(), 'deploy', 'apps.json')
    if (fs.existsSync(deployAppsPath)) {
      try {
        entries.push({
          name: 'config/deploy-apps.json',
          data: fs.readFileSync(deployAppsPath),
        })
      } catch {
        // ignore
      }
    }

    // 6. Application configuration files from data/apps/ & workspace
    for (const appFile of this.collectAppConfigFiles()) {
      entries.push(appFile)
    }

    // 7. Build manifest.json summarizing every archived file + SHA-256 digest
    const manifestEntries: BackupManifestEntry[] = entries.map((e) => ({
      path: e.name,
      sizeBytes: e.data.length,
      sha256: crypto.createHash('sha256').update(e.data).digest('hex'),
    }))
    const uncompressedBytes = manifestEntries.reduce((sum, item) => sum + item.sizeBytes, 0)

    const manifest: BackupManifest = {
      format: 'kathal-backup-v1',
      exportedAt,
      kathalVersion: version,
      platform: `${getPlatformLabel()} (${process.platform}/${process.arch})`,
      entryCount: manifestEntries.length + 1,
      uncompressedBytes,
      entries: manifestEntries,
    }

    entries.unshift({
      name: 'manifest.json',
      data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
    })

    return { entries, manifest }
  }

  exportZipArchive(): BackupExportResult {
    const { entries, manifest } = this.collectBackupEntries()
    const buffer = buildZipArchive(entries)
    const dateStamp = new Date().toISOString().slice(0, 10)
    const uncompressedBytes = entries.reduce((sum, e) => sum + e.data.length, 0)
    const compressedBytes = buffer.length
    const compressionRatio =
      uncompressedBytes > 0
        ? Math.max(0, Math.round(((uncompressedBytes - compressedBytes) / uncompressedBytes) * 100))
        : 0

    return {
      buffer,
      filename: `kathal-backup-${dateStamp}.zip`,
      entryCount: entries.length,
      uncompressedBytes,
      compressedBytes,
      compressionRatio,
      manifest,
    }
  }

  createSnapshot(rawName?: string): BackupSnapshotRecord {
    this.ensureBackupsDir()
    const cleanName = String(rawName || '')
      .trim()
      .replace(/[^\w.\- ]+/g, '_')
      .slice(0, 80)
    const name = cleanName || `backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`
    const id = this.deps.store.newId('bkp')
    const archiveFile = `${id}.zip`
    const exported = this.exportZipArchive()
    const targetPath = path.resolve(this.backupsDir, archiveFile)
    if (!targetPath.startsWith(this.backupsDir + path.sep)) {
      throw new Error('Invalid snapshot archive path')
    }

    fs.writeFileSync(targetPath, exported.buffer)

    const record: BackupSnapshotRecord = {
      id,
      name,
      created_at: new Date().toISOString(),
      size: formatByteSize(exported.compressedBytes),
      archiveFile,
      entryCount: exported.entryCount,
      compressedBytes: exported.compressedBytes,
      uncompressedBytes: exported.uncompressedBytes,
    }

    this.snapshots.set(id, record)
    this.deps.store.backups.unshift({
      id: record.id,
      name: record.name,
      created_at: record.created_at,
      size: record.size,
    })

    return record
  }

  getSnapshotArchive(id: string): { filename: string; buffer: Buffer } | null {
    const cleanId = path.basename(String(id || '').trim())
    if (!cleanId || !/^[A-Za-z0-9_-]+$/.test(cleanId)) return null
    const snapshot = this.snapshots.get(cleanId)
    const fileName = snapshot?.archiveFile || `${cleanId}.zip`
    const fullPath = path.resolve(this.backupsDir, fileName)
    if (!fullPath.startsWith(this.backupsDir + path.sep) || !fs.existsSync(fullPath)) {
      return null
    }
    const displayName = (snapshot?.name || cleanId).replace(/[^A-Za-z0-9._-]+/g, '-')
    return {
      filename: `${displayName}.zip`,
      buffer: fs.readFileSync(fullPath),
    }
  }

  deleteSnapshot(id: string): boolean {
    const idx = this.deps.store.backups.findIndex((b) => b.id === id)
    if (idx === -1) return false
    const cleanId = path.basename(id)
    const meta = this.snapshots.get(cleanId)
    const fileName = meta?.archiveFile || `${cleanId}.zip`
    const fullPath = path.resolve(this.backupsDir, fileName)
    if (fullPath.startsWith(this.backupsDir + path.sep) && fs.existsSync(fullPath)) {
      try {
        fs.unlinkSync(fullPath)
      } catch {
        // ignore file cleanup failure
      }
    }
    this.snapshots.delete(cleanId)
    this.deps.store.backups.splice(idx, 1)
    return true
  }

  restoreSnapshot(id: string): BackupImportSummary {
    const found = this.getSnapshotArchive(id)
    if (!found) {
      throw new Error('Snapshot archive file not found on disk')
    }
    return this.importArchive(found.buffer)
  }

  importArchive(buffer: Buffer): BackupImportSummary {
    if (isZipBuffer(buffer)) {
      const entries = parseZipArchive(buffer)
      let restoredConfigFiles = 0
      let restoredRoutes = 0
      let restoredEnvVars = 0
      let restoredDatabases = 0
      let restoredComposeProjects = 0
      let restoredRegistryFile = false

      const appsRoot = path.resolve(this.deps.localRuntime.getAppsRoot())
      fs.mkdirSync(appsRoot, { recursive: true })

      for (const entry of entries) {
        if (entry.name === 'config/platform-settings.json') {
          const parsed = JSON.parse(entry.data.toString('utf8')) as {
            settings?: Partial<PlatformSettings>
            proxyRoutes?: ProxyRoute[]
            envVars?: EnvVar[]
            databases?: ManagedDatabase[]
            composeProjects?: ComposeProject[]
          }
          if (parsed.settings && typeof parsed.settings === 'object') {
            this.deps.store.settings = { ...this.deps.store.settings, ...parsed.settings }
          }
          if (Array.isArray(parsed.proxyRoutes)) {
            this.deps.store.proxyRoutes = parsed.proxyRoutes
            restoredRoutes = parsed.proxyRoutes.length
          }
          if (Array.isArray(parsed.envVars)) {
            this.deps.store.envVars = parsed.envVars
            restoredEnvVars = parsed.envVars.length
          }
          if (Array.isArray(parsed.databases)) {
            this.deps.store.databases = parsed.databases
            restoredDatabases = parsed.databases.length
          }
          if (Array.isArray(parsed.composeProjects)) {
            this.deps.store.composeProjects = parsed.composeProjects
            restoredComposeProjects = parsed.composeProjects.length
          }
        } else if (entry.name === 'config/reverse-proxy.json') {
          const parsed = JSON.parse(entry.data.toString('utf8')) as {
            routes?: ProxyRoute[]
            settings?: Partial<PlatformSettings>
          }
          if (Array.isArray(parsed.routes)) {
            this.deps.store.proxyRoutes = parsed.routes.map((r) => ({
              id: r.id,
              domain: r.domain,
              target: r.target,
              port: r.port,
              ssl: Boolean(r.ssl),
              enabled: Boolean(r.enabled),
            }))
            restoredRoutes = this.deps.store.proxyRoutes.length
          }
          if (parsed.settings && typeof parsed.settings === 'object') {
            this.deps.store.settings = { ...this.deps.store.settings, ...parsed.settings }
          }
        } else if (entry.name === 'registry/registry.json') {
          // Validate JSON structure before overwriting data/registry.json
          const parsed = JSON.parse(entry.data.toString('utf8')) as { applications?: unknown[] }
          if (parsed && Array.isArray(parsed.applications)) {
            const targetRegistry = path.resolve(getDataDir(), 'registry.json')
            fs.mkdirSync(path.dirname(targetRegistry), { recursive: true })
            fs.writeFileSync(targetRegistry, entry.data)
            restoredRegistryFile = true
            this.deps.onReloadRegistry?.()
          }
        } else if (entry.name.startsWith('apps/')) {
          const relInsideApps = entry.name.slice('apps/'.length)
          const targetPath = path.resolve(appsRoot, relInsideApps)
          if (targetPath.startsWith(appsRoot + path.sep)) {
            fs.mkdirSync(path.dirname(targetPath), { recursive: true })
            fs.writeFileSync(targetPath, entry.data)
            restoredConfigFiles += 1
          }
        } else if (entry.name.startsWith('workspace/')) {
          const relPath = '/' + entry.name.slice('workspace/'.length)
          const norm = this.deps.store.normalizePath(relPath)
          this.deps.store.ensureParentDirs(norm)
          this.deps.store.files.set(norm, {
            isDir: false,
            content: entry.data.toString('utf8'),
            updatedAt: new Date().toISOString(),
          })
          restoredConfigFiles += 1
        }
      }

      this.deps.proxyConfig.saveToDisk(this.deps.store.proxyRoutes, this.deps.store.settings)

      return {
        format: 'zip',
        entriesRead: entries.length,
        restoredConfigFiles,
        restoredRoutes,
        restoredEnvVars,
        restoredDatabases,
        restoredComposeProjects,
        restoredRegistryFile,
        message: `Imported ZIP backup (${entries.length} files, ${restoredConfigFiles} app config file(s), ${restoredRoutes} proxy route(s)).`,
      }
    }

    // Legacy JSON export compatibility
    const parsed = JSON.parse(buffer.toString('utf8')) as {
      proxyRoutes?: ProxyRoute[]
      databases?: ManagedDatabase[]
      composeProjects?: ComposeProject[]
      envVars?: EnvVar[]
      settings?: Partial<PlatformSettings>
    }
    let restoredRoutes = 0
    let restoredEnvVars = 0
    let restoredDatabases = 0
    let restoredComposeProjects = 0
    if (Array.isArray(parsed.proxyRoutes)) {
      this.deps.store.proxyRoutes = parsed.proxyRoutes
      restoredRoutes = parsed.proxyRoutes.length
    }
    if (Array.isArray(parsed.databases)) {
      this.deps.store.databases = parsed.databases
      restoredDatabases = parsed.databases.length
    }
    if (Array.isArray(parsed.composeProjects)) {
      this.deps.store.composeProjects = parsed.composeProjects
      restoredComposeProjects = parsed.composeProjects.length
    }
    if (Array.isArray(parsed.envVars)) {
      this.deps.store.envVars = parsed.envVars
      restoredEnvVars = parsed.envVars.length
    }
    if (parsed.settings && typeof parsed.settings === 'object') {
      this.deps.store.settings = { ...this.deps.store.settings, ...parsed.settings }
    }
    this.deps.proxyConfig.saveToDisk(this.deps.store.proxyRoutes, this.deps.store.settings)

    return {
      format: 'json',
      entriesRead: 1,
      restoredConfigFiles: 0,
      restoredRoutes,
      restoredEnvVars,
      restoredDatabases,
      restoredComposeProjects,
      restoredRegistryFile: false,
      message: 'Imported legacy JSON backup archive successfully.',
    }
  }
}
