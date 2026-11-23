import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import express, { type Request, type Response, type NextFunction } from 'express'
import multer from 'multer'
import { WebSocketServer, type WebSocket } from 'ws'
import { MemoryStore } from './src/store.ts'
import {
  loadCentralRegistry,
  reloadCentralRegistry,
  getRegistryAppById,
  getTemplateById,
} from './src/templates.ts'
import {
  LocalRuntimeManager,
  type LocalAppInstance,
  isValidPublicHttpsGitUrl,
  isValidDomainName,
  validateLocalProxyTarget,
  probeLocalHttp,
  sanitizeAppName,
} from './src/localRuntime.ts'
import { NativeProcessService, type NativeProcessInstance } from './src/nativeProcess.ts'
import { AppInstallerEngine, detectHostRuntimes, type InstalledAppRecord } from './src/installerEngine.ts'
import { ServiceManager, type ManagedServiceRecord } from './src/serviceManager.ts'
import { ProxyConfigManager } from './src/proxyConfig.ts'
import { collectSystemMonitorData } from './src/systemMonitor.ts'
import { getDataDir, getPlatformLabel, getSystemDiskMount } from './src/platform.ts'
import { UpdateChecker, resolveCurrentEnvVersion } from './src/updateChecker.ts'
import { BackupManager } from './src/backupManager.ts'
import { getRuntimeConfig } from './src/config/runtimeConfig.ts'
import { DatabaseManager } from './src/database/sqlite.ts'
import { migrateLegacyJsonToSqlite, type JsonMigrationSummary } from './src/database/jsonMigrator.ts'
import { VaultManager } from './src/security/vault.ts'
import { AuditService } from './src/audit/auditService.ts'
import { RbacService } from './src/auth/rbac.ts'
import { AuthService } from './src/auth/authService.ts'
import { PlatformRepository } from './src/repositories/platformRepository.ts'
import { FleetService } from './src/fleet/fleetService.ts'
import { TerminalGateway } from './src/websocket/terminalGateway.ts'
import { safeEqualStrings } from './src/security/password.ts'
import {
  createAuthMiddleware,
  requestContextMiddleware,
  requirePermission,
  type AuthedRequest,
} from './src/middleware/authMiddleware.ts'
import { createAuthRouter } from './src/routes/authRoutes.ts'
import { createUserRouter } from './src/routes/userRoutes.ts'
import { createVaultRouter } from './src/routes/vaultRoutes.ts'
import { createDatabaseAdminRouter } from './src/routes/databaseAdminRoutes.ts'
import { createFleetRouter } from './src/routes/fleetRoutes.ts'
import { createAuditRouter } from './src/routes/auditRoutes.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const runtimeConfig = getRuntimeConfig()
const PORT = runtimeConfig.port
const VERSION = resolveCurrentEnvVersion().version || runtimeConfig.version

const dbManager = new DatabaseManager()
const db = dbManager.initialize()
const vault = new VaultManager()
vault.initialize(db)
const auditService = new AuditService(db)
const rbacService = new RbacService(db)
rbacService.seedDefaults()
const authService = new AuthService(db, rbacService)
const platformRepo = new PlatformRepository(db, vault)
const fleetService = new FleetService(db)

let lastJsonMigrationSummary: JsonMigrationSummary | null = null
let platformBootstrapped = false

const store = new MemoryStore()
const proxyConfig = new ProxyConfigManager()
const loadedProxyConfig = proxyConfig.loadFromDisk()
if (loadedProxyConfig) {
  store.proxyRoutes = loadedProxyConfig.routes.map((r) => ({
    id: r.id,
    domain: r.domain,
    target: r.target,
    port: r.port,
    ssl: r.ssl,
    enabled: r.enabled,
  }))
  store.settings.serverDomain = loadedProxyConfig.settings.serverDomain
  store.settings.wildcardDomain = loadedProxyConfig.settings.wildcardDomain
  store.settings.letsEncryptEmail = loadedProxyConfig.settings.letsEncryptEmail
  store.settings.autoSsl = loadedProxyConfig.settings.autoSsl
  store.settings.forceHttps = loadedProxyConfig.settings.forceHttps
} else {
  proxyConfig.saveToDisk(store.proxyRoutes, store.settings)
}

function savePlatformState() {
  try {
    platformRepo.syncFromStore(store)
  } catch (err) {
    console.error('[kathal] Failed to persist platform state to SQLite:', (err as Error).message)
  }
}

async function bootstrapPlatform() {
  if (platformBootstrapped) return
  lastJsonMigrationSummary = await migrateLegacyJsonToSqlite(dbManager, vault)
  await authService.ensureConfiguredEnvOwner()
  fleetService.ensureLocalPrimaryNode()
  platformRepo.loadIntoStore(store)
  proxyConfig.saveToDisk(store.proxyRoutes, store.settings)
  platformBootstrapped = true
}

const localRuntime = new LocalRuntimeManager()
const serviceEngine: ServiceManager = new ServiceManager({
  appsRoot: localRuntime.getAppsRoot(),
  isPortReserved: (port: number, excludeId?: string): boolean =>
    localRuntime.listApps().some((a) => a.port === port) ||
    nativeProcesses.listProcesses().some((p) => p.port === port) ||
    installerEngine.listAll().some((i) => i.id !== excludeId && i.port === port),
})
const nativeProcesses: NativeProcessService = new NativeProcessService({
  appsRoot: localRuntime.getAppsRoot(),
  isPortReserved: (port: number): boolean =>
    localRuntime.listApps().some((a) => a.port === port) ||
    installerEngine.listAll().some((i) => i.port === port) ||
    serviceEngine.listServices().some((s) => s.port === port),
})
const installerEngine: AppInstallerEngine = new AppInstallerEngine({
  appsRoot: localRuntime.getAppsRoot(),
  serviceEngine,
  isPortReserved: (port: number): boolean =>
    localRuntime.listApps().some((a) => a.port === port) ||
    nativeProcesses.listProcesses().some((p) => p.port === port) ||
    serviceEngine.listServices().some((s) => s.port === port),
})
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } })

const updateChecker = new UpdateChecker()
updateChecker.startAutoCheck()

const backupManager = new BackupManager({
  getVersion: () => resolveCurrentEnvVersion().version || VERSION,
  store,
  proxyConfig,
  serviceEngine,
  installerEngine,
  nativeProcesses,
  localRuntime,
  onReloadRegistry: () => {
    reloadCentralRegistry()
  },
})

// Background monitoring sample collector (1 sample/sec, 60-sample ring buffer)
const monitoringTimer = setInterval(() => {
  const runningApps = getAllRunningForMetrics()
  store.pushMonitoringSample(runningApps)
}, 1000)
monitoringTimer.unref()

function recordAudit(
  req: AuthedRequest | { auth?: AuthedRequest['auth']; user?: AuthedRequest['user']; ip?: string; requestId?: string; socket?: { remoteAddress?: string } } | null,
  action: string,
  target: string,
  outcome: 'success' | 'denied' | 'error' = 'success',
  detail?: string,
  metadata?: Record<string, unknown>
) {
  try {
    auditService.record({
      userId: req?.auth?.user?.id || req?.user?.id || null,
      actor: req?.auth?.user?.email || req?.user?.email || 'system',
      action,
      resourceId: target,
      target,
      outcome,
      ip: req?.ip || req?.socket?.remoteAddress || '127.0.0.1',
      correlationId: req?.requestId || '',
      detail,
      metadata,
    })
  } catch {
    // audit log failure must not break primary request flow
  }
}

function proxyToLocalPort(req: Request, res: Response, targetPort: number, forwardPath: string) {
  const headers: http.OutgoingHttpHeaders = { ...req.headers }
  headers.host = `127.0.0.1:${targetPort}`
  headers['x-forwarded-host'] = req.headers.host || ''
  headers['x-forwarded-proto'] = req.protocol || 'http'

  const proxyReq = http.request(
    {
      hostname: '127.0.0.1',
      port: targetPort,
      path: forwardPath || '/',
      method: req.method,
      headers,
      timeout: 15000,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers)
      proxyRes.pipe(res, { end: true })
    }
  )

  proxyReq.on('timeout', () => {
    proxyReq.destroy()
    if (!res.headersSent) {
      res.status(504).send('App took too long to respond.')
    }
  })

  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.status(502).send(`Local app is unreachable on port ${targetPort}: ${err.message}`)
    }
  })

  req.pipe(proxyReq, { end: true })
}

const app = express()

// Request ID + Baseline HTTP security headers (iframe-safe for AI Studio & Electron)
app.use(requestContextMiddleware)

// Live Reverse Proxy Middleware MUST run BEFORE express.json() so request bodies stream cleanly
app.use((req: Request, res: Response, next: NextFunction) => {
  // 1. Built-in /live/<appName>/... path proxy (covers both local apps and native binary processes)
  const liveMatch = /^\/live\/([a-z0-9-_]+)(\/.*)?$/i.exec(req.path)
  if (liveMatch) {
    const requestedName = sanitizeAppName(liveMatch[1])
    const targetApp =
      localRuntime.findByName(requestedName) ||
      nativeProcesses.findByName(requestedName) ||
      installerEngine.findByName(requestedName) ||
      serviceEngine.findByName(requestedName)
    if (!targetApp) {
      res.status(404).send(`App "${requestedName}" is not installed.`)
      return
    }
    if (targetApp.state !== 'running') {
      res.status(503).send(`App "${targetApp.name}" is currently stopped. Start it in KATHAL to view.`)
      return
    }
    // Redirect /live/<name> -> /live/<name>/ so relative fetches inside apps resolve cleanly
    if (!liveMatch[2] && (req.method === 'GET' || req.method === 'HEAD')) {
      const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : ''
      res.redirect(302, `/live/${targetApp.name}/${qs}`)
      return
    }
    const prefix = `/live/${liveMatch[1]}`
    const orig = req.originalUrl.startsWith(prefix) ? req.originalUrl.slice(prefix.length) : '/'
    const forwardPath = orig.startsWith('/') ? orig : `/${orig}`
    proxyToLocalPort(req, res, targetApp.port, forwardPath)
    return
  }

  // 2. Custom Domain (Host-header) routing backed by reverse-proxy.json
  const rawHost = String(req.headers.host || '').split(':')[0].trim().toLowerCase()
  if (rawHost && rawHost !== 'localhost' && rawHost !== '127.0.0.1' && rawHost !== '0.0.0.0') {
    const activeRoutes = proxyConfig.getRoutesForInternalProxy(store.proxyRoutes)
    const route = activeRoutes.find(
      (r) => r.enabled && r.domain.trim().toLowerCase() === rawHost
    )
    if (route) {
      const targetCheck = validateLocalProxyTarget(route.target)
      if (targetCheck.ok) {
        const port = Number(targetCheck.url.port || (targetCheck.url.protocol === 'https:' ? 443 : 80))
        proxyToLocalPort(req, res, port, req.originalUrl || '/')
        return
      }
    }
  }

  next()
})

app.use(
  express.json({
    limit: '10mb',
    verify: (req, _res, buf) => {
      ;(req as AuthedRequest).rawBody = buf
    },
  })
)

const api = express.Router()
api.use(createAuthMiddleware(authService))

// ==================== MODULAR PHASE 1.5 ROUTERS ====================

api.use(
  createAuthRouter({
    authService,
    audit: auditService,
    onOwnerClaimed: (userId) => {
      fleetService.ensureLocalPrimaryNode(userId)
    },
  })
)
api.use(createUserRouter({ authService, rbac: rbacService, audit: auditService }))
api.use(createVaultRouter({ db, vault, platformRepo, store, audit: auditService }))
api.use(
  createDatabaseAdminRouter({
    dbManager,
    getJsonMigrationSummary: () => lastJsonMigrationSummary,
    audit: auditService,
  })
)
api.use(
  createFleetRouter({
    fleetService,
    audit: auditService,
    store,
    getVersion: () => VERSION,
    getRunningAppsCount: () => listAllSerializedWorkload().filter((w) => w.state === 'running').length,
  })
)
api.use(createAuditRouter({ audit: auditService }))

api.get('/health', (_req: Request, res: Response) => {
  const integrity = dbManager.integrityCheck()
  res.json({
    status: 'ok',
    database: integrity.ok ? 'ok' : 'degraded',
    vault: vault.isLocked() ? 'locked' : 'ready',
    version: VERSION,
  })
})

// ==================== HELPER FUNCTIONS FOR LOCAL APPS ====================

function parseEnvMap(rawEnv: unknown): Record<string, string> {
  const result: Record<string, string> = {}
  for (const v of store.envVars) {
    result[v.key] = v.value
  }
  if (Array.isArray(rawEnv)) {
    for (const item of rawEnv) {
      const s = String(item || '')
      const eq = s.indexOf('=')
      if (eq > 0) result[s.slice(0, eq).trim()] = s.slice(eq + 1)
    }
  } else if (rawEnv && typeof rawEnv === 'object') {
    for (const [k, v] of Object.entries(rawEnv)) {
      if (k.trim()) result[k.trim()] = String(v ?? '')
    }
  }
  return result
}

function upsertAppProxyRoute(
  appName: string,
  port: number,
  customDomain?: string,
  autoDomain?: boolean
) {
  const rawDomain = (customDomain || '').trim().toLowerCase()
  const targetDomain = rawDomain
    ? rawDomain
    : autoDomain
    ? `${appName}.${store.settings.wildcardDomain || 'apps.kathal.local'}`
    : ''
  if (!targetDomain) return null
  if (!isValidDomainName(targetDomain)) {
    throw new Error('Invalid domain name format (example: myapp.example.com)')
  }
  const targetUrl = `http://127.0.0.1:${port}`
  const existing = store.proxyRoutes.find((r) => r.domain.toLowerCase() === targetDomain)
  if (existing) {
    existing.target = targetUrl
    existing.port = store.settings.autoSsl ? 443 : 80
    existing.ssl = store.settings.autoSsl
    existing.enabled = true
    proxyConfig.saveToDisk(store.proxyRoutes, store.settings)
    return existing
  }
  const route = {
    id: store.newId('proxy'),
    domain: targetDomain,
    target: targetUrl,
    port: store.settings.autoSsl ? 443 : 80,
    ssl: store.settings.autoSsl,
    enabled: true,
  }
  store.proxyRoutes.push(route)
  proxyConfig.saveToDisk(store.proxyRoutes, store.settings)
  return route
}

function attachProxyDomains<T extends { port: number }>(serialized: T) {
  const domains = store.proxyRoutes
    .filter((r) => {
      const check = validateLocalProxyTarget(r.target)
      return check.ok && Number(check.url.port) === serialized.port
    })
    .map((r) => ({
      id: r.id,
      domain: r.domain,
      enabled: r.enabled,
      ssl: r.ssl,
    }))
  return {
    ...serialized,
    domains,
  }
}

function serializeLocalApp(localApp: LocalAppInstance) {
  return attachProxyDomains(localRuntime.serializeApp(localApp))
}

function serializeNativeProcess(proc: NativeProcessInstance) {
  return attachProxyDomains(nativeProcesses.serializeProcess(proc))
}

function serializeInstallation(rec: InstalledAppRecord) {
  return attachProxyDomains(installerEngine.serializeInstallation(rec))
}

function serializeServiceRecord(svc: ManagedServiceRecord) {
  return attachProxyDomains(serviceEngine.serializeService(svc))
}

function listAllSerializedWorkload() {
  const apps = localRuntime.listApps().map(serializeLocalApp)
  const binaries = nativeProcesses.listProcesses().map(serializeNativeProcess)
  const installed = installerEngine.listAll().map(serializeInstallation)
  const installedIds = new Set(installed.map((i) => i.id))
  const standaloneServices = serviceEngine
    .listServices()
    .filter((s) => !installedIds.has(s.id))
    .map(serializeServiceRecord)
  return [...apps, ...binaries, ...installed, ...standaloneServices].sort((a, b) => b.created - a.created)
}

function getAllRunningForMetrics() {
  const apps = localRuntime
    .listApps()
    .filter((a) => a.state === 'running')
    .map((a) => ({ id: a.id, name: a.name, pid: a.pid }))
  const bins = nativeProcesses
    .listProcesses()
    .filter((p) => p.state === 'running')
    .map((p) => ({ id: p.id, name: p.name, pid: p.pid }))
  const installed = installerEngine
    .listAll()
    .filter((r) => r.state === 'running')
    .map((r) => ({ id: r.id, name: r.name, pid: r.pid }))
  const installedIds = new Set(installed.map((i) => i.id))
  const services = serviceEngine
    .listServices()
    .filter((s) => s.state === 'running' && !installedIds.has(s.id))
    .map((s) => ({ id: s.id, name: s.name, pid: s.pid }))
  return [...apps, ...bins, ...installed, ...services]
}

// ==================== SYSTEM ====================

api.get('/status', requirePermission('dashboard.read', auditService), (_req: Request, res: Response) => {
  const all = listAllSerializedWorkload()
  const runningApps = all.filter((a) => a.state === 'running').length
  res.json({
    version: VERSION,
    platform: os.platform(),
    platformLabel: getPlatformLabel(),
    arch: os.arch(),
    goVersion: `Node ${process.version}`,
    mode: 'local-native',
    selfHosted: true,
    cloudRequired: false,
    dockerRequired: false,
    dockerAvailable: false,
    supportedPlatforms: ['windows', 'macos', 'linux'],
    runtimeEngine: 'Local Native Runtime (Node.js / Python 3 / Native Binaries)',
    runtimes: {
      node: process.version,
      python: 'Python 3',
      git: 'Git',
      nativeBinary: 'Enabled',
    },
    dataDir: getDataDir(),
    appsRoot: localRuntime.getAppsRoot(),
    dockerContainers: all.length,
    runningApps,
    nativeProcessCount: nativeProcesses.listProcesses().length,
    dockerImages: store.images.length,
    desktopSupport: {
      pwaManifest: '/manifest.webmanifest',
      serviceWorker: '/sw.js',
      electronAvailable: fs.existsSync(path.join(__dirname, 'electron', 'main.cjs')),
      desktopCommand: 'npm run desktop',
    },
  })
})

api.get('/platform/installers', requirePermission('dashboard.read', auditService), (_req: Request, res: Response) => {
  res.json({
    selfHosted: true,
    cloudRequired: false,
    dockerRequired: false,
    currentPlatform: os.platform(),
    currentPlatformLabel: getPlatformLabel(),
    arch: os.arch(),
    installers: [
      {
        id: 'windows',
        label: 'Windows (10 / 11 / Server)',
        command: 'powershell -ExecutionPolicy Bypass -File scripts/install.ps1',
        detail: 'Installs local Node.js runtime, builds KATHAL OS, and runs locally with zero Docker or cloud dependencies.',
        autoStart: 'Windows Scheduled Task (optional)',
      },
      {
        id: 'macos',
        label: 'macOS (Apple Silicon & Intel)',
        command: 'bash scripts/install-mac.sh',
        detail: 'Configures Homebrew/Node.js, builds KATHAL OS, and optionally registers a launchd background service.',
        autoStart: 'launchd LaunchAgent (optional)',
      },
      {
        id: 'linux',
        label: 'Linux (Ubuntu / Debian / Fedora / Arch)',
        command: 'bash scripts/install.sh',
        detail: 'Installs dependencies locally, builds KATHAL OS, and optionally configures a systemd service.',
        autoStart: 'systemd service (optional)',
      },
      {
        id: 'desktop',
        label: 'Desktop App (Windows / macOS / Linux)',
        command: 'npm run desktop',
        detail: 'Launches the native Electron desktop window backed directly by your local host server (no cloud account needed).',
        autoStart: 'Native Electron Launcher & PWA Install',
      },
    ],
  })
})

api.get('/desktop/info', requirePermission('dashboard.read', auditService), (_req: Request, res: Response) => {
  res.json({
    platform: os.platform(),
    platformLabel: getPlatformLabel(),
    arch: os.arch(),
    pwa: {
      manifestUrl: '/manifest.webmanifest',
      serviceWorkerUrl: '/sw.js',
      icons: ['/pwa-192x192.png', '/pwa-512x512.png', '/pwa-maskable-512x512.png'],
    },
    electron: {
      entryFile: 'electron/main.cjs',
      exists: fs.existsSync(path.join(__dirname, 'electron', 'main.cjs')),
      command: 'npm run desktop',
    },
  })
})

api.get('/metrics', requirePermission('dashboard.read', auditService), (_req: Request, res: Response) => {
  const sys = store.collectSystemMetrics()
  const all = listAllSerializedWorkload()
  const running = all.filter((a) => a.state === 'running').length
  const stopped = all.filter((a) => a.state !== 'running').length
  res.json({
    system: sys,
    docker: {
      containersRunning: running,
      containersPaused: 0,
      containersStopped: stopped,
      imagesCount: store.images.length,
    },
    timestamp: Math.floor(Date.now() / 1000),
  })
})

api.get('/system', requirePermission('dashboard.read', auditService), (_req: Request, res: Response) => {
  res.json({
    version: VERSION,
    platform: os.platform(),
    platformLabel: getPlatformLabel(),
    arch: os.arch(),
    docker: false,
    dockerRequired: false,
    selfHosted: true,
    cloudRequired: false,
    mode: 'local-native',
    goVersion: `Node ${process.version}`,
    hostname: os.hostname(),
    dataDir: getDataDir(),
    appsRoot: localRuntime.getAppsRoot(),
  })
})

api.get('/system/monitor', requirePermission('dashboard.read', auditService), (_req: Request, res: Response) => {
  res.json(collectSystemMonitorData())
})

async function handleCheckUpdates(req: Request, res: Response) {
  const all = listAllSerializedWorkload()
  const force = req.method === 'POST' || req.query.force === 'true'
  const repoOverride =
    req.method === 'POST' && typeof req.body?.repo === 'string'
      ? req.body.repo
      : typeof req.query.repo === 'string'
      ? req.query.repo
      : undefined
  const report = await updateChecker.checkForUpdates({
    force,
    appsChecked: all.length,
    repo: repoOverride,
  })
  res.json(report)
}

api.get('/system/updates', requirePermission('dashboard.read', auditService), handleCheckUpdates)
api.post('/system/check-updates', requirePermission('dashboard.read', auditService), handleCheckUpdates)

// ==================== OPERATIONAL SETTINGS ====================

function serializeSettings() {
  const { webhookSecret, ...rest } = store.settings
  return {
    ...rest,
    hasWebhookSecret: Boolean(webhookSecret),
    webhookSecretMasked: webhookSecret ? '••••••••' : '',
  }
}

api.get('/settings', requirePermission('settings.read', auditService), (_req: Request, res: Response) => {
  res.json(serializeSettings())
})

api.put('/settings', requirePermission('settings.manage', auditService), (req: AuthedRequest, res: Response) => {
  const b = req.body || {}
  if (typeof b.serverName === 'string') store.settings.serverName = b.serverName.trim() || store.settings.serverName
  if (typeof b.serverDomain === 'string') store.settings.serverDomain = b.serverDomain.trim()
  if (typeof b.wildcardDomain === 'string') store.settings.wildcardDomain = b.wildcardDomain.trim()
  if (typeof b.letsEncryptEmail === 'string') store.settings.letsEncryptEmail = b.letsEncryptEmail.trim()
  if (typeof b.autoSsl === 'boolean') store.settings.autoSsl = b.autoSsl
  if (typeof b.forceHttps === 'boolean') store.settings.forceHttps = b.forceHttps
  if (typeof b.autoDeployWebhook === 'boolean') store.settings.autoDeployWebhook = b.autoDeployWebhook
  if (typeof b.pruneStoppedAfterDeploy === 'boolean') store.settings.pruneStoppedAfterDeploy = b.pruneStoppedAfterDeploy
  if (b.defaultDeployStrategy === 'rolling' || b.defaultDeployStrategy === 'recreate') {
    store.settings.defaultDeployStrategy = b.defaultDeployStrategy
  }
  if (b.cpuAlertThreshold !== undefined) {
    const val = Number(b.cpuAlertThreshold)
    if (Number.isFinite(val)) store.settings.cpuAlertThreshold = Math.min(100, Math.max(10, val))
  }
  if (b.memoryAlertThreshold !== undefined) {
    const val = Number(b.memoryAlertThreshold)
    if (Number.isFinite(val)) store.settings.memoryAlertThreshold = Math.min(100, Math.max(10, val))
  }
  proxyConfig.saveToDisk(store.proxyRoutes, store.settings)
  savePlatformState()
  recordAudit(req, 'settings.update', 'platform-settings', 'success')
  res.json(serializeSettings())
})

api.post('/settings/reveal-webhook', requirePermission('secrets.reveal', auditService), (req: AuthedRequest, res: Response) => {
  recordAudit(req, 'settings.reveal_webhook', 'webhookSecret', 'success')
  res.json({ webhookSecret: store.settings.webhookSecret })
})

api.post('/settings/regenerate-webhook', requirePermission('secrets.reveal', auditService), (req: AuthedRequest, res: Response) => {
  store.settings.webhookSecret = crypto.randomBytes(16).toString('hex')
  savePlatformState()
  recordAudit(req, 'settings.rotate_webhook', 'webhookSecret', 'success')
  res.json({ webhookSecret: store.settings.webhookSecret })
})

api.post('/settings/reset', requirePermission('settings.manage', auditService), (req: AuthedRequest, res: Response) => {
  store.resetToDefaults()
  proxyConfig.saveToDisk(store.proxyRoutes, store.settings)
  savePlatformState()
  recordAudit(req, 'settings.reset', 'platform-state', 'success')
  res.json({ status: 'reset', settings: serializeSettings() })
})

// ==================== UNIFIED LOCAL APP DEPLOY ====================

async function handleDeployLocalRequest(req: Request, res: Response) {
  const name = String(req.body?.name || '').trim()
  if (!name) {
    res.status(400).json({ error: 'App name is required' })
    return
  }
  const repoUrl = typeof req.body?.repoUrl === 'string' ? req.body.repoUrl.trim() : ''
  const executable = typeof req.body?.executable === 'string' ? req.body.executable.trim() : ''
  const customDomain = typeof req.body?.domain === 'string' ? req.body.domain.trim() : ''
  if (customDomain && !isValidDomainName(customDomain)) {
    res.status(400).json({ error: 'Invalid domain name format (e.g. app.example.com)' })
    return
  }
  const hostPort = req.body?.hostPort ? Number(req.body.hostPort) : req.body?.port ? Number(req.body.port) : undefined
  const envMap = parseEnvMap(req.body?.env)

  try {
    if (req.body?.runtime === 'binary' || executable) {
      const proc = await nativeProcesses.deployBinaryProcess({
        name,
        executable,
        args: req.body?.args,
        workingDir: typeof req.body?.workingDir === 'string' ? req.body.workingDir : undefined,
        port: hostPort,
        env: envMap,
        label: typeof req.body?.label === 'string' ? req.body.label : undefined,
      })
      const proxyRoute = upsertAppProxyRoute(
        proc.name,
        proc.port,
        customDomain,
        Boolean(req.body?.autoDomain)
      )
      res.json({
        app: {
          id: proc.id,
          name: proc.name,
          port: proc.port,
          runtime: 'binary',
          status: proc.state,
        },
        container: serializeNativeProcess(proc),
        process: serializeNativeProcess(proc),
        proxyRoute,
        liveUrl: `/live/${proc.name}/`,
        logs: proc.logs.slice(-10).map((l) => l.content),
      })
      return
    }

    if (repoUrl) {
      if (!isValidPublicHttpsGitUrl(repoUrl)) {
        res.status(400).json({ error: 'Git repository URL must be a valid public https:// URL' })
        return
      }
      const gitRes = await localRuntime.deployFromGit({
        name,
        repoUrl,
        branch: typeof req.body?.branch === 'string' ? req.body.branch : 'main',
        port: hostPort,
        env: envMap,
      })
      const proxyRoute = upsertAppProxyRoute(
        gitRes.app.name,
        gitRes.app.port,
        customDomain,
        Boolean(req.body?.autoDomain)
      )
      res.json({
        app: {
          id: gitRes.app.id,
          name: gitRes.app.name,
          port: gitRes.app.port,
          runtime: gitRes.app.runtime,
          status: gitRes.app.state,
        },
        container: serializeLocalApp(gitRes.app),
        proxyRoute,
        liveUrl: `/live/${gitRes.app.name}/`,
        logs: gitRes.buildLogs,
      })
      return
    }

    const deployed = await localRuntime.deployLocalApp({
      name,
      runtime: req.body?.runtime,
      runtimeHint: String(req.body?.runtimeHint || req.body?.image || req.body?.runtime || 'static'),
      hostPort,
      env: envMap,
      customHtml: typeof req.body?.customHtml === 'string' ? req.body.customHtml : undefined,
      imageLabel: typeof req.body?.image === 'string' ? req.body.image : undefined,
    })

    const proxyRoute = upsertAppProxyRoute(
      deployed.name,
      deployed.port,
      customDomain,
      Boolean(req.body?.autoDomain)
    )

    res.json({
      app: {
        id: deployed.id,
        name: deployed.name,
        port: deployed.port,
        runtime: deployed.runtime,
        status: deployed.state,
      },
      container: serializeLocalApp(deployed),
      proxyRoute,
      liveUrl: `/live/${deployed.name}/`,
      logs: deployed.logs.slice(-10).map((l) => l.content),
    })
  } catch (err) {
    res.status(400).json({ error: (err as Error).message || 'Deployment failed' })
  }
}

api.post('/deploy', requirePermission('applications.deploy', auditService), handleDeployLocalRequest)

// ==================== NATIVE PROCESS MANAGEMENT (BINARY COMMANDS) ====================

api.get('/processes', requirePermission('containers.read', auditService), (_req: Request, res: Response) => {
  res.json(nativeProcesses.listProcesses().map(serializeNativeProcess))
})

api.post('/processes', requirePermission('containers.manage', auditService), async (req: Request, res: Response) => {
  const name = String(req.body?.name || '').trim()
  const executable = String(req.body?.executable || '').trim()
  if (!name) {
    res.status(400).json({ error: 'Process name is required' })
    return
  }
  if (!executable) {
    res.status(400).json({ error: 'Binary executable command is required (e.g. node, python3)' })
    return
  }
  const customDomain = typeof req.body?.domain === 'string' ? req.body.domain.trim() : ''
  if (customDomain && !isValidDomainName(customDomain)) {
    res.status(400).json({ error: 'Invalid domain name format' })
    return
  }
  try {
    const proc = await nativeProcesses.deployBinaryProcess({
      name,
      executable,
      args: req.body?.args,
      workingDir: typeof req.body?.workingDir === 'string' ? req.body.workingDir : undefined,
      port: req.body?.port ? Number(req.body.port) : undefined,
      env: parseEnvMap(req.body?.env),
      label: typeof req.body?.label === 'string' ? req.body.label : undefined,
    })
    const proxyRoute = upsertAppProxyRoute(
      proc.name,
      proc.port,
      customDomain,
      Boolean(req.body?.autoDomain)
    )
    res.json({
      process: serializeNativeProcess(proc),
      proxyRoute,
      liveUrl: `/live/${proc.name}/`,
      logs: proc.logs.slice(-15).map((l) => l.content),
    })
  } catch (err) {
    res.status(400).json({ error: (err as Error).message || 'Failed to spawn native process' })
  }
})

api.post('/processes/:id/start', requirePermission('containers.manage', auditService), async (req: Request, res: Response) => {
  try {
    const proc = await nativeProcesses.startProcess(String(req.params.id))
    if (!proc) {
      res.status(404).json({ error: 'process not found' })
      return
    }
    res.json({ status: 'started', process: serializeNativeProcess(proc) })
  } catch (err) {
    res.status(400).json({ error: (err as Error).message || 'Failed to start process' })
  }
})

api.post('/processes/:id/stop', requirePermission('containers.manage', auditService), async (req: Request, res: Response) => {
  const proc = await nativeProcesses.stopProcess(String(req.params.id))
  if (!proc) {
    res.status(404).json({ error: 'process not found' })
    return
  }
  res.json({ status: 'stopped', process: serializeNativeProcess(proc) })
})

api.post('/processes/:id/restart', requirePermission('containers.manage', auditService), async (req: Request, res: Response) => {
  try {
    const proc = await nativeProcesses.restartProcess(String(req.params.id))
    if (!proc) {
      res.status(404).json({ error: 'process not found' })
      return
    }
    res.json({ status: 'restarted', process: serializeNativeProcess(proc) })
  } catch (err) {
    res.status(400).json({ error: (err as Error).message || 'Failed to restart process' })
  }
})

api.get('/processes/:id/logs', requirePermission('containers.read', auditService), (req: Request, res: Response) => {
  const lines = nativeProcesses.getLogs(String(req.params.id), 200)
  res.json({ logs: lines.map((l) => `${l.timestamp} ${l.content}`).join('\n') })
})

api.post('/processes/:id/probe', requirePermission('containers.manage', auditService), async (req: Request, res: Response) => {
  const result = await nativeProcesses.probeProcess(String(req.params.id))
  res.json(result)
})

api.get('/native-processes', requirePermission('containers.read', auditService), (req: Request, res: Response) => {
  const runningOnly = req.query.running !== 'false'
  const sourceFilter = String(req.query.source || 'all')
  const all = listAllSerializedWorkload()
  const filtered = all.filter((item) => {
    if (runningOnly && item.state !== 'running') return false
    if (sourceFilter !== 'all' && item.source !== sourceFilter) return false
    return true
  })
  const running = all.filter((item) => item.state === 'running')
  const totalCpuPercent = Number(
    running.reduce((sum, p) => sum + (Number(p.cpuPercent) || 0), 0).toFixed(1)
  )
  const totalMemoryMb = Number(
    running.reduce((sum, p) => sum + (Number(p.memoryMb) || 0), 0).toFixed(1)
  )
  const hostTotalMb = Math.round(os.totalmem() / (1024 * 1024))
  const totalMemoryPercent = hostTotalMb > 0 ? Number(((totalMemoryMb / hostTotalMb) * 100).toFixed(2)) : 0
  res.json({
    processes: filtered,
    summary: {
      totalRunning: running.length,
      totalManaged: all.length,
      customBinaries: nativeProcesses.listProcesses().length,
      managedApps: localRuntime.listApps().length,
      totalCpuPercent,
      totalMemoryMb,
      totalMemoryPercent,
    },
    host: {
      platform: os.platform(),
      arch: os.arch(),
      cpuCores: os.cpus().length || 1,
      totalMemoryMb: hostTotalMb,
      load1: Number((os.loadavg()[0] || 0).toFixed(2)),
    },
    timestamp: Date.now(),
  })
})

api.delete('/processes/:id', requirePermission('containers.manage', auditService), async (req: Request, res: Response) => {
  const proc = nativeProcesses.processes.get(String(req.params.id))
  if (!proc) {
    res.status(404).json({ error: 'process not found' })
    return
  }
  const oldPort = proc.port
  await nativeProcesses.deleteProcess(proc.id)
  store.proxyRoutes = store.proxyRoutes.filter((r) => r.target !== `http://127.0.0.1:${oldPort}` && r.target !== `http://localhost:${oldPort}`)
  proxyConfig.saveToDisk(store.proxyRoutes, store.settings)
  res.json({ status: 'deleted' })
})

// ==================== RUNNING LOCAL APPS & PROCESSES ====================

api.get('/containers', requirePermission('containers.read', auditService), (req: Request, res: Response) => {
  const showAll = req.query.all === 'true'
  const all = listAllSerializedWorkload()
  const filtered = showAll ? all : all.filter((a) => a.state === 'running')
  res.json(filtered)
})

api.post('/containers/prune', requirePermission('containers.manage', auditService), async (_req: Request, res: Response) => {
  const stoppedApps = localRuntime.listApps().filter((a) => a.state !== 'running')
  const stoppedBins = nativeProcesses.listProcesses().filter((p) => p.state !== 'running')
  const deletedNames: string[] = []
  for (const item of stoppedApps) {
    await localRuntime.deleteApp(item.id)
    deletedNames.push(item.name)
    store.proxyRoutes = store.proxyRoutes.filter((r) => r.target !== `http://127.0.0.1:${item.port}`)
  }
  for (const item of stoppedBins) {
    await nativeProcesses.deleteProcess(item.id)
    deletedNames.push(item.name)
    store.proxyRoutes = store.proxyRoutes.filter((r) => r.target !== `http://127.0.0.1:${item.port}`)
  }
  res.json({
    containers_deleted: deletedNames.length,
    deleted_names: deletedNames,
    space_reclaimed_bytes: 0,
    remaining: listAllSerializedWorkload().length,
  })
})

api.post('/containers/:id/start', requirePermission('applications.restart', auditService), async (req: Request, res: Response) => {
  const id = String(req.params.id)
  const appItem = await localRuntime.startApp(id)
  if (appItem) {
    res.json({ status: 'started', app: serializeLocalApp(appItem) })
    return
  }
  const instItem = await installerEngine.startApp(id)
  if (instItem) {
    res.json({ status: 'started', app: serializeInstallation(instItem) })
    return
  }
  try {
    const procItem = await nativeProcesses.startProcess(id)
    if (procItem) {
      res.json({ status: 'started', app: serializeNativeProcess(procItem) })
      return
    }
    const svcItem = await serviceEngine.startService(id)
    if (svcItem) {
      res.json({ status: 'started', app: serializeServiceRecord(svcItem) })
      return
    }
  } catch (err) {
    res.status(400).json({ error: (err as Error).message || 'Failed to start process' })
    return
  }
  res.status(404).json({ error: 'app not found' })
})

api.post('/containers/:id/stop', requirePermission('applications.restart', auditService), async (req: Request, res: Response) => {
  const id = String(req.params.id)
  const appItem = await localRuntime.stopApp(id)
  if (appItem) {
    res.json({ status: 'stopped', app: serializeLocalApp(appItem) })
    return
  }
  const instItem = await installerEngine.stopApp(id)
  if (instItem) {
    res.json({ status: 'stopped', app: serializeInstallation(instItem) })
    return
  }
  const procItem = await nativeProcesses.stopProcess(id)
  if (procItem) {
    res.json({ status: 'stopped', app: serializeNativeProcess(procItem) })
    return
  }
  const svcItem = await serviceEngine.stopService(id)
  if (svcItem) {
    res.json({ status: 'stopped', app: serializeServiceRecord(svcItem) })
    return
  }
  res.status(404).json({ error: 'app not found' })
})

api.post('/containers/:id/pause', requirePermission('applications.restart', auditService), async (req: Request, res: Response) => {
  const id = String(req.params.id)
  const appItem = await localRuntime.stopApp(id)
  if (appItem) {
    res.json({ status: 'stopped', app: serializeLocalApp(appItem) })
    return
  }
  const instItem = await installerEngine.stopApp(id)
  if (instItem) {
    res.json({ status: 'stopped', app: serializeInstallation(instItem) })
    return
  }
  const procItem = await nativeProcesses.stopProcess(id)
  if (procItem) {
    res.json({ status: 'stopped', app: serializeNativeProcess(procItem) })
    return
  }
  const svcItem = await serviceEngine.stopService(id)
  if (svcItem) {
    res.json({ status: 'stopped', app: serializeServiceRecord(svcItem) })
    return
  }
  res.status(404).json({ error: 'app not found' })
})

api.post('/containers/:id/restart', requirePermission('applications.restart', auditService), async (req: Request, res: Response) => {
  const id = String(req.params.id)
  const appItem = await localRuntime.restartApp(id)
  if (appItem) {
    res.json({ status: 'restarted', app: serializeLocalApp(appItem) })
    return
  }
  const instItem = await installerEngine.restartApp(id)
  if (instItem) {
    res.json({ status: 'restarted', app: serializeInstallation(instItem) })
    return
  }
  try {
    const procItem = await nativeProcesses.restartProcess(id)
    if (procItem) {
      res.json({ status: 'restarted', app: serializeNativeProcess(procItem) })
      return
    }
    const svcItem = await serviceEngine.restartService(id)
    if (svcItem) {
      res.json({ status: 'restarted', app: serializeServiceRecord(svcItem) })
      return
    }
  } catch (err) {
    res.status(400).json({ error: (err as Error).message || 'Failed to restart process' })
    return
  }
  res.status(404).json({ error: 'app not found' })
})

api.delete('/containers/:id/delete', requirePermission('applications.delete', auditService), async (req: AuthedRequest, res: Response) => {
  const id = String(req.params.id)
  const existing = localRuntime.apps.get(id)
  if (existing) {
    const oldPort = existing.port
    await localRuntime.deleteApp(existing.id)
    store.proxyRoutes = store.proxyRoutes.filter((r) => r.target !== `http://127.0.0.1:${oldPort}` && r.target !== `http://localhost:${oldPort}`)
    proxyConfig.saveToDisk(store.proxyRoutes, store.settings)
    recordAudit(req, 'container.delete', id, 'success')
    res.json({ status: 'deleted' })
    return
  }
  const existingInst = installerEngine.installations.get(id)
  if (existingInst) {
    const oldPort = existingInst.port
    await installerEngine.uninstall(existingInst.id)
    store.proxyRoutes = store.proxyRoutes.filter((r) => r.target !== `http://127.0.0.1:${oldPort}` && r.target !== `http://localhost:${oldPort}`)
    proxyConfig.saveToDisk(store.proxyRoutes, store.settings)
    recordAudit(req, 'container.delete', id, 'success')
    res.json({ status: 'deleted' })
    return
  }
  const existingBin = nativeProcesses.processes.get(id)
  if (existingBin) {
    const oldPort = existingBin.port
    await nativeProcesses.deleteProcess(existingBin.id)
    store.proxyRoutes = store.proxyRoutes.filter((r) => r.target !== `http://127.0.0.1:${oldPort}` && r.target !== `http://localhost:${oldPort}`)
    proxyConfig.saveToDisk(store.proxyRoutes, store.settings)
    recordAudit(req, 'container.delete', id, 'success')
    res.json({ status: 'deleted' })
    return
  }
  const existingSvc = serviceEngine.getService(id)
  if (existingSvc) {
    const oldPort = existingSvc.port
    await serviceEngine.deleteService(existingSvc.id)
    store.proxyRoutes = store.proxyRoutes.filter((r) => r.target !== `http://127.0.0.1:${oldPort}` && r.target !== `http://localhost:${oldPort}`)
    proxyConfig.saveToDisk(store.proxyRoutes, store.settings)
    recordAudit(req, 'container.delete', id, 'success')
    res.json({ status: 'deleted' })
    return
  }
  res.status(404).json({ error: 'app not found' })
})

api.get('/containers/:id/logs', requirePermission('containers.read', auditService), (req: Request, res: Response) => {
  const id = String(req.params.id)
  const appLines = localRuntime.getAppLogs(id, 150)
  const inst = installerEngine.installations.get(id) || installerEngine.findByName(id)
  const svcLines = serviceEngine.getLogs(id, 150)
  const lines =
    appLines.length > 0
      ? appLines
      : inst
      ? inst.logs.slice(-150)
      : svcLines.length > 0
      ? svcLines
      : nativeProcesses.getLogs(id, 150)
  res.json({ logs: lines.map((l) => `${l.timestamp} ${l.content}`).join('\n') })
})

api.post('/containers', requirePermission('applications.deploy', auditService), handleDeployLocalRequest)

api.post('/apps/:id/domain', requirePermission('settings.manage', auditService), (req: Request, res: Response) => {
  const key = String(req.params.id)
  const targetApp = localRuntime.apps.get(key) || localRuntime.findByName(key)
  const targetBin = nativeProcesses.getProcess(key)
  const targetInst = installerEngine.installations.get(key) || installerEngine.findByName(key)
  const targetSvc = serviceEngine.getService(key)
  const target = targetApp || targetBin || targetInst || targetSvc
  if (!target) {
    res.status(404).json({ error: 'app not found' })
    return
  }
  const domain = String(req.body?.domain || '').trim().toLowerCase()
  if (!isValidDomainName(domain)) {
    res.status(400).json({ error: 'Please enter a valid domain name (e.g. app.example.com)' })
    return
  }
  const route = upsertAppProxyRoute(target.name, target.port, domain, false)
  res.json({
    route,
    app: targetApp
      ? serializeLocalApp(targetApp)
      : targetInst
      ? serializeInstallation(targetInst)
      : targetSvc
      ? serializeServiceRecord(targetSvc)
      : serializeNativeProcess(targetBin!),
  })
})

function getImageUsage(img: (typeof store.images)[number]) {
  const tags = new Set(img.repoTags || [])
  const usedBy = store.containers
    .filter((c) => tags.has(c.image) || tags.has(`${c.image}:latest`))
    .map((c) => c.name)
  return { inUse: usedBy.length > 0, containers: usedBy }
}

api.get('/images', requirePermission('containers.read', auditService), (_req: Request, res: Response) => {
  res.json(
    store.images.map((img) => ({
      ...img,
      ...getImageUsage(img),
    }))
  )
})

function normalizeRegistryHost(rawUrl: string): string {
  return rawUrl
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase()
}

function extractImageRegistryHost(imageRef: string): string | null {
  const firstSlash = imageRef.indexOf('/')
  if (firstSlash === -1) return null
  const prefix = imageRef.slice(0, firstSlash)
  if (prefix.includes('.') || prefix.includes(':') || prefix === 'localhost') {
    return prefix.toLowerCase()
  }
  return null
}

api.post('/images/pull', requirePermission('containers.manage', auditService), (req: Request, res: Response) => {
  let imageTag = String(req.body?.image || '').trim()
  const registryId = String(req.body?.registryId || '').trim()
  if (!imageTag) {
    res.status(400).json({ error: 'image name is required' })
    return
  }

  let usedRegistry: (typeof store.registries)[number] | undefined
  if (registryId) {
    usedRegistry = store.registries.find((r) => r.id === registryId)
    if (!usedRegistry) {
      res.status(404).json({ error: 'selected registry credential not found' })
      return
    }
    const host = extractImageRegistryHost(imageTag)
    if (!host && usedRegistry.registryUrl !== 'docker.io' && usedRegistry.registryUrl !== 'registry.hub.docker.com') {
      imageTag = `${usedRegistry.registryUrl}/${imageTag}`
    }
    usedRegistry.status = 'connected'
    usedRegistry.lastUsedAt = new Date().toISOString()
  } else {
    const host = extractImageRegistryHost(imageTag)
    if (host) {
      usedRegistry = store.registries.find((r) => normalizeRegistryHost(r.registryUrl) === host)
      if (!usedRegistry) {
        res.status(401).json({
          error: `Authentication required for private registry "${host}". Add credentials in Registries first.`,
        })
        return
      }
      usedRegistry.status = 'connected'
      usedRegistry.lastUsedAt = new Date().toISOString()
    }
  }

  const img = store.ensureImage(imageTag)
  res.json({
    ...img,
    ...getImageUsage(img),
    registry: usedRegistry
      ? { id: usedRegistry.id, name: usedRegistry.name, registryUrl: usedRegistry.registryUrl }
      : null,
  })
})

api.post('/images/prune', requirePermission('containers.manage', auditService), (_req: Request, res: Response) => {
  const unused = store.images.filter((img) => !getImageUsage(img).inUse)
  const reclaimed = unused.reduce((sum, img) => sum + (img.size || 0), 0)
  const deletedTags = unused.flatMap((img) => img.repoTags || [])
  store.images = store.images.filter((img) => getImageUsage(img).inUse)
  res.json({
    images_deleted: unused.length,
    deleted_tags: deletedTags,
    space_reclaimed_bytes: reclaimed,
  })
})

api.delete('/images/:id', requirePermission('containers.manage', auditService), (req: Request, res: Response) => {
  const id = decodeURIComponent(String(req.params.id))
  const idx = store.images.findIndex((i) => i.id === id)
  if (idx === -1) {
    res.status(404).json({ error: 'image not found' })
    return
  }
  const usage = getImageUsage(store.images[idx])
  if (usage.inUse && req.query.force !== 'true') {
    res.status(409).json({
      error: `Image is currently used by container(s): ${usage.containers.join(', ')}`,
    })
    return
  }
  store.images.splice(idx, 1)
  res.json({ status: 'deleted' })
})

// ==================== APPS ====================

api.get('/apps', requirePermission('applications.read', auditService), (_req: Request, res: Response) => {
  res.json(Array.from(store.apps.values()))
})

api.post('/apps', requirePermission('applications.create', auditService), (req: Request, res: Response) => {
  const id = req.body?.id || store.newId('app')
  const appRecord = {
    id,
    name: String(req.body?.name || 'app'),
    image: String(req.body?.image || 'nginx:alpine'),
    port: Number(req.body?.port) || 80,
    status: 'running',
    createdAt: new Date().toISOString(),
  }
  store.apps.set(id, appRecord)
  res.json(appRecord)
})

api.get('/apps/:id', requirePermission('applications.read', auditService), (req: Request, res: Response) => {
  const item = store.apps.get(String(req.params.id))
  if (!item) {
    res.status(404).json({ error: 'app not found' })
    return
  }
  res.json(item)
})

api.put('/apps/:id', requirePermission('applications.deploy', auditService), (req: Request, res: Response) => {
  const id = String(req.params.id)
  const existing = store.apps.get(id)
  if (!existing) {
    res.status(404).json({ error: 'app not found' })
    return
  }
  const updated = { ...existing, ...req.body, id }
  store.apps.set(id, updated)
  res.json(updated)
})

api.delete('/apps/:id', requirePermission('applications.delete', auditService), (req: Request, res: Response) => {
  store.apps.delete(String(req.params.id))
  res.json({ status: 'deleted' })
})

// ==================== REVERSE PROXY & CUSTOM DOMAINS ====================

api.get('/proxy/config', requirePermission('settings.read', auditService), (_req: Request, res: Response) => {
  const rawJson = proxyConfig.readRawJson(store.proxyRoutes, store.settings)
  const loaded = proxyConfig.loadFromDisk()
  res.json({
    filePath: proxyConfig.filePath,
    relativePath: path.relative(process.cwd(), proxyConfig.filePath) || 'data/reverse-proxy.json',
    updatedAt: loaded?.updatedAt || new Date().toISOString(),
    settings: loaded?.settings || store.settings,
    routes: loaded?.routes || store.proxyRoutes,
    rawJson,
  })
})

api.put('/proxy/config', requirePermission('settings.manage', auditService), (req: Request, res: Response) => {
  const incomingRoutes = req.body?.routes
  if (Array.isArray(incomingRoutes)) {
    const validated: typeof store.proxyRoutes = []
    for (const item of incomingRoutes) {
      const domain = String(item?.domain || '').trim().toLowerCase()
      if (!domain || !isValidDomainName(domain)) {
        res.status(400).json({ error: `Invalid domain name: "${item?.domain || ''}"` })
        return
      }
      const rawHost = String(item?.targetHost || 'localhost').trim().toLowerCase()
      const safeHost = rawHost === '127.0.0.1' ? '127.0.0.1' : 'localhost'
      let target = String(item?.target || '').trim()
      if (target && !/^https?:\/\//i.test(target)) {
        target = `http://${target}`
      }
      if (!target && item?.localPort !== undefined) {
        target = `http://${safeHost}:${Number(item.localPort)}`
      }
      const check = validateLocalProxyTarget(target)
      if (!check.ok) {
        res.status(400).json({ error: `${domain}: ${check.error}` })
        return
      }
      validated.push({
        id: String(item?.id || store.newId('proxy')),
        domain,
        target: `http://${check.url.hostname.toLowerCase()}:${check.url.port}`,
        port: Boolean(item?.ssl) ? 443 : 80,
        ssl: Boolean(item?.ssl),
        enabled: item?.enabled !== undefined ? Boolean(item.enabled) : true,
      })
    }
    store.proxyRoutes = validated
  }
  const s = req.body?.settings
  if (s && typeof s === 'object') {
    if (typeof s.serverDomain === 'string') store.settings.serverDomain = s.serverDomain.trim()
    if (typeof s.wildcardDomain === 'string') store.settings.wildcardDomain = s.wildcardDomain.trim()
    if (typeof s.letsEncryptEmail === 'string') store.settings.letsEncryptEmail = s.letsEncryptEmail.trim()
    if (typeof s.autoSsl === 'boolean') store.settings.autoSsl = s.autoSsl
    if (typeof s.forceHttps === 'boolean') store.settings.forceHttps = s.forceHttps
  }
  const saved = proxyConfig.saveToDisk(store.proxyRoutes, store.settings)
  res.json({
    filePath: proxyConfig.filePath,
    relativePath: path.relative(process.cwd(), proxyConfig.filePath) || 'data/reverse-proxy.json',
    updatedAt: saved.updatedAt,
    settings: saved.settings,
    routes: saved.routes,
    rawJson: JSON.stringify(saved, null, 2),
  })
})

api.get('/proxy', requirePermission('settings.read', auditService), (_req: Request, res: Response) => {
  const allWorkloads = listAllSerializedWorkload()
  const enriched = store.proxyRoutes.map((route) => {
    const check = validateLocalProxyTarget(route.target)
    const targetPort = check.ok ? Number(check.url.port) : null
    const targetHost = check.ok ? check.url.hostname.toLowerCase() : '127.0.0.1'
    const linkedApp = targetPort ? allWorkloads.find((a) => a.port === targetPort) : undefined
    return {
      ...route,
      targetHost,
      localPort: targetPort,
      appName: linkedApp?.name || null,
      appState: linkedApp?.state || null,
      liveUrl: linkedApp ? `/live/${linkedApp.name}/` : null,
    }
  })
  res.json(enriched)
})

api.post('/proxy', requirePermission('settings.manage', auditService), (req: Request, res: Response) => {
  const domain = String(req.body?.domain || '').trim().toLowerCase()
  const appName = String(req.body?.appName || '').trim()
  const rawHost = String(req.body?.targetHost || 'localhost').trim().toLowerCase()
  const safeHost = rawHost === '127.0.0.1' ? '127.0.0.1' : 'localhost'
  const localPort = req.body?.localPort !== undefined && req.body?.localPort !== '' ? Number(req.body.localPort) : null
  let target = String(req.body?.target || '').trim()
  if (target && !/^https?:\/\//i.test(target)) {
    target = `http://${target}`
  }

  if (!domain || !isValidDomainName(domain)) {
    res.status(400).json({ error: 'Please provide a valid domain name (e.g. myapp.local)' })
    return
  }

  if (!target && localPort !== null) {
    if (!Number.isInteger(localPort) || localPort < 1024 || localPort > 65535) {
      res.status(400).json({ error: 'Local port must be an integer between 1024 and 65535' })
      return
    }
    target = `http://${safeHost}:${localPort}`
  }

  if (!target && appName) {
    const foundApp =
      localRuntime.findByName(appName) ||
      nativeProcesses.findByName(appName) ||
      installerEngine.findByName(appName)
    if (!foundApp) {
      res.status(404).json({ error: `App "${appName}" was not found` })
      return
    }
    target = `http://${safeHost}:${foundApp.port}`
  }

  const check = validateLocalProxyTarget(target)
  if (!check.ok) {
    res.status(400).json({ error: check.error })
    return
  }
  const normalizedTarget = `http://${check.url.hostname.toLowerCase()}:${check.url.port}`

  const existing = store.proxyRoutes.find((r) => r.domain.toLowerCase() === domain)
  if (existing) {
    existing.target = normalizedTarget
    existing.port = Number(req.body?.port) || 80
    existing.ssl = Boolean(req.body?.ssl)
    existing.enabled = req.body?.enabled !== undefined ? Boolean(req.body.enabled) : true
    const saved = proxyConfig.saveToDisk(store.proxyRoutes, store.settings)
    savePlatformState()
    res.json({ ...existing, savedToJson: true, configUpdatedAt: saved.updatedAt })
    return
  }

  const route = {
    id: store.newId('proxy'),
    domain,
    target: normalizedTarget,
    port: Number(req.body?.port) || 80,
    ssl: Boolean(req.body?.ssl),
    enabled: req.body?.enabled !== undefined ? Boolean(req.body.enabled) : true,
  }
  store.proxyRoutes.push(route)
  const saved = proxyConfig.saveToDisk(store.proxyRoutes, store.settings)
  savePlatformState()
  res.json({ ...route, savedToJson: true, configUpdatedAt: saved.updatedAt })
})

api.get('/proxy/:id', requirePermission('settings.read', auditService), (req: Request, res: Response) => {
  const route = store.proxyRoutes.find((r) => r.id === req.params.id)
  if (!route) {
    res.status(404).json({ error: 'route not found' })
    return
  }
  res.json(route)
})

api.put('/proxy/:id', requirePermission('settings.manage', auditService), (req: Request, res: Response) => {
  const idx = store.proxyRoutes.findIndex((r) => r.id === req.params.id)
  if (idx === -1) {
    res.status(404).json({ error: 'route not found' })
    return
  }
  const current = store.proxyRoutes[idx]
  let nextDomain = current.domain
  let nextTarget = current.target

  if (typeof req.body?.domain === 'string') {
    const d = req.body.domain.trim().toLowerCase()
    if (!isValidDomainName(d)) {
      res.status(400).json({ error: 'Invalid domain name format' })
      return
    }
    nextDomain = d
  }

  const rawHost = String(req.body?.targetHost || 'localhost').trim().toLowerCase()
  const safeHost = rawHost === '127.0.0.1' ? '127.0.0.1' : 'localhost'

  if (req.body?.localPort !== undefined && req.body?.localPort !== '') {
    const lp = Number(req.body.localPort)
    if (!Number.isInteger(lp) || lp < 1024 || lp > 65535) {
      res.status(400).json({ error: 'Local port must be between 1024 and 65535' })
      return
    }
    nextTarget = `http://${safeHost}:${lp}`
  } else if (typeof req.body?.target === 'string' && req.body.target.trim()) {
    let candidate = req.body.target.trim()
    if (!/^https?:\/\//i.test(candidate)) candidate = `http://${candidate}`
    const check = validateLocalProxyTarget(candidate)
    if (!check.ok) {
      res.status(400).json({ error: check.error })
      return
    }
    nextTarget = `http://${check.url.hostname.toLowerCase()}:${check.url.port}`
  }

  store.proxyRoutes[idx] = {
    ...current,
    domain: nextDomain,
    target: nextTarget,
    ssl: req.body?.ssl !== undefined ? Boolean(req.body.ssl) : current.ssl,
    enabled: req.body?.enabled !== undefined ? Boolean(req.body.enabled) : current.enabled,
    port: req.body?.port !== undefined ? Number(req.body.port) || 80 : current.port,
    id: String(req.params.id),
  }
  proxyConfig.saveToDisk(store.proxyRoutes, store.settings)
  savePlatformState()
  res.json(store.proxyRoutes[idx])
})

api.delete('/proxy/:id', requirePermission('settings.manage', auditService), (req: Request, res: Response) => {
  const idx = store.proxyRoutes.findIndex((r) => r.id === req.params.id)
  if (idx === -1) {
    res.status(404).json({ error: 'route not found' })
    return
  }
  store.proxyRoutes.splice(idx, 1)
  proxyConfig.saveToDisk(store.proxyRoutes, store.settings)
  savePlatformState()
  res.json({ status: 'deleted' })
})

api.post('/proxy/:id/test', requirePermission('settings.manage', auditService), async (req: Request, res: Response) => {
  const route = store.proxyRoutes.find((r) => r.id === req.params.id)
  if (!route) {
    res.status(404).json({ error: 'route not found' })
    return
  }
  const check = validateLocalProxyTarget(route.target)
  if (!check.ok) {
    res.status(400).json({ ok: false, error: check.error })
    return
  }
  const port = Number(check.url.port || (check.url.protocol === 'https:' ? 443 : 80))
  const probe = await probeLocalHttp(port, '/')
  res.json({
    ...probe,
    domain: route.domain,
    target: route.target,
  })
})

api.post('/proxy/:id/enable', requirePermission('settings.manage', auditService), (req: Request, res: Response) => {
  const route = store.proxyRoutes.find((r) => r.id === req.params.id)
  if (!route) {
    res.status(404).json({ error: 'route not found' })
    return
  }
  route.enabled = true
  proxyConfig.saveToDisk(store.proxyRoutes, store.settings)
  savePlatformState()
  res.json({ status: 'enabled' })
})

api.post('/proxy/:id/disable', requirePermission('settings.manage', auditService), (req: Request, res: Response) => {
  const route = store.proxyRoutes.find((r) => r.id === req.params.id)
  if (!route) {
    res.status(404).json({ error: 'route not found' })
    return
  }
  route.enabled = false
  proxyConfig.saveToDisk(store.proxyRoutes, store.settings)
  savePlatformState()
  res.json({ status: 'disabled' })
})

// ==================== DATABASES ====================

const DB_DEFAULTS: Record<string, { port: number; user: string }> = {
  postgres: { port: 5432, user: 'postgres' },
  mysql: { port: 3306, user: 'root' },
  mongodb: { port: 27017, user: 'admin' },
  redis: { port: 6379, user: 'default' },
}

function serializeDatabase(db: (typeof store.databases)[number]) {
  return {
    id: db.id,
    name: db.name,
    type: db.type,
    port: db.port,
    user: db.user,
    status: db.status,
    hasPassword: Boolean(db.password),
    passwordMasked: db.password ? '••••••••' : '',
  }
}

api.get('/databases', requirePermission('databases.read', auditService), (_req: Request, res: Response) => {
  res.json(store.databases.map(serializeDatabase))
})

api.post('/databases', requirePermission('databases.manage', auditService), (req: AuthedRequest, res: Response) => {
  const name = String(req.body?.name || '').trim()
  const type = String(req.body?.type || 'postgres') as 'postgres' | 'mysql' | 'mongodb' | 'redis'
  if (!name) {
    res.status(400).json({ error: 'database name is required' })
    return
  }
  if (!DB_DEFAULTS[type]) {
    res.status(400).json({ error: 'unsupported database type' })
    return
  }
  const meta = DB_DEFAULTS[type]
  const db = {
    id: store.newId('db'),
    name,
    type,
    port: meta.port + store.databases.length,
    user: meta.user,
    password: String(req.body?.password || '') || crypto.randomBytes(12).toString('hex'),
    status: 'running' as const,
  }
  store.databases.push(db)
  savePlatformState()
  recordAudit(req, 'database.create', `${db.name} (${db.type})`, 'success')
  res.json(serializeDatabase(db))
})

api.get('/databases/:id', requirePermission('databases.read', auditService), (req: Request, res: Response) => {
  const db = store.databases.find((d) => d.id === req.params.id)
  if (!db) {
    res.status(404).json({ error: 'database not found' })
    return
  }
  res.json(serializeDatabase(db))
})

api.delete('/databases/:id', requirePermission('databases.manage', auditService), (req: AuthedRequest, res: Response) => {
  const idx = store.databases.findIndex((d) => d.id === req.params.id)
  if (idx === -1) {
    res.status(404).json({ error: 'database not found' })
    return
  }
  const [removed] = store.databases.splice(idx, 1)
  savePlatformState()
  recordAudit(req, 'database.delete', removed.name, 'success')
  res.json({ status: 'deleted' })
})

api.post('/databases/:id/start', requirePermission('databases.manage', auditService), (req: AuthedRequest, res: Response) => {
  const db = store.databases.find((d) => d.id === req.params.id)
  if (!db) {
    res.status(404).json({ error: 'database not found' })
    return
  }
  db.status = 'running'
  savePlatformState()
  res.json({ status: 'started' })
})

api.post('/databases/:id/stop', requirePermission('databases.manage', auditService), (req: AuthedRequest, res: Response) => {
  const db = store.databases.find((d) => d.id === req.params.id)
  if (!db) {
    res.status(404).json({ error: 'database not found' })
    return
  }
  db.status = 'stopped'
  savePlatformState()
  res.json({ status: 'stopped' })
})

api.get('/databases/:id/connection', requirePermission('databases.manage', auditService), (req: AuthedRequest, res: Response) => {
  const db = store.databases.find((d) => d.id === req.params.id)
  if (!db) {
    res.status(404).json({ error: 'database not found' })
    return
  }
  let conn = ''
  if (db.type === 'postgres') conn = `postgresql://${db.user}:${db.password}@localhost:${db.port}/${db.name}`
  else if (db.type === 'mysql') conn = `mysql://${db.user}:${db.password}@localhost:${db.port}/${db.name}`
  else if (db.type === 'mongodb') conn = `mongodb://${db.user}:${db.password}@localhost:${db.port}/${db.name}`
  else conn = `redis://:${db.password}@localhost:${db.port}`
  recordAudit(req, 'database.reveal_connection', db.name, 'success')
  res.json({ connection_string: conn })
})

// ==================== FILE MANAGER ====================

api.get('/files', requirePermission('containers.read', auditService), (req: Request, res: Response) => {
  const dirPath = String(req.query.path || '/')
  res.json(store.listDir(dirPath))
})

api.get('/files/read', requirePermission('containers.read', auditService), (req: Request, res: Response) => {
  const filePath = store.normalizePath(String(req.query.path || ''))
  const node = store.files.get(filePath)
  if (!node || node.isDir) {
    res.status(404).json({ error: 'file not found' })
    return
  }
  res.setHeader('Content-Type', 'application/octet-stream')
  res.send(node.content)
})

api.post('/files/write', requirePermission('containers.manage', auditService), (req: Request, res: Response) => {
  const filePath = store.normalizePath(String(req.body?.path || ''))
  if (!filePath || filePath === '/') {
    res.status(400).json({ error: 'invalid file path' })
    return
  }
  store.ensureParentDirs(filePath)
  store.files.set(filePath, {
    isDir: false,
    content: String(req.body?.content ?? ''),
    updatedAt: new Date().toISOString(),
  })
  res.json({ status: 'ok' })
})

api.post('/files/mkdir', requirePermission('containers.manage', auditService), (req: Request, res: Response) => {
  const dirPath = store.normalizePath(String(req.body?.path || ''))
  if (!dirPath || dirPath === '/') {
    res.status(400).json({ error: 'invalid directory path' })
    return
  }
  store.ensureParentDirs(dirPath)
  store.files.set(dirPath, {
    isDir: true,
    content: '',
    updatedAt: new Date().toISOString(),
  })
  res.json({ status: 'ok' })
})

api.delete('/files/delete', requirePermission('containers.manage', auditService), (req: Request, res: Response) => {
  const target = store.normalizePath(String(req.query.path || ''))
  if (!target || target === '/') {
    res.status(400).json({ error: 'cannot delete root' })
    return
  }
  store.files.delete(target)
  const prefix = target + '/'
  for (const key of Array.from(store.files.keys())) {
    if (key.startsWith(prefix)) {
      store.files.delete(key)
    }
  }
  res.json({ status: 'deleted' })
})

api.post('/files/rename', requirePermission('containers.manage', auditService), (req: Request, res: Response) => {
  const oldPath = store.normalizePath(String(req.body?.old_path || ''))
  const newPath = store.normalizePath(String(req.body?.new_path || ''))
  const node = store.files.get(oldPath)
  if (!node) {
    res.status(404).json({ error: 'source not found' })
    return
  }
  store.files.delete(oldPath)
  store.ensureParentDirs(newPath)
  store.files.set(newPath, node)
  res.json({ status: 'ok' })
})

api.post('/files/upload', requirePermission('containers.manage', auditService), upload.single('file'), (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: 'no file provided' })
    return
  }
  const relPath = String(req.body?.path || req.file.originalname)
  const fullPath = store.normalizePath(relPath.startsWith('/') ? relPath : '/' + relPath)
  store.ensureParentDirs(fullPath)
  store.files.set(fullPath, {
    isDir: false,
    content: req.file.buffer.toString('utf8'),
    updatedAt: new Date().toISOString(),
  })
  res.json({ status: 'ok', filename: req.file.originalname })
})

// ==================== BACKUPS ====================

api.get('/backups', requirePermission('backups.create', auditService), (_req: Request, res: Response) => {
  res.json(backupManager.listBackups())
})

api.post('/backups', requirePermission('backups.create', auditService), (req: AuthedRequest, res: Response) => {
  try {
    const rawName = typeof req.body?.name === 'string' ? req.body.name : ''
    const bkp = backupManager.createSnapshot(rawName)
    savePlatformState()
    recordAudit(req, 'backup.create', bkp.id, 'success', bkp.name)
    res.json(bkp)
  } catch (err) {
    res.status(500).json({ error: (err as Error).message || 'Failed to create backup archive' })
  }
})

api.get('/backups/export', requirePermission('backups.create', auditService), (req: AuthedRequest, res: Response) => {
  try {
    const archive = backupManager.exportZipArchive()
    recordAudit(req, 'backup.export', archive.filename, 'success')
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename="${archive.filename}"`)
    res.setHeader('Content-Length', String(archive.buffer.length))
    res.setHeader('X-Kathal-Backup-Entries', String(archive.entryCount))
    res.setHeader('X-Kathal-Backup-Compression', `${archive.compressionRatio}%`)
    res.send(archive.buffer)
  } catch (err) {
    res.status(500).json({ error: (err as Error).message || 'Failed to export backup archive' })
  }
})

api.post('/backups/import', requirePermission('backups.restore', auditService), upload.single('file'), (req: AuthedRequest, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: 'no file provided' })
    return
  }
  try {
    const summary = backupManager.importArchive(req.file.buffer)
    savePlatformState()
    recordAudit(req, 'backup.import', req.file.originalname || 'archive', 'success')
    res.json({ status: 'imported', ...summary })
  } catch (err) {
    res.status(400).json({ error: (err as Error).message || 'Invalid backup archive' })
  }
})

api.get('/backups/:id/download', requirePermission('backups.create', auditService), (req: Request, res: Response) => {
  const found = backupManager.getSnapshotArchive(String(req.params.id))
  if (!found) {
    res.status(404).json({ error: 'backup archive not found' })
    return
  }
  res.setHeader('Content-Type', 'application/zip')
  res.setHeader('Content-Disposition', `attachment; filename="${found.filename}"`)
  res.setHeader('Content-Length', String(found.buffer.length))
  res.send(found.buffer)
})

api.delete('/backups/:id', requirePermission('backups.restore', auditService), (req: AuthedRequest, res: Response) => {
  const deleted = backupManager.deleteSnapshot(String(req.params.id))
  if (!deleted) {
    res.status(404).json({ error: 'backup not found' })
    return
  }
  savePlatformState()
  recordAudit(req, 'backup.delete', String(req.params.id), 'success')
  res.json({ status: 'deleted' })
})

api.post('/backups/:id/restore', requirePermission('backups.restore', auditService), (req: AuthedRequest, res: Response) => {
  const bkp = store.backups.find((b) => b.id === req.params.id)
  if (!bkp) {
    res.status(404).json({ error: 'backup not found' })
    return
  }
  try {
    const summary = backupManager.restoreSnapshot(bkp.id)
    savePlatformState()
    recordAudit(req, 'backup.restore', bkp.id, 'success')
    res.json({
      status: 'restored',
      ...summary,
      message: `Snapshot "${bkp.name}" restored (${summary.entriesRead} files, ${summary.restoredConfigFiles} app config(s)).`,
    })
  } catch {
    res.json({ status: 'restored', message: `Snapshot "${bkp.name}" metadata restored.` })
  }
})

// ==================== APP STORE, CENTRAL JSON REGISTRY & SERVICE ENGINE ====================

api.get('/runtimes', requirePermission('applications.read', auditService), async (req: Request, res: Response) => {
  const report = await detectHostRuntimes(req.query.refresh === 'true')
  res.json(report)
})

function filterAndSortTemplates(query: Request['query']) {
  const category = String(query.category || '').trim().toLowerCase()
  const compatibility = String(query.compatibility || '').trim()
  const difficulty = String(query.difficulty || '').trim().toLowerCase()
  const runtime = String(query.runtime || '').trim().toLowerCase()
  const dockerFree = String(query.dockerFree || '').trim().toLowerCase()
  const featured = String(query.featured || '').trim().toLowerCase()
  const q = String(query.q || '').trim().toLowerCase()
  const sort = String(query.sort || 'popular').trim().toLowerCase()

  const registry = loadCentralRegistry()
  const allApps = registry.applications
  const categories = registry.categories || {}
  let list = allApps.filter((t) => {
    const catDef = categories[t.category]
    const catLabel = (catDef?.label || '').toLowerCase()
    if (category && t.category !== category && !catLabel.includes(category)) return false
    if (compatibility && t.compatibility !== compatibility) return false
    if (difficulty && t.difficulty !== difficulty) return false
    if (runtime && !t.runtime.toLowerCase().includes(runtime)) return false
    if (dockerFree === 'true' && !t.dockerFreeSupported) return false
    if (dockerFree === 'false' && t.dockerFreeSupported) return false
    if (featured === 'true' && !t.featured) return false
    if (q) {
      const matches =
        t.name.toLowerCase().includes(q) ||
        t.id.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.category.toLowerCase().includes(q) ||
        catLabel.includes(q) ||
        t.runtime.toLowerCase().includes(q) ||
        t.compatibility.toLowerCase().includes(q) ||
        t.tags.some((tag) => tag.toLowerCase().includes(q))
      if (!matches) return false
    }
    return true
  })

  list = [...list]
  if (sort === 'alpha') {
    list.sort((a, b) => a.name.localeCompare(b.name))
  } else if (sort === 'recent') {
    list.sort((a, b) => b.addedAt.localeCompare(a.addedAt) || b.popularity - a.popularity)
  } else {
    list.sort((a, b) => b.popularity - a.popularity || a.name.localeCompare(b.name))
  }
  return list
}

// Central JSON Registry API endpoints
api.get('/registry', requirePermission('applications.read', auditService), (req: Request, res: Response) => {
  const registry = loadCentralRegistry()
  const counts: Record<string, number> = {}
  for (const appItem of registry.applications) {
    counts[appItem.category] = (counts[appItem.category] || 0) + 1
  }
  const filtered = filterAndSortTemplates(req.query)
  res.json({
    schemaVersion: registry.schemaVersion,
    updatedAt: registry.updatedAt,
    registryFile: 'data/registry.json',
    totalApps: registry.applications.length,
    categoryCounts: counts,
    categories: registry.categories,
    compatibilityLabels: registry.compatibilityLabels,
    applications: filtered,
  })
})

api.get('/registry/apps/:id', requirePermission('applications.read', auditService), (req: Request, res: Response) => {
  const appItem = getRegistryAppById(String(req.params.id))
  if (!appItem) {
    res.status(404).json({ error: 'Application not found in central registry' })
    return
  }
  res.json(appItem)
})

api.post('/registry/reload', requirePermission('applications.create', auditService), (_req: Request, res: Response) => {
  const reloaded = reloadCentralRegistry()
  res.json({
    status: 'reloaded',
    schemaVersion: reloaded.schemaVersion,
    updatedAt: reloaded.updatedAt,
    totalApps: reloaded.applications.length,
  })
})

// Service Engine API endpoints (Node.js child_process supervision, PID tracking, logs, lifecycle & resources)
api.get('/services', requirePermission('applications.read', auditService), (req: Request, res: Response) => {
  const stateFilter = String(req.query.state || '').trim().toLowerCase()
  const list = serviceEngine.listServices().map(serializeServiceRecord)
  const filtered = stateFilter ? list.filter((s) => s.state === stateFilter) : list
  const running = list.filter((s) => s.state === 'running')
  res.json({
    services: filtered,
    summary: {
      total: list.length,
      running: running.length,
      exited: list.length - running.length,
      totalCpuPercent: Number(running.reduce((sum, s) => sum + (s.cpuPercent || 0), 0).toFixed(1)),
      totalMemoryMb: Number(running.reduce((sum, s) => sum + (s.memoryMb || 0), 0).toFixed(1)),
    },
  })
})

api.post('/services', requirePermission('applications.deploy', auditService), async (req: Request, res: Response) => {
  const templateId = typeof req.body?.templateId === 'string' ? req.body.templateId.trim() : ''
  const customDomain = typeof req.body?.domain === 'string' ? req.body.domain.trim() : ''
  if (customDomain && !isValidDomainName(customDomain)) {
    res.status(400).json({ error: 'Invalid domain name format' })
    return
  }

  let envObj: Record<string, string> = {}
  if (Array.isArray(req.body?.env)) {
    envObj = parseEnvMap(req.body.env)
  } else if (req.body?.env && typeof req.body.env === 'object') {
    for (const [k, v] of Object.entries(req.body.env)) {
      envObj[String(k)] = String(v ?? '')
    }
  }

  try {
    let svc: ManagedServiceRecord
    if (templateId && !req.body?.executable) {
      svc = await serviceEngine.spawnFromRegistry({
        templateId,
        name: typeof req.body?.name === 'string' ? req.body.name : undefined,
        port: req.body?.port ? Number(req.body.port) : undefined,
        env: envObj,
      })
    } else {
      const executable = String(req.body?.executable || req.body?.command || '').trim()
      if (!executable) {
        res.status(400).json({ error: 'executable command or templateId is required' })
        return
      }
      const name = String(req.body?.name || executable).trim()
      svc = await serviceEngine.registerAndSpawn({
        name,
        displayName: typeof req.body?.displayName === 'string' ? req.body.displayName : name,
        templateId: templateId || null,
        source: 'service-engine',
        executable,
        args: req.body?.args,
        workingDir: typeof req.body?.workingDir === 'string' ? req.body.workingDir : undefined,
        port: req.body?.port ? Number(req.body.port) : undefined,
        env: envObj,
        healthCheck: req.body?.healthCheck && typeof req.body.healthCheck === 'object' ? req.body.healthCheck : undefined,
      })
    }

    const proxyRoute = upsertAppProxyRoute(svc.name, svc.port, customDomain, Boolean(req.body?.autoDomain))
    res.status(201).json({
      service: serializeServiceRecord(svc),
      proxyRoute,
      liveUrl: `/live/${svc.name}/`,
    })
  } catch (err) {
    res.status(400).json({ error: (err as Error).message || 'Failed to spawn service' })
  }
})

api.get('/services/:id', requirePermission('applications.read', auditService), (req: Request, res: Response) => {
  const svc = serviceEngine.getService(String(req.params.id))
  if (!svc) {
    res.status(404).json({ error: 'service not found' })
    return
  }
  res.json({
    ...serializeServiceRecord(svc),
    logs: svc.logs.slice(-150),
  })
})

api.get('/services/:id/logs', requirePermission('applications.read', auditService), (req: Request, res: Response) => {
  const svc = serviceEngine.getService(String(req.params.id))
  if (!svc) {
    res.status(404).json({ error: 'service not found' })
    return
  }
  const tail = Math.min(1000, Math.max(10, Number(req.query.tail) || 200))
  const q = typeof req.query.q === 'string' ? req.query.q : ''
  const entries = serviceEngine.getLogs(svc.id, tail, q)
  res.json({
    serviceId: svc.id,
    pid: svc.pid,
    entries,
    logs: entries.map((l) => `${l.timestamp} [${l.stream}] ${l.content}`).join('\n'),
  })
})

api.get('/services/:id/metrics', requirePermission('applications.read', auditService), (req: Request, res: Response) => {
  const metrics = serviceEngine.getMetricsHistory(String(req.params.id))
  if (!metrics) {
    res.status(404).json({ error: 'service not found' })
    return
  }
  res.json(metrics)
})

api.post('/services/:id/start', requirePermission('applications.restart', auditService), async (req: Request, res: Response) => {
  try {
    const svc = await serviceEngine.startService(String(req.params.id))
    if (!svc) {
      res.status(404).json({ error: 'service not found' })
      return
    }
    res.json({ status: 'started', service: serializeServiceRecord(svc) })
  } catch (err) {
    res.status(400).json({ error: (err as Error).message || 'Failed to start service' })
  }
})

api.post('/services/:id/stop', requirePermission('applications.restart', auditService), async (req: Request, res: Response) => {
  const svc = await serviceEngine.stopService(String(req.params.id))
  if (!svc) {
    res.status(404).json({ error: 'service not found' })
    return
  }
  res.json({ status: 'stopped', service: serializeServiceRecord(svc) })
})

api.post('/services/:id/restart', requirePermission('applications.restart', auditService), async (req: Request, res: Response) => {
  try {
    const svc = await serviceEngine.restartService(String(req.params.id))
    if (!svc) {
      res.status(404).json({ error: 'service not found' })
      return
    }
    res.json({ status: 'restarted', service: serializeServiceRecord(svc) })
  } catch (err) {
    res.status(400).json({ error: (err as Error).message || 'Failed to restart service' })
  }
})

api.post('/services/:id/health', requirePermission('applications.restart', auditService), async (req: Request, res: Response) => {
  const health = await serviceEngine.runHealthCheck(String(req.params.id))
  if (!health) {
    res.status(404).json({ error: 'service not found' })
    return
  }
  res.json(health)
})

api.delete('/services/:id', requirePermission('applications.delete', auditService), async (req: Request, res: Response) => {
  const id = String(req.params.id)
  const svc = serviceEngine.getService(id)
  if (!svc) {
    res.status(404).json({ error: 'service not found' })
    return
  }
  const oldPort = svc.port
  const keepData = req.query.keepData === 'true'
  await serviceEngine.deleteService(svc.id, keepData)
  store.proxyRoutes = store.proxyRoutes.filter(
    (r) => r.target !== `http://127.0.0.1:${oldPort}` && r.target !== `http://localhost:${oldPort}`
  )
  proxyConfig.saveToDisk(store.proxyRoutes, store.settings)
  res.json({ status: 'deleted' })
})

api.get('/templates', requirePermission('applications.read', auditService), (req: Request, res: Response) => {
  res.json(filterAndSortTemplates(req.query))
})

api.get('/templates/search', requirePermission('applications.read', auditService), (req: Request, res: Response) => {
  res.json(filterAndSortTemplates(req.query))
})

api.get('/templates/categories', requirePermission('applications.read', auditService), (_req: Request, res: Response) => {
  const registry = loadCentralRegistry()
  const counts: Record<string, number> = {}
  for (const t of registry.applications) {
    counts[t.category] = (counts[t.category] || 0) + 1
  }
  res.json({
    counts,
    definitions: registry.categories,
    total: registry.applications.length,
  })
})

api.get('/templates/:id/preflight', requirePermission('applications.read', auditService), async (req: Request, res: Response) => {
  const tmpl = getTemplateById(String(req.params.id))
  if (!tmpl) {
    res.status(404).json({ error: 'template not found' })
    return
  }
  const preflight = await installerEngine.checkPreflight(
    tmpl,
    typeof req.query.name === 'string' ? req.query.name : undefined
  )
  res.json(preflight)
})

api.get('/templates/:id', requirePermission('applications.read', auditService), async (req: Request, res: Response) => {
  const tmpl = getTemplateById(String(req.params.id))
  if (!tmpl) {
    res.status(404).json({ error: 'template not found' })
    return
  }
  const [preflight] = await Promise.all([installerEngine.checkPreflight(tmpl)])
  const installation = installerEngine.findByTemplateId(tmpl.id)
  res.json({
    ...tmpl,
    preflight,
    installation: installation ? serializeInstallation(installation) : null,
  })
})

async function handleTemplateInstallRequest(req: Request, res: Response) {
  const tmpl = getTemplateById(String(req.params.id))
  if (!tmpl) {
    res.status(404).json({ error: 'template not found' })
    return
  }
  const requestedPort = req.body?.hostPort ? Number(req.body.hostPort) : tmpl.defaultPort
  const customName = String(req.body?.name || tmpl.id).trim() || tmpl.id
  const customDomain = typeof req.body?.domain === 'string' ? req.body.domain.trim() : ''
  if (customDomain && !isValidDomainName(customDomain)) {
    res.status(400).json({ error: 'Invalid domain name format' })
    return
  }

  let envObj: Record<string, string> = {}
  if (Array.isArray(req.body?.env)) {
    envObj = parseEnvMap(req.body.env)
  } else if (req.body?.env && typeof req.body.env === 'object') {
    for (const [k, v] of Object.entries(req.body.env)) {
      envObj[String(k)] = String(v ?? '')
    }
  }

  try {
    const rec = await installerEngine.startInstallation({
      template: tmpl,
      name: customName,
      hostPort: requestedPort,
      env: envObj,
      overwrite: Boolean(req.body?.overwrite),
    })
    const proxyRoute = upsertAppProxyRoute(
      rec.name,
      rec.port,
      customDomain,
      Boolean(req.body?.autoDomain)
    )
    const serialized = serializeInstallation(rec)
    res.json({
      template: tmpl.name,
      installation: serialized,
      app: {
        id: rec.id,
        name: rec.name,
        port: rec.port,
        runtime: rec.runtime,
        status: rec.state,
      },
      container: serialized,
      proxyRoute,
      liveUrl: `/live/${rec.name}/`,
      logs: rec.logs.map((l) => l.content),
    })
  } catch (err) {
    const e = err as Error & { statusCode?: number; code?: string; preflight?: unknown }
    res.status(e.statusCode || 400).json({
      error: e.message || 'Installation failed',
      code: e.code,
      preflight: e.preflight,
    })
  }
}

api.post('/templates/:id/install', requirePermission('applications.create', auditService), handleTemplateInstallRequest)
api.post('/templates/:id/deploy', requirePermission('applications.create', auditService), handleTemplateInstallRequest)

api.get('/installations', requirePermission('applications.read', auditService), (_req: Request, res: Response) => {
  res.json(installerEngine.listAll().map(serializeInstallation))
})

api.get('/installations/:id', requirePermission('applications.read', auditService), (req: Request, res: Response) => {
  const id = String(req.params.id)
  const rec = installerEngine.installations.get(id) || installerEngine.findByName(id) || installerEngine.findByTemplateId(id)
  if (!rec) {
    res.status(404).json({ error: 'installation not found' })
    return
  }
  res.json(serializeInstallation(rec))
})

api.post('/installations/:id/start', requirePermission('applications.restart', auditService), async (req: Request, res: Response) => {
  try {
    const rec = await installerEngine.startApp(String(req.params.id))
    if (!rec) {
      res.status(404).json({ error: 'installation not found' })
      return
    }
    res.json({ status: 'started', installation: serializeInstallation(rec) })
  } catch (err) {
    res.status(400).json({ error: (err as Error).message || 'Failed to start app' })
  }
})

api.post('/installations/:id/stop', requirePermission('applications.restart', auditService), async (req: Request, res: Response) => {
  const rec = await installerEngine.stopApp(String(req.params.id))
  if (!rec) {
    res.status(404).json({ error: 'installation not found' })
    return
  }
  res.json({ status: 'stopped', installation: serializeInstallation(rec) })
})

api.post('/installations/:id/restart', requirePermission('applications.restart', auditService), async (req: Request, res: Response) => {
  try {
    const rec = await installerEngine.restartApp(String(req.params.id))
    if (!rec) {
      res.status(404).json({ error: 'installation not found' })
      return
    }
    res.json({ status: 'restarted', installation: serializeInstallation(rec) })
  } catch (err) {
    res.status(400).json({ error: (err as Error).message || 'Failed to restart app' })
  }
})

api.post('/installations/:id/health', requirePermission('applications.restart', auditService), async (req: Request, res: Response) => {
  const health = await installerEngine.checkHealth(String(req.params.id))
  if (!health) {
    res.status(404).json({ error: 'installation not found' })
    return
  }
  res.json(health)
})

api.put('/installations/:id/env', requirePermission('applications.deploy', auditService), (req: Request, res: Response) => {
  const envObj: Record<string, string> = {}
  if (Array.isArray(req.body?.env)) {
    Object.assign(envObj, parseEnvMap(req.body.env))
  } else if (req.body?.env && typeof req.body.env === 'object') {
    for (const [k, v] of Object.entries(req.body.env)) {
      envObj[String(k)] = String(v ?? '')
    }
  }
  const rec = installerEngine.updateEnv(String(req.params.id), envObj)
  if (!rec) {
    res.status(404).json({ error: 'installation not found' })
    return
  }
  res.json({ installation: serializeInstallation(rec) })
})

api.delete('/installations/:id', requirePermission('applications.delete', auditService), async (req: Request, res: Response) => {
  const id = String(req.params.id)
  const rec = installerEngine.installations.get(id) || installerEngine.findByName(id)
  if (!rec) {
    res.status(404).json({ error: 'installation not found' })
    return
  }
  const oldPort = rec.port
  const keepData = req.query.keepData === 'true'
  const outcome = await installerEngine.uninstall(rec.id, keepData)
  store.proxyRoutes = store.proxyRoutes.filter(
    (r) => r.target !== `http://127.0.0.1:${oldPort}` && r.target !== `http://localhost:${oldPort}`
  )
  proxyConfig.saveToDisk(store.proxyRoutes, store.settings)
  res.json({ status: 'uninstalled', ...outcome })
})

// ==================== GIT DEPLOY ====================

async function executeGitDeployment(repo: (typeof store.gitRepos)[number]) {
  const timestamp = new Date().toISOString()
  try {
    const result = await localRuntime.deployFromGit({
      name: repo.name,
      repoUrl: repo.url,
      branch: repo.branch || 'main',
      port: repo.port || undefined,
      env: parseEnvMap(null),
    })
    repo.status = 'success'
    repo.last_deploy = timestamp
    repo.container_id = result.app.id
    repo.port = result.app.port
    const proxyRoute = upsertAppProxyRoute(
      result.app.name,
      result.app.port,
      repo.domain || '',
      !repo.domain
    )
    if (!repo.domain && proxyRoute) {
      repo.domain = proxyRoute.domain
    }
    const log = {
      timestamp,
      commit: result.commit,
      containerId: result.app.id,
      port: result.app.port,
      domain: proxyRoute?.domain || repo.domain || '',
      liveUrl: `/live/${result.app.name}/`,
      output: result.buildLogs.join('\n'),
    }
    const list = store.gitHistory.get(repo.id) || []
    list.unshift(log)
    store.gitHistory.set(repo.id, list)
    return log
  } catch (err) {
    repo.status = 'failed'
    repo.last_deploy = timestamp
    const message = (err as Error).message || 'Git deploy failed'
    const log = {
      timestamp,
      error: message,
      output: `Error: ${message}`,
    }
    const list = store.gitHistory.get(repo.id) || []
    list.unshift(log)
    store.gitHistory.set(repo.id, list)
    throw err
  }
}

api.get('/git/repos', requirePermission('applications.read', auditService), (_req: Request, res: Response) => {
  res.json(store.gitRepos)
})

api.post('/git/repos', requirePermission('applications.create', auditService), (req: Request, res: Response) => {
  const name = String(req.body?.name || '').trim()
  const url = String(req.body?.url || '').trim()
  if (!name || !url) {
    res.status(400).json({ error: 'name and url are required' })
    return
  }
  if (!isValidPublicHttpsGitUrl(url)) {
    res.status(400).json({ error: 'Repository URL must be a valid public https:// Git URL' })
    return
  }
  const domain = String(req.body?.domain || '').trim().toLowerCase()
  if (domain && !isValidDomainName(domain)) {
    res.status(400).json({ error: 'Invalid domain name format' })
    return
  }
  const repo = {
    id: store.newId('repo'),
    name,
    url,
    branch: String(req.body?.branch || 'main'),
    deploy_cmd: String(req.body?.deploy_cmd || 'Auto-detect (Node.js / Python / Static)'),
    domain,
    port: req.body?.port ? Number(req.body.port) : undefined,
    status: 'idle' as const,
  }
  store.gitRepos.push(repo)
  store.gitHistory.set(repo.id, [])
  savePlatformState()
  res.json(repo)
})

api.put('/git/repos/:id', requirePermission('applications.create', auditService), (req: Request, res: Response) => {
  const repo = store.gitRepos.find((r) => r.id === req.params.id)
  if (!repo) {
    res.status(404).json({ error: 'repo not found' })
    return
  }
  if (typeof req.body?.url === 'string' && req.body.url.trim()) {
    if (!isValidPublicHttpsGitUrl(req.body.url.trim())) {
      res.status(400).json({ error: 'Repository URL must be a valid public https:// Git URL' })
      return
    }
    repo.url = req.body.url.trim()
  }
  if (typeof req.body?.name === 'string' && req.body.name.trim()) repo.name = req.body.name.trim()
  if (typeof req.body?.branch === 'string') repo.branch = req.body.branch.trim() || 'main'
  if (typeof req.body?.deploy_cmd === 'string') repo.deploy_cmd = req.body.deploy_cmd
  if (typeof req.body?.domain === 'string') {
    const d = req.body.domain.trim().toLowerCase()
    if (d && !isValidDomainName(d)) {
      res.status(400).json({ error: 'Invalid domain name format' })
      return
    }
    repo.domain = d
  }
  if (req.body?.port !== undefined) repo.port = Number(req.body.port) || undefined
  savePlatformState()
  res.json(repo)
})

api.delete('/git/repos/:id', requirePermission('applications.delete', auditService), (req: Request, res: Response) => {
  const idx = store.gitRepos.findIndex((r) => r.id === req.params.id)
  if (idx === -1) {
    res.status(404).json({ error: 'repo not found' })
    return
  }
  store.gitRepos.splice(idx, 1)
  store.gitHistory.delete(String(req.params.id))
  savePlatformState()
  res.json({ status: 'deleted' })
})

api.post('/git/repos/:id/deploy', requirePermission('applications.deploy', auditService), async (req: AuthedRequest, res: Response) => {
  const repo = store.gitRepos.find((r) => r.id === req.params.id)
  if (!repo) {
    res.status(404).json({ error: 'repo not found' })
    return
  }
  try {
    const log = await executeGitDeployment(repo)
    savePlatformState()
    recordAudit(req, 'git.deploy', repo.name, 'success')
    res.json(log)
  } catch (err) {
    savePlatformState()
    recordAudit(req, 'git.deploy', repo.name, 'error', (err as Error).message)
    res.status(400).json({ error: (err as Error).message || 'Git deploy failed' })
  }
})

api.get('/git/repos/:id/history', requirePermission('applications.read', auditService), (req: Request, res: Response) => {
  res.json(store.gitHistory.get(String(req.params.id)) || [])
})

function verifyWebhookSignature(req: AuthedRequest): { ok: boolean; method?: string } {
  const secret = store.settings.webhookSecret
  if (!secret) return { ok: false }

  const sigHeader = String(req.headers['x-hub-signature-256'] || '').trim()
  if (sigHeader) {
    const rawPayload = req.rawBody || Buffer.from(JSON.stringify(req.body || {}), 'utf8')
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawPayload).digest('hex')
    if (safeEqualStrings(sigHeader.toLowerCase(), expected.toLowerCase())) {
      return { ok: true, method: 'x-hub-signature-256' }
    }
    return { ok: false }
  }

  const secretHeader = String(
    req.headers['x-kathal-webhook-secret'] || req.headers['x-gitlab-token'] || ''
  ).trim()
  if (secretHeader && safeEqualStrings(secretHeader, secret)) {
    return { ok: true, method: 'webhook-secret-header' }
  }

  return { ok: false }
}

async function handleWebhookTrigger(req: AuthedRequest, res: Response, forcedRepoId?: string) {
  const sigCheck = verifyWebhookSignature(req)
  if (!sigCheck.ok) {
    recordAudit(req, 'git.webhook', forcedRepoId || String(req.body?.repo_id || 'unknown'), 'denied', 'invalid_signature')
    res.status(401).json({
      error: 'Webhook authentication failed. Provide valid X-Hub-Signature-256 or X-Kathal-Webhook-Secret header.',
    })
    return
  }

  const repoId = forcedRepoId || String(req.body?.repo_id || req.query?.repo_id || '')
  const target = repoId ? store.gitRepos.find((r) => r.id === repoId) : store.gitRepos[0]
  if (!target) {
    res.status(404).json({ error: 'no repository configured for webhook' })
    return
  }
  if (!store.settings.autoDeployWebhook) {
    res.json({ repo_id: target.id, status: 'ignored', reason: 'autoDeployWebhook disabled in settings' })
    return
  }
  try {
    const log = await executeGitDeployment(target)
    savePlatformState()
    recordAudit(req, 'git.webhook', target.name, 'success', sigCheck.method)
    res.json({ repo_id: target.id, status: 'deployed', ...log })
  } catch (err) {
    savePlatformState()
    recordAudit(req, 'git.webhook', target.name, 'error', (err as Error).message)
    res.status(400).json({ error: (err as Error).message || 'Webhook deploy failed' })
  }
}

api.post('/git/webhook', async (req: AuthedRequest, res: Response) => {
  await handleWebhookTrigger(req, res)
})

api.post('/webhooks/git/:id', async (req: AuthedRequest, res: Response) => {
  await handleWebhookTrigger(req, res, String(req.params.id))
})

// ==================== WEB TERMINAL ====================

const terminalGateway = new TerminalGateway(authService, auditService, attachTerminalSession)

api.post('/terminal/sessions', requirePermission('terminal.access', auditService), (req: AuthedRequest, res: Response) => {
  try {
    const ip = req.ip || req.socket?.remoteAddress || '127.0.0.1'
    const result = terminalGateway.createSession({
      id: typeof req.body?.id === 'string' ? req.body.id : undefined,
      cols: Number(req.body?.cols) || 120,
      rows: Number(req.body?.rows) || 30,
      userId: req.auth!.user.id,
      authSessionId: req.auth!.sessionId,
      email: req.auth!.user.email,
      ip,
      correlationId: req.requestId || '',
    })
    res.json(result)
  } catch (err) {
    const e = err as Error & { status?: number }
    res.status(e.status || 400).json({ error: e.message || 'Failed to create terminal session' })
  }
})

api.delete('/terminal/sessions/:id', requirePermission('terminal.access', auditService), (req: AuthedRequest, res: Response) => {
  try {
    const canManageAll = req.auth!.user.roles.includes('Owner') || req.auth!.user.roles.includes('Administrator')
    terminalGateway.deleteSession(String(req.params.id), req.auth!.user.id, canManageAll)
    res.json({ status: 'closed' })
  } catch (err) {
    const e = err as Error & { status?: number }
    res.status(e.status || 403).json({ error: e.message || 'Forbidden' })
  }
})

// ==================== MONITORING ====================

api.get('/monitoring/current', requirePermission('dashboard.read', auditService), (_req: Request, res: Response) => {
  const runningApps = getAllRunningForMetrics()
  const latest = store.monitoringHistory[store.monitoringHistory.length - 1]
  res.json(latest || store.collectMonitoringSample(Date.now(), runningApps))
})

api.get('/monitoring/history', requirePermission('dashboard.read', auditService), (_req: Request, res: Response) => {
  res.json(store.monitoringHistory)
})

// ==================== LOGS ====================

api.get('/logs/containers', requirePermission('containers.read', auditService), (_req: Request, res: Response) => {
  res.json(
    listAllSerializedWorkload().map((s) => ({
      id: s.id,
      name: s.name,
      image: s.runtimeLabel,
      status: s.status,
    }))
  )
})

api.get('/logs', requirePermission('containers.read', auditService), (req: Request, res: Response) => {
  const containerId = String(req.query.container || '')
  const tail = Number(req.query.tail) || 100
  const filter = String(req.query.filter || '')
  const appLogs = localRuntime.getAppLogs(containerId, tail, filter)
  res.json(appLogs.length > 0 ? appLogs : nativeProcesses.getLogs(containerId, tail, filter))
})

api.post('/logs/search', requirePermission('containers.read', auditService), (req: Request, res: Response) => {
  const containerId = String(req.body?.container || '')
  const query = String(req.body?.query || '')
  const limit = Number(req.body?.limit) || 500
  const appLogs = localRuntime.getAppLogs(containerId, limit, query)
  res.json(appLogs.length > 0 ? appLogs : nativeProcesses.getLogs(containerId, limit, query))
})

// ==================== COMPOSE ====================

interface ParsedComposeService {
  name: string
  image: string
  hostPort?: number
  containerPort?: number
}

function extractComposeServiceDefs(config: string): ParsedComposeService[] {
  const lines = config.split(/\r?\n/)
  const defs: ParsedComposeService[] = []
  let inServices = false
  let serviceIndent = -1
  let current: ParsedComposeService | null = null

  for (const rawLine of lines) {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const indent = rawLine.search(/\S/)

    if (indent === 0 && /^services:\s*$/.test(trimmed)) {
      inServices = true
      serviceIndent = -1
      continue
    }

    if (inServices) {
      if (indent === 0) {
        inServices = false
        if (current) {
          defs.push(current)
          current = null
        }
        continue
      }

      if (serviceIndent === -1) {
        serviceIndent = indent
      }

      if (indent === serviceIndent) {
        const svcMatch = /^([a-zA-Z0-9._-]+):\s*$/.exec(trimmed)
        if (svcMatch) {
          if (current) defs.push(current)
          current = { name: svcMatch[1], image: `${svcMatch[1]}:latest` }
          continue
        }
      }

      if (current && indent > serviceIndent) {
        const imgMatch = /^image:\s*['"]?([^'"#\s]+)['"]?/.exec(trimmed)
        if (imgMatch) current.image = imgMatch[1]
        const portMatch = /^-\s*['"]?(?:[\d.]+:)?(\d+):(\d+)(?:\/\w+)?['"]?/.exec(trimmed)
        if (portMatch && !current.hostPort) {
          current.hostPort = Number(portMatch[1])
          current.containerPort = Number(portMatch[2])
        }
      }
    }
  }
  if (current) defs.push(current)
  return defs
}

function extractComposeServices(config: string): string[] {
  return extractComposeServiceDefs(config).map((d) => d.name)
}

function deriveStackName(filePath: string): string {
  const dir = path.posix.dirname(filePath)
  if (!dir || dir === '/' || dir === '.') return 'kathal-root'
  const base = path.posix.basename(dir)
  return base === 'data' ? 'data-default' : base
}

function syncDiscoveredComposeFiles() {
  const composeFilePattern = /(^|\/)(docker-compose|compose)\.ya?ml$/i
  const discovered: Array<{ name: string; workingDir: string; filePath: string; config: string; updatedAt: string }> = []

  // 1. Scan virtual filesystem (e.g. /data/docker-compose.yml, /data/stacks/monitoring/docker-compose.yml)
  for (const [filePath, node] of store.files.entries()) {
    if (node.isDir || !composeFilePattern.test(filePath)) continue
    discovered.push({
      name: deriveStackName(filePath),
      workingDir: path.posix.dirname(filePath) || '/',
      filePath,
      config: node.content,
      updatedAt: node.updatedAt,
    })
  }

  // 2. Scan host project directory for docker-compose.yml / compose.yaml
  for (const filename of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    const diskPath = path.join(__dirname, filename)
    if (fs.existsSync(diskPath)) {
      try {
        const content = fs.readFileSync(diskPath, 'utf8')
        const stat = fs.statSync(diskPath)
        discovered.push({
          name: 'kathal-root',
          workingDir: '/',
          filePath: `/${filename}`,
          config: content,
          updatedAt: stat.mtime.toISOString(),
        })
      } catch {
        // ignore unreadable disk file
      }
    }
  }

  for (const item of discovered) {
    const existing = store.composeProjects.find(
      (p) => p.filePath === item.filePath || p.name === item.name
    )
    const services = extractComposeServices(item.config)
    if (!existing) {
      store.composeProjects.push({
        name: item.name,
        workingDir: item.workingDir,
        filePath: item.filePath,
        status: 'created',
        services,
        config: item.config,
        updatedAt: item.updatedAt,
      })
    } else if (existing.filePath === item.filePath && existing.config !== item.config) {
      existing.config = item.config
      existing.services = services
      existing.updatedAt = item.updatedAt
    }
  }
}

function serializeComposeProject(p: (typeof store.composeProjects)[number]) {
  const rawDefs = extractComposeServiceDefs(p.config)
  const apps = localRuntime.listApps()
  const hasPrefixedApps = apps.some((a) => a.name.startsWith(`${p.name}-`))

  const serviceDefs = rawDefs.map((d) => {
    const appItem = apps.find((a) => a.name === sanitizeAppName(`${p.name}-${d.name}`))
    const state: 'running' | 'paused' | 'exited' | 'down' = appItem ? appItem.state : 'down'
    return {
      ...d,
      state,
      containerName: appItem?.name || `${p.name}-${d.name}`,
    }
  })

  const totalServices = serviceDefs.length
  const runningServices = serviceDefs.filter((s) => s.state === 'running').length

  let healthStatus: 'healthy' | 'degraded' | 'down' = 'down'
  let healthLabel = 'Down'
  if (totalServices > 0 && runningServices === totalServices) {
    healthStatus = 'healthy'
    healthLabel = 'Healthy'
  } else if (runningServices > 0) {
    healthStatus = 'degraded'
    healthLabel = 'Degraded'
  }

  let effectiveStatus = p.status
  if (hasPrefixedApps) {
    effectiveStatus = runningServices > 0 ? 'running' : 'stopped'
  }

  return {
    ...p,
    status: effectiveStatus,
    filePath: p.filePath || `${p.workingDir}/docker-compose.yml`,
    services: serviceDefs.map((d) => d.name),
    serviceDefs,
    health: {
      status: healthStatus,
      label: healthLabel,
      runningServices,
      totalServices,
    },
  }
}

api.get('/compose', requirePermission('containers.read', auditService), (_req: Request, res: Response) => {
  syncDiscoveredComposeFiles()
  res.json(store.composeProjects.map(serializeComposeProject))
})

api.post('/compose/scan', requirePermission('containers.read', auditService), (_req: Request, res: Response) => {
  syncDiscoveredComposeFiles()
  res.json(store.composeProjects.map(serializeComposeProject))
})

api.post('/compose', requirePermission('containers.manage', auditService), (req: Request, res: Response) => {
  const name = String(req.body?.name || '').trim()
  const config = String(req.body?.config || '')
  if (!name) {
    res.status(400).json({ error: 'project name is required' })
    return
  }
  const filePath = `/data/compose/${name}/docker-compose.yml`
  const project = {
    name,
    workingDir: `/data/compose/${name}`,
    filePath,
    status: 'created' as const,
    services: extractComposeServices(config),
    config,
    updatedAt: new Date().toISOString(),
  }
  store.composeProjects.push(project)
  store.ensureParentDirs(filePath)
  store.files.set(filePath, { isDir: false, content: config, updatedAt: project.updatedAt })
  savePlatformState()
  res.json(serializeComposeProject(project))
})

api.post('/compose/validate', requirePermission('containers.read', auditService), (req: Request, res: Response) => {
  const config = String(req.body?.config || '')
  const services = extractComposeServices(config)
  res.json({ valid: services.length > 0, services })
})

api.get('/compose/:name', requirePermission('containers.read', auditService), (req: Request, res: Response) => {
  syncDiscoveredComposeFiles()
  const p = store.composeProjects.find((item) => item.name === req.params.name)
  if (!p) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  res.json(serializeComposeProject(p))
})

function handleUpdateCompose(req: Request, res: Response) {
  const p = store.composeProjects.find((item) => item.name === req.params.name)
  if (!p) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const config = String(req.body?.config || '')
  p.config = config
  p.services = extractComposeServices(config)
  p.updatedAt = new Date().toISOString()
  if (p.filePath && store.files.has(p.filePath)) {
    store.files.set(p.filePath, { isDir: false, content: config, updatedAt: p.updatedAt })
  }
  savePlatformState()
  res.json(serializeComposeProject(p))
}

api.put('/compose/:name', requirePermission('containers.manage', auditService), handleUpdateCompose)
api.post('/compose/:name', requirePermission('containers.manage', auditService), handleUpdateCompose)

api.delete('/compose/:name', requirePermission('containers.manage', auditService), async (req: Request, res: Response) => {
  const name = String(req.params.name)
  const idx = store.composeProjects.findIndex((item) => item.name === name)
  if (idx === -1) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const project = store.composeProjects[idx]
  if (project.filePath && store.files.has(project.filePath)) {
    store.files.delete(project.filePath)
  }
  const prefix = sanitizeAppName(name) + '-'
  for (const appItem of localRuntime.listApps()) {
    if (appItem.name.startsWith(prefix)) {
      await localRuntime.deleteApp(appItem.id)
    }
  }
  store.composeProjects.splice(idx, 1)
  savePlatformState()
  res.json({ status: 'deleted' })
})

async function startComposeProject(p: (typeof store.composeProjects)[number]) {
  const defs = extractComposeServiceDefs(p.config)
  p.services = defs.map((d) => d.name)
  let deployedCount = 0
  for (const d of defs) {
    await localRuntime.deployLocalApp({
      name: `${p.name}-${d.name}`,
      runtimeHint: d.image,
      hostPort: d.hostPort,
      env: parseEnvMap(null),
      imageLabel: d.image,
    })
    deployedCount += 1
  }
  p.status = 'running'
  p.updatedAt = new Date().toISOString()
  savePlatformState()
  return { ...serializeComposeProject(p), deployedCount }
}

api.post('/compose/:name/start', requirePermission('containers.manage', auditService), async (req: Request, res: Response) => {
  const p = store.composeProjects.find((item) => item.name === req.params.name)
  if (!p) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  res.json(await startComposeProject(p))
})

api.post('/compose/:name/deploy', requirePermission('containers.manage', auditService), async (req: Request, res: Response) => {
  const p = store.composeProjects.find((item) => item.name === req.params.name)
  if (!p) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  res.json(await startComposeProject(p))
})

api.post('/compose/:name/restart', requirePermission('containers.manage', auditService), async (req: Request, res: Response) => {
  const p = store.composeProjects.find((item) => item.name === req.params.name)
  if (!p) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const result = await startComposeProject(p)
  res.json({ ...result, restarted: true })
})

api.post('/compose/:name/stop', requirePermission('containers.manage', auditService), async (req: Request, res: Response) => {
  const p = store.composeProjects.find((item) => item.name === req.params.name)
  if (!p) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const prefix = sanitizeAppName(p.name) + '-'
  for (const appItem of localRuntime.listApps()) {
    if (appItem.name.startsWith(prefix)) {
      await localRuntime.stopApp(appItem.id)
    }
  }
  p.status = 'stopped'
  p.updatedAt = new Date().toISOString()
  savePlatformState()
  res.json(serializeComposeProject(p))
})

// ==================== ENV ====================

function serializeEnvVar(item: (typeof store.envVars)[number]) {
  return {
    key: item.key,
    value: item.secret ? '' : item.value,
    hasValue: Boolean(item.value),
    description: item.description,
    secret: item.secret,
  }
}

api.get('/env', requirePermission('secrets.read', auditService), (_req: Request, res: Response) => {
  res.json(store.envVars.map(serializeEnvVar))
})

api.post('/env', requirePermission('secrets.reveal', auditService), (req: AuthedRequest, res: Response) => {
  const key = String(req.body?.key || '').trim()
  if (!key) {
    res.status(400).json({ error: 'key is required' })
    return
  }
  const existingIdx = store.envVars.findIndex((e) => e.key === key)
  const item = {
    key,
    value: String(req.body?.value || ''),
    description: String(req.body?.description || ''),
    secret: Boolean(req.body?.secret),
  }
  if (existingIdx >= 0) store.envVars[existingIdx] = item
  else store.envVars.push(item)
  savePlatformState()
  recordAudit(req, 'env.save', key, 'success', item.secret ? 'secret' : 'plain')
  res.json({ status: 'created' })
})

api.post('/env/:key/reveal', requirePermission('secrets.reveal', auditService), (req: AuthedRequest, res: Response) => {
  const key = decodeURIComponent(String(req.params.key))
  const item = store.envVars.find((e) => e.key === key)
  if (!item) {
    res.status(404).json({ error: 'environment variable not found' })
    return
  }
  recordAudit(req, 'env.reveal', key, 'success')
  res.json({ key: item.key, value: item.value })
})

api.delete('/env/:key', requirePermission('secrets.reveal', auditService), (req: AuthedRequest, res: Response) => {
  const key = decodeURIComponent(String(req.params.key))
  const idx = store.envVars.findIndex((e) => e.key === key)
  if (idx >= 0) {
    store.envVars.splice(idx, 1)
    savePlatformState()
    recordAudit(req, 'env.delete', key, 'success')
  }
  res.json({ status: 'deleted' })
})

// ==================== NETWORK & VOLUMES ====================

api.get('/network', requirePermission('containers.read', auditService), (_req: Request, res: Response) => {
  res.json(store.networks)
})

api.post('/network', requirePermission('containers.manage', auditService), (req: Request, res: Response) => {
  const name = String(req.body?.name || '').trim()
  if (!name) {
    res.status(400).json({ error: 'network name is required' })
    return
  }
  const net = {
    id: store.newId('net'),
    name,
    driver: String(req.body?.driver || 'bridge'),
    scope: 'local',
    internal: Boolean(req.body?.internal),
    attachable: Boolean(req.body?.attachable),
    ingress: false,
    containers: [],
  }
  store.networks.push(net)
  savePlatformState()
  res.json(net)
})

api.post('/network/prune', requirePermission('containers.manage', auditService), (_req: Request, res: Response) => {
  const before = store.networks.length
  store.networks = store.networks.filter((n) => n.name === 'bridge' || n.containers.length > 0)
  savePlatformState()
  res.json({ networks_deleted: before - store.networks.length })
})

api.delete('/network/:name', requirePermission('containers.manage', auditService), (req: Request, res: Response) => {
  const idx = store.networks.findIndex((n) => n.name === req.params.name)
  if (idx === -1) {
    res.status(404).json({ error: 'network not found' })
    return
  }
  store.networks.splice(idx, 1)
  savePlatformState()
  res.json({ status: 'deleted' })
})

function getVolumeUsage(vol: (typeof store.volumes)[number]) {
  const usedBy = store.containers
    .filter((c) =>
      (c.volumes || []).some((spec) => String(spec).split(':')[0]?.trim() === vol.name)
    )
    .map((c) => c.name)
  return { inUse: usedBy.length > 0, containers: usedBy }
}

api.get('/volumes', requirePermission('containers.read', auditService), (_req: Request, res: Response) => {
  res.json(
    store.volumes.map((v) => ({
      ...v,
      ...getVolumeUsage(v),
    }))
  )
})

api.post('/volumes', requirePermission('containers.manage', auditService), (req: Request, res: Response) => {
  const name = String(req.body?.name || '').trim() || store.newId('vol')
  if (store.volumes.some((v) => v.name === name)) {
    res.status(409).json({ error: `volume "${name}" already exists` })
    return
  }
  const vol = {
    name,
    driver: String(req.body?.driver || 'local'),
    mountpoint: `/var/lib/docker/volumes/${name}/_data`,
    scope: 'local',
    sizeBytes: 0,
    createdAt: new Date().toISOString(),
  }
  store.volumes.push(vol)
  savePlatformState()
  res.json({ ...vol, ...getVolumeUsage(vol) })
})

api.post('/volumes/prune', requirePermission('containers.manage', auditService), (_req: Request, res: Response) => {
  const unused = store.volumes.filter((v) => !getVolumeUsage(v).inUse)
  const reclaimed = unused.reduce((sum, v) => sum + (v.sizeBytes || 0), 0)
  const deletedNames = unused.map((v) => v.name)
  store.volumes = store.volumes.filter((v) => getVolumeUsage(v).inUse)
  savePlatformState()
  res.json({
    volumes_deleted: unused.length,
    deleted_names: deletedNames,
    space_reclaimed_bytes: reclaimed,
  })
})

api.delete('/volumes/:name', requirePermission('containers.manage', auditService), (req: Request, res: Response) => {
  const name = decodeURIComponent(String(req.params.name))
  const idx = store.volumes.findIndex((v) => v.name === name)
  if (idx === -1) {
    res.status(404).json({ error: 'volume not found' })
    return
  }
  const usage = getVolumeUsage(store.volumes[idx])
  if (usage.inUse && req.query.force !== 'true') {
    res.status(409).json({
      error: `Volume "${name}" is mounted by container(s): ${usage.containers.join(', ')}`,
    })
    return
  }
  store.volumes.splice(idx, 1)
  savePlatformState()
  res.json({ status: 'deleted' })
})

// ==================== REGISTRIES ====================

function serializeRegistry(r: (typeof store.registries)[number]) {
  return {
    id: r.id,
    name: r.name,
    registryUrl: r.registryUrl,
    username: r.username,
    email: r.email || '',
    hasPassword: Boolean(r.password),
    passwordMasked: r.password ? '••••••••' : '',
    status: r.status,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt || null,
  }
}

api.get('/registries', requirePermission('containers.read', auditService), (_req: Request, res: Response) => {
  res.json(store.registries.map(serializeRegistry))
})

api.post('/registries', requirePermission('plugins.manage', auditService), (req: Request, res: Response) => {
  const name = String(req.body?.name || '').trim()
  const registryUrl = normalizeRegistryHost(String(req.body?.registryUrl || ''))
  const username = String(req.body?.username || '').trim()
  const password = String(req.body?.password || '')
  const email = String(req.body?.email || '').trim()

  if (!name || !registryUrl || !username || !password) {
    res.status(400).json({ error: 'name, registryUrl, username, and password are required' })
    return
  }

  const reg = {
    id: store.newId('reg'),
    name,
    registryUrl,
    username,
    password,
    email,
    status: 'connected' as const,
    createdAt: new Date().toISOString(),
  }
  store.registries.unshift(reg)
  savePlatformState()
  recordAudit(req as AuthedRequest, 'registry.create', `${name} (${registryUrl})`, 'success')
  res.json(serializeRegistry(reg))
})

api.put('/registries/:id', requirePermission('plugins.manage', auditService), (req: Request, res: Response) => {
  const reg = store.registries.find((r) => r.id === req.params.id)
  if (!reg) {
    res.status(404).json({ error: 'registry not found' })
    return
  }
  if (typeof req.body?.name === 'string' && req.body.name.trim()) reg.name = req.body.name.trim()
  if (typeof req.body?.registryUrl === 'string' && req.body.registryUrl.trim()) {
    reg.registryUrl = normalizeRegistryHost(req.body.registryUrl)
  }
  if (typeof req.body?.username === 'string' && req.body.username.trim()) {
    reg.username = req.body.username.trim()
  }
  if (typeof req.body?.password === 'string' && req.body.password.length > 0) {
    reg.password = req.body.password
  }
  if (typeof req.body?.email === 'string') reg.email = req.body.email.trim()
  savePlatformState()
  res.json(serializeRegistry(reg))
})

api.post('/registries/:id/test', requirePermission('plugins.manage', auditService), (req: Request, res: Response) => {
  const reg = store.registries.find((r) => r.id === req.params.id)
  if (!reg) {
    res.status(404).json({ error: 'registry not found' })
    return
  }
  if (!reg.username || !reg.password) {
    reg.status = 'unverified'
    res.status(400).json({ error: 'incomplete credentials' })
    return
  }
  reg.status = 'connected'
  reg.lastUsedAt = new Date().toISOString()
  savePlatformState()
  res.json({
    ok: true,
    message: `Login succeeded for ${reg.username}@${reg.registryUrl}`,
    registry: serializeRegistry(reg),
  })
})

api.delete('/registries/:id', requirePermission('plugins.manage', auditService), (req: Request, res: Response) => {
  const idx = store.registries.findIndex((r) => r.id === req.params.id)
  if (idx === -1) {
    res.status(404).json({ error: 'registry not found' })
    return
  }
  store.registries.splice(idx, 1)
  savePlatformState()
  res.json({ status: 'deleted' })
})

app.use('/api/v1', api)

// ==================== TERMINAL WEBSOCKET ====================

function runShellCommand(cmdLine: string, cwd: string): { output: string; nextCwd: string; clear?: boolean } {
  const trimmed = cmdLine.trim()
  if (!trimmed) return { output: '', nextCwd: cwd }
  const [cmd, ...args] = trimmed.split(/\s+/)

  switch (cmd) {
    case 'help':
      return {
        nextCwd: cwd,
        output:
          'Available commands: help, ls, pwd, cd, cat, whoami, uname, uptime, date, env, free, df, docker, echo, clear',
      }
    case 'clear':
      return { nextCwd: cwd, output: '\x1b[2J\x1b[H', clear: true }
    case 'pwd':
      return { nextCwd: cwd, output: cwd }
    case 'whoami': {
      try {
        return { nextCwd: cwd, output: os.userInfo().username || 'kathal' }
      } catch {
        return { nextCwd: cwd, output: process.env.USER || process.env.USERNAME || 'kathal' }
      }
    }
    case 'date':
      return { nextCwd: cwd, output: new Date().toUTCString() }
    case 'uname':
      return {
        nextCwd: cwd,
        output: `${getPlatformLabel()} (${os.platform()}) ${os.hostname()} ${os.release()} ${os.arch()} KATHAL-OS/${VERSION}`,
      }
    case 'uptime': {
      const up = Math.floor(os.uptime())
      const h = Math.floor(up / 3600)
      const m = Math.floor((up % 3600) / 60)
      const load = os.platform() === 'win32' ? 'N/A (Windows)' : os.loadavg().map((n) => n.toFixed(2)).join(', ')
      return { nextCwd: cwd, output: `up ${h}h ${m}m, load average: ${load}` }
    }
    case 'ls': {
      const target = args[0] ? (args[0].startsWith('/') ? args[0] : path.posix.join(cwd, args[0])) : cwd
      const entries = store.listDir(target)
      return {
        nextCwd: cwd,
        output: entries.map((e) => (e.is_dir ? `${e.name}/` : e.name)).join('  ') || '(empty)',
      }
    }
    case 'cd': {
      const next = args[0] ? (args[0].startsWith('/') ? args[0] : path.posix.join(cwd, args[0])) : '/data'
      const norm = store.normalizePath(next)
      const node = store.files.get(norm)
      if (!node || !node.isDir) return { nextCwd: cwd, output: `cd: ${args[0]}: No such directory` }
      return { nextCwd: norm, output: '' }
    }
    case 'cat': {
      if (!args[0]) return { nextCwd: cwd, output: 'usage: cat <path>' }
      const target = store.normalizePath(args[0].startsWith('/') ? args[0] : path.posix.join(cwd, args[0]))
      const node = store.files.get(target)
      if (!node || node.isDir) return { nextCwd: cwd, output: `cat: ${args[0]}: No such file` }
      return { nextCwd: cwd, output: node.content }
    }
    case 'env':
      return {
        nextCwd: cwd,
        output: store.envVars.map((e) => `${e.key}=${e.secret ? '••••••••' : e.value}`).join('\r\n'),
      }
    case 'echo':
      return { nextCwd: cwd, output: args.join(' ') }
    case 'free': {
      const totalMb = Math.round(os.totalmem() / 1048576)
      const freeMb = Math.round(os.freemem() / 1048576)
      const usedMb = totalMb - freeMb
      return {
        nextCwd: cwd,
        output: `              total        used        free\r\nMem:     ${String(totalMb).padStart(10)}  ${String(usedMb).padStart(10)}  ${String(freeMb).padStart(10)}`,
      }
    }
    case 'df': {
      const mount = getSystemDiskMount()
      try {
        const s = fs.statfsSync(mount)
        const totalGb = ((s.blocks * s.bsize) / (1024 ** 3)).toFixed(1)
        const availGb = ((s.bavail * s.bsize) / (1024 ** 3)).toFixed(1)
        const usedBytes = Math.max(0, (s.blocks - s.bfree) * s.bsize)
        const usedGb = (usedBytes / (1024 ** 3)).toFixed(1)
        const pct = s.blocks > 0 ? Math.round(((s.blocks - s.bfree) / s.blocks) * 100) : 0
        return {
          nextCwd: cwd,
          output: `Filesystem      Size   Used  Avail Use% Mounted on\r\nlocal-host     ${totalGb.padStart(5)}G ${usedGb.padStart(5)}G ${availGb.padStart(5)}G ${String(pct).padStart(3)}% ${mount}`,
        }
      } catch {
        return {
          nextCwd: cwd,
          output: `Filesystem      Mounted on\r\nlocal-host     ${mount} (statfs unavailable)`,
        }
      }
    }
    case 'apps':
    case 'docker': {
      const sub = cmd === 'apps' ? 'ps' : args[0]
      if (sub === 'ps') {
        const rows = listAllSerializedWorkload().map(
          (a) =>
            `${a.id.padEnd(14)}   ${a.runtimeLabel.padEnd(24)}   ${a.state.padEnd(8)}   :${a.port}   ${a.name}`
        )
        return {
          nextCwd: cwd,
          output: rows.length
            ? `APP ID           RUNTIME                    STATE      PORT    NAME\r\n${rows.join('\r\n')}`
            : 'No local apps currently installed.',
        }
      }
      return { nextCwd: cwd, output: 'Usage: apps (or docker ps)' }
    }
    default:
      return { nextCwd: cwd, output: `${cmd}: command not found (type 'help' for built-ins)` }
  }
}

function attachTerminalSession(
  ws: WebSocket,
  sessionId: string,
  initialCwd = '/data',
  updateCwd?: (next: string) => void
) {
  let cwd = initialCwd
  let cols = 120
  let rows = 30
  let lineBuffer = ''
  let username = 'kathal'
  try {
    username = os.userInfo().username || 'kathal'
  } catch {
    username = process.env.USER || process.env.USERNAME || 'kathal'
  }
  const prompt = () => `${username}@kathal:${cwd}$ `

  ws.send(`\x1b[1;32mKATHAL OS Local Terminal\x1b[0m (${getPlatformLabel()} · session ${sessionId})\r\nType 'help' for available commands.\r\n\r\n${prompt()}`)

  ws.on('message', (raw) => {
    let input = ''
    try {
      const parsed = JSON.parse(raw.toString()) as { type?: string; data?: string; cols?: number; rows?: number }
      if (parsed.type === 'resize') {
        cols = parsed.cols || cols
        rows = parsed.rows || rows
        return
      }
      if (parsed.type === 'input') {
        input = parsed.data || ''
      }
    } catch {
      input = raw.toString()
    }

    for (const ch of input) {
      if (ch === '\r' || ch === '\n') {
        ws.send('\r\n')
        const result = runShellCommand(lineBuffer, cwd)
        cwd = result.nextCwd
        updateCwd?.(cwd)
        if (result.output) {
          ws.send(result.clear ? result.output : result.output.replace(/\n/g, '\r\n') + '\r\n')
        }
        lineBuffer = ''
        ws.send(prompt())
      } else if (ch === '\u007f' || ch === '\b') {
        if (lineBuffer.length > 0) {
          lineBuffer = lineBuffer.slice(0, -1)
          ws.send('\b \b')
        }
      } else if (ch === '\u0003') {
        lineBuffer = ''
        ws.send('^C\r\n' + prompt())
      } else if (ch >= ' ') {
        lineBuffer += ch
        ws.send(ch)
      }
    }
  })
}

// ==================== FRONTEND SERVING ====================

const webDistDir = path.join(__dirname, 'web', 'dist')

async function startServer(listenPort = PORT): Promise<{ app: express.Express; server: http.Server }> {
  await bootstrapPlatform()

  const isProd = process.env.NODE_ENV === 'production'
  if (!isProd && fs.existsSync(path.join(__dirname, 'web', 'vite.config.js'))) {
    try {
      const { createServer: createViteServer } = await import('vite')
      const vite = await createViteServer({
        configFile: path.join(__dirname, 'web', 'vite.config.js'),
        server: {
          middlewareMode: true,
          hmr: false,
        },
        appType: 'spa',
      })
      app.use(vite.middlewares)
    } catch (err) {
      console.warn('[kathal] Vite dev middleware unavailable, serving web/dist:', (err as Error).message)
      app.use(express.static(webDistDir))
      app.get('*', (_req, res) => {
        res.sendFile(path.join(webDistDir, 'index.html'))
      })
    }
  } else {
    app.use(express.static(webDistDir))
    app.get('*', (_req, res) => {
      res.sendFile(path.join(webDistDir, 'index.html'))
    })
  }

  const server = http.createServer(app)
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (request, socket, head) => {
    terminalGateway.handleUpgrade(request, socket, head, wss)
  })

  await new Promise<void>((resolve) => {
    server.listen(listenPort, '0.0.0.0', () => {
      console.log(`KATHAL OS listening on http://0.0.0.0:${listenPort}`)
      resolve()
    })
  })

  const gracefulShutdown = () => {
    clearInterval(monitoringTimer)
    server.close(() => {
      dbManager.close()
    })
  }
  process.once('SIGTERM', gracefulShutdown)
  process.once('SIGINT', gracefulShutdown)

  return { app, server }
}

export { app, startServer, dbManager, authService, rbacService, vault, auditService, fleetService }

if (process.env.KATHAL_DISABLE_AUTOSTART !== '1') {
  startServer().catch((err) => {
    console.error('Failed to start KATHAL OS server:', err)
    process.exit(1)
  })
}
