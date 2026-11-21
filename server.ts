import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import express, { type Request, type Response, type NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import multer from 'multer'
import { WebSocketServer, type WebSocket } from 'ws'
import { MemoryStore } from './src/store.ts'
import {
  SERVICE_TEMPLATES,
  CATEGORY_DEFINITIONS,
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
import { ProxyConfigManager } from './src/proxyConfig.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT) || 3000
const VERSION = process.env.KATHAL_VERSION || '0.1.0'
const ADMIN_EMAIL = (process.env.KATHAL_ADMIN_EMAIL || 'admin@kathal.local').toLowerCase()
const CONFIGURED_ADMIN_PASSWORD = (process.env.KATHAL_ADMIN_PASSWORD || '').trim()
const CONFIGURED_ADMIN_HASH = CONFIGURED_ADMIN_PASSWORD
  ? bcrypt.hashSync(CONFIGURED_ADMIN_PASSWORD, 10)
  : null
const JWT_SECRET = process.env.KATHAL_JWT_SECRET || crypto.randomBytes(32).toString('hex')

let claimedAdmin: { email: string; passwordHash: string } | null = null

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

const localRuntime = new LocalRuntimeManager()
const nativeProcesses: NativeProcessService = new NativeProcessService({
  appsRoot: localRuntime.getAppsRoot(),
  isPortReserved: (port: number): boolean =>
    localRuntime.listApps().some((a) => a.port === port) ||
    installerEngine.listAll().some((i) => i.port === port),
})
const installerEngine: AppInstallerEngine = new AppInstallerEngine({
  appsRoot: localRuntime.getAppsRoot(),
  isPortReserved: (port: number): boolean =>
    localRuntime.listApps().some((a) => a.port === port) ||
    nativeProcesses.listProcesses().some((p) => p.port === port),
})
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } })

// Background monitoring sample collector (1 sample/sec, 60-sample ring buffer)
const monitoringTimer = setInterval(() => {
  const runningApps = getAllRunningForMetrics()
  store.pushMonitoringSample(runningApps)
}, 1000)
monitoringTimer.unref()

// Login rate limiter
const loginAttempts = new Map<string, { failures: number; lastFail: number }>()
const MAX_LOGIN_FAILURES = 5
const LOGIN_LOCKOUT_MS = 5 * 60 * 1000

function canAttemptLogin(email: string): boolean {
  const entry = loginAttempts.get(email)
  if (!entry) return true
  if (Date.now() - entry.lastFail >= LOGIN_LOCKOUT_MS) {
    loginAttempts.delete(email)
    return true
  }
  return entry.failures < MAX_LOGIN_FAILURES
}

function recordLoginFailure(email: string) {
  const entry = loginAttempts.get(email) || { failures: 0, lastFail: 0 }
  entry.failures += 1
  entry.lastFail = Date.now()
  loginAttempts.set(email, entry)
}

interface AuthRequest extends Request {
  user?: { id: string; email: string; role: string }
}

const PUBLIC_API_PATHS = new Set(['/login', '/health', '/auth/status', '/auth/setup'])

function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  if (PUBLIC_API_PATHS.has(req.path)) {
    next()
    return
  }
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  if (!token) {
    res.status(401).json({ error: 'unauthorized' })
    return
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { id: string; email: string; role: string }
    req.user = decoded
    next()
  } catch {
    res.status(401).json({ error: 'invalid token' })
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

// Live Reverse Proxy Middleware MUST run BEFORE express.json() so request bodies stream cleanly
app.use((req: Request, res: Response, next: NextFunction) => {
  // 1. Built-in /live/<appName>/... path proxy (covers both local apps and native binary processes)
  const liveMatch = /^\/live\/([a-z0-9-_]+)(\/.*)?$/i.exec(req.path)
  if (liveMatch) {
    const requestedName = sanitizeAppName(liveMatch[1])
    const targetApp =
      localRuntime.findByName(requestedName) ||
      nativeProcesses.findByName(requestedName) ||
      installerEngine.findByName(requestedName)
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

app.use(express.json({ limit: '10mb' }))

const api = express.Router()
api.use(authMiddleware)

// ==================== AUTH & HEALTH ====================

api.get('/auth/status', (_req: Request, res: Response) => {
  const needsSetup = !CONFIGURED_ADMIN_HASH && !claimedAdmin
  res.json({
    needsSetup,
    adminEmail: CONFIGURED_ADMIN_HASH ? ADMIN_EMAIL : claimedAdmin?.email || ADMIN_EMAIL,
  })
})

api.post('/auth/setup', async (req: Request, res: Response) => {
  if (CONFIGURED_ADMIN_HASH || claimedAdmin) {
    res.status(409).json({ error: 'Admin account is already configured. Please sign in.' })
    return
  }
  const email = String(req.body?.email || '').trim().toLowerCase()
  const password = String(req.body?.password || '')
  if (!email || !email.includes('@')) {
    res.status(400).json({ error: 'Please enter a valid email address.' })
    return
  }
  if (password.length < 6 || password.length > 128) {
    res.status(400).json({ error: 'Password must be between 6 and 128 characters.' })
    return
  }
  const passwordHash = await bcrypt.hash(password, 10)
  // Double-check after async hash to ensure one-time atomic claim
  if (CONFIGURED_ADMIN_HASH || claimedAdmin) {
    res.status(409).json({ error: 'Admin account is already configured. Please sign in.' })
    return
  }
  claimedAdmin = { email, passwordHash }
  const user = { id: 'admin', email, role: 'admin' }
  const token = jwt.sign(user, JWT_SECRET, { expiresIn: '72h' })
  res.json({ token, user })
})

api.get('/auth/session', (req: AuthRequest, res: Response) => {
  res.json({ user: req.user })
})

api.post('/login', async (req: Request, res: Response) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const password = String(req.body?.password || '')
  if (!email || !password) {
    res.status(400).json({ error: 'email and password are required' })
    return
  }
  if (!CONFIGURED_ADMIN_HASH && !claimedAdmin) {
    res.status(403).json({
      error: 'Admin account has not been set up yet. Complete first-time setup first.',
      needsSetup: true,
    })
    return
  }
  if (!canAttemptLogin(email)) {
    res.status(429).json({ error: 'too many failed attempts, try again later' })
    return
  }
  const expectedEmail = CONFIGURED_ADMIN_HASH ? ADMIN_EMAIL : claimedAdmin!.email
  const expectedHash = CONFIGURED_ADMIN_HASH || claimedAdmin!.passwordHash
  const valid = email === expectedEmail && (await bcrypt.compare(password, expectedHash))
  if (!valid) {
    recordLoginFailure(email)
    res.status(401).json({ error: 'invalid credentials' })
    return
  }
  loginAttempts.delete(email)
  const user = { id: 'admin', email: expectedEmail, role: 'admin' }
  const token = jwt.sign(user, JWT_SECRET, { expiresIn: '72h' })
  res.json({ token, user })
})

api.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' })
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

function listAllSerializedWorkload() {
  const apps = localRuntime.listApps().map(serializeLocalApp)
  const binaries = nativeProcesses.listProcesses().map(serializeNativeProcess)
  const installed = installerEngine.listAll().map(serializeInstallation)
  return [...apps, ...binaries, ...installed].sort((a, b) => b.created - a.created)
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
  return [...apps, ...bins, ...installed]
}

// ==================== SYSTEM ====================

api.get('/status', (_req: Request, res: Response) => {
  const all = listAllSerializedWorkload()
  const runningApps = all.filter((a) => a.state === 'running').length
  res.json({
    version: VERSION,
    platform: os.platform(),
    arch: os.arch(),
    goVersion: `Node ${process.version}`,
    mode: 'local-native',
    dockerAvailable: false,
    runtimeEngine: 'Local Native Runtime (Node.js / Python 3 / Native Binaries)',
    runtimes: {
      node: process.version,
      python: 'Python 3',
      git: 'Git',
      nativeBinary: 'Enabled',
    },
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

api.get('/desktop/info', (_req: Request, res: Response) => {
  res.json({
    platform: os.platform(),
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

api.get('/metrics', (_req: Request, res: Response) => {
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

api.get('/system', (_req: Request, res: Response) => {
  res.json({
    version: VERSION,
    docker: false,
    mode: 'local-native',
    goVersion: `Node ${process.version}`,
    hostname: os.hostname(),
  })
})

function handleCheckUpdates(_req: Request, res: Response) {
  const all = listAllSerializedWorkload()
  res.json({
    currentVersion: VERSION,
    latestVersion: VERSION,
    updateAvailable: false,
    channel: 'stable',
    checkedAt: new Date().toISOString(),
    runtime: `Node ${process.version}`,
    appsChecked: all.length,
    message: `KATHAL OS v${VERSION} local runtime (${process.version}) is up to date across ${all.length} installed workload(s).`,
  })
}

api.get('/system/updates', handleCheckUpdates)
api.post('/system/check-updates', handleCheckUpdates)

// ==================== OPERATIONAL SETTINGS ====================

api.get('/settings', (_req: Request, res: Response) => {
  res.json(store.settings)
})

api.put('/settings', (req: Request, res: Response) => {
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
  res.json(store.settings)
})

api.post('/settings/regenerate-webhook', (_req: Request, res: Response) => {
  store.settings.webhookSecret = crypto.randomBytes(16).toString('hex')
  res.json({ webhookSecret: store.settings.webhookSecret })
})

api.post('/settings/reset', (_req: Request, res: Response) => {
  store.resetToDefaults()
  proxyConfig.saveToDisk(store.proxyRoutes, store.settings)
  res.json({ status: 'reset', settings: store.settings })
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

api.post('/deploy', handleDeployLocalRequest)

// ==================== NATIVE PROCESS MANAGEMENT (BINARY COMMANDS) ====================

api.get('/processes', (_req: Request, res: Response) => {
  res.json(nativeProcesses.listProcesses().map(serializeNativeProcess))
})

api.post('/processes', async (req: Request, res: Response) => {
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

api.post('/processes/:id/start', async (req: Request, res: Response) => {
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

api.post('/processes/:id/stop', async (req: Request, res: Response) => {
  const proc = await nativeProcesses.stopProcess(String(req.params.id))
  if (!proc) {
    res.status(404).json({ error: 'process not found' })
    return
  }
  res.json({ status: 'stopped', process: serializeNativeProcess(proc) })
})

api.post('/processes/:id/restart', async (req: Request, res: Response) => {
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

api.get('/processes/:id/logs', (req: Request, res: Response) => {
  const lines = nativeProcesses.getLogs(String(req.params.id), 200)
  res.json({ logs: lines.map((l) => `${l.timestamp} ${l.content}`).join('\n') })
})

api.post('/processes/:id/probe', async (req: Request, res: Response) => {
  const result = await nativeProcesses.probeProcess(String(req.params.id))
  res.json(result)
})

api.get('/native-processes', (req: Request, res: Response) => {
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

api.delete('/processes/:id', async (req: Request, res: Response) => {
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

api.get('/containers', (req: Request, res: Response) => {
  const showAll = req.query.all === 'true'
  const all = listAllSerializedWorkload()
  const filtered = showAll ? all : all.filter((a) => a.state === 'running')
  res.json(filtered)
})

api.post('/containers/prune', async (_req: Request, res: Response) => {
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

api.post('/containers/:id/start', async (req: Request, res: Response) => {
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
  } catch (err) {
    res.status(400).json({ error: (err as Error).message || 'Failed to start process' })
    return
  }
  res.status(404).json({ error: 'app not found' })
})

api.post('/containers/:id/stop', async (req: Request, res: Response) => {
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
  res.status(404).json({ error: 'app not found' })
})

api.post('/containers/:id/pause', async (req: Request, res: Response) => {
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
  res.status(404).json({ error: 'app not found' })
})

api.post('/containers/:id/restart', async (req: Request, res: Response) => {
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
  } catch (err) {
    res.status(400).json({ error: (err as Error).message || 'Failed to restart process' })
    return
  }
  res.status(404).json({ error: 'app not found' })
})

api.delete('/containers/:id/delete', async (req: Request, res: Response) => {
  const id = String(req.params.id)
  const existing = localRuntime.apps.get(id)
  if (existing) {
    const oldPort = existing.port
    await localRuntime.deleteApp(existing.id)
    store.proxyRoutes = store.proxyRoutes.filter((r) => r.target !== `http://127.0.0.1:${oldPort}` && r.target !== `http://localhost:${oldPort}`)
    proxyConfig.saveToDisk(store.proxyRoutes, store.settings)
    res.json({ status: 'deleted' })
    return
  }
  const existingInst = installerEngine.installations.get(id)
  if (existingInst) {
    const oldPort = existingInst.port
    await installerEngine.uninstall(existingInst.id)
    store.proxyRoutes = store.proxyRoutes.filter((r) => r.target !== `http://127.0.0.1:${oldPort}` && r.target !== `http://localhost:${oldPort}`)
    proxyConfig.saveToDisk(store.proxyRoutes, store.settings)
    res.json({ status: 'deleted' })
    return
  }
  const existingBin = nativeProcesses.processes.get(id)
  if (existingBin) {
    const oldPort = existingBin.port
    await nativeProcesses.deleteProcess(existingBin.id)
    store.proxyRoutes = store.proxyRoutes.filter((r) => r.target !== `http://127.0.0.1:${oldPort}` && r.target !== `http://localhost:${oldPort}`)
    proxyConfig.saveToDisk(store.proxyRoutes, store.settings)
    res.json({ status: 'deleted' })
    return
  }
  res.status(404).json({ error: 'app not found' })
})

api.get('/containers/:id/logs', (req: Request, res: Response) => {
  const id = String(req.params.id)
  const appLines = localRuntime.getAppLogs(id, 150)
  const inst = installerEngine.installations.get(id) || installerEngine.findByName(id)
  const lines =
    appLines.length > 0
      ? appLines
      : inst
      ? inst.logs.slice(-150)
      : nativeProcesses.getLogs(id, 150)
  res.json({ logs: lines.map((l) => `${l.timestamp} ${l.content}`).join('\n') })
})

api.post('/containers', handleDeployLocalRequest)

api.post('/apps/:id/domain', (req: Request, res: Response) => {
  const key = String(req.params.id)
  const targetApp = localRuntime.apps.get(key) || localRuntime.findByName(key)
  const targetBin = nativeProcesses.getProcess(key)
  const targetInst = installerEngine.installations.get(key) || installerEngine.findByName(key)
  const target = targetApp || targetBin || targetInst
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

api.get('/images', (_req: Request, res: Response) => {
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

api.post('/images/pull', (req: Request, res: Response) => {
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

api.post('/images/prune', (_req: Request, res: Response) => {
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

api.delete('/images/:id', (req: Request, res: Response) => {
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

api.get('/apps', (_req: Request, res: Response) => {
  res.json(Array.from(store.apps.values()))
})

api.post('/apps', (req: Request, res: Response) => {
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

api.get('/apps/:id', (req: Request, res: Response) => {
  const item = store.apps.get(String(req.params.id))
  if (!item) {
    res.status(404).json({ error: 'app not found' })
    return
  }
  res.json(item)
})

api.put('/apps/:id', (req: Request, res: Response) => {
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

api.delete('/apps/:id', (req: Request, res: Response) => {
  store.apps.delete(String(req.params.id))
  res.json({ status: 'deleted' })
})

// ==================== REVERSE PROXY & CUSTOM DOMAINS ====================

api.get('/proxy/config', (_req: Request, res: Response) => {
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

api.put('/proxy/config', (req: Request, res: Response) => {
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

api.get('/proxy', (_req: Request, res: Response) => {
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

api.post('/proxy', (req: Request, res: Response) => {
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
  res.json({ ...route, savedToJson: true, configUpdatedAt: saved.updatedAt })
})

api.get('/proxy/:id', (req: Request, res: Response) => {
  const route = store.proxyRoutes.find((r) => r.id === req.params.id)
  if (!route) {
    res.status(404).json({ error: 'route not found' })
    return
  }
  res.json(route)
})

api.put('/proxy/:id', (req: Request, res: Response) => {
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
  res.json(store.proxyRoutes[idx])
})

api.delete('/proxy/:id', (req: Request, res: Response) => {
  const idx = store.proxyRoutes.findIndex((r) => r.id === req.params.id)
  if (idx === -1) {
    res.status(404).json({ error: 'route not found' })
    return
  }
  store.proxyRoutes.splice(idx, 1)
  proxyConfig.saveToDisk(store.proxyRoutes, store.settings)
  res.json({ status: 'deleted' })
})

api.post('/proxy/:id/test', async (req: Request, res: Response) => {
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

api.post('/proxy/:id/enable', (req: Request, res: Response) => {
  const route = store.proxyRoutes.find((r) => r.id === req.params.id)
  if (!route) {
    res.status(404).json({ error: 'route not found' })
    return
  }
  route.enabled = true
  proxyConfig.saveToDisk(store.proxyRoutes, store.settings)
  res.json({ status: 'enabled' })
})

api.post('/proxy/:id/disable', (req: Request, res: Response) => {
  const route = store.proxyRoutes.find((r) => r.id === req.params.id)
  if (!route) {
    res.status(404).json({ error: 'route not found' })
    return
  }
  route.enabled = false
  proxyConfig.saveToDisk(store.proxyRoutes, store.settings)
  res.json({ status: 'disabled' })
})

// ==================== DATABASES ====================

const DB_DEFAULTS: Record<string, { port: number; user: string }> = {
  postgres: { port: 5432, user: 'postgres' },
  mysql: { port: 3306, user: 'root' },
  mongodb: { port: 27017, user: 'admin' },
  redis: { port: 6379, user: 'default' },
}

api.get('/databases', (_req: Request, res: Response) => {
  res.json(store.databases)
})

api.post('/databases', (req: Request, res: Response) => {
  const name = String(req.body?.name || '').trim()
  const type = String(req.body?.type || 'postgres') as 'postgres' | 'mysql' | 'mongodb' | 'redis'
  if (!name) {
    res.status(400).json({ error: 'database name is required' })
    return
  }
  const meta = DB_DEFAULTS[type] || DB_DEFAULTS.postgres
  const db = {
    id: store.newId('db'),
    name,
    type,
    port: meta.port + store.databases.length,
    user: meta.user,
    password: String(req.body?.password || '') || crypto.randomBytes(8).toString('hex'),
    status: 'running' as const,
  }
  store.databases.push(db)
  res.json(db)
})

api.get('/databases/:id', (req: Request, res: Response) => {
  const db = store.databases.find((d) => d.id === req.params.id)
  if (!db) {
    res.status(404).json({ error: 'database not found' })
    return
  }
  res.json(db)
})

api.delete('/databases/:id', (req: Request, res: Response) => {
  const idx = store.databases.findIndex((d) => d.id === req.params.id)
  if (idx === -1) {
    res.status(404).json({ error: 'database not found' })
    return
  }
  store.databases.splice(idx, 1)
  res.json({ status: 'deleted' })
})

api.post('/databases/:id/start', (req: Request, res: Response) => {
  const db = store.databases.find((d) => d.id === req.params.id)
  if (!db) {
    res.status(404).json({ error: 'database not found' })
    return
  }
  db.status = 'running'
  res.json({ status: 'started' })
})

api.post('/databases/:id/stop', (req: Request, res: Response) => {
  const db = store.databases.find((d) => d.id === req.params.id)
  if (!db) {
    res.status(404).json({ error: 'database not found' })
    return
  }
  db.status = 'stopped'
  res.json({ status: 'stopped' })
})

api.get('/databases/:id/connection', (req: Request, res: Response) => {
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
  res.json({ connection_string: conn })
})

// ==================== FILE MANAGER ====================

api.get('/files', (req: Request, res: Response) => {
  const dirPath = String(req.query.path || '/')
  res.json(store.listDir(dirPath))
})

api.get('/files/read', (req: Request, res: Response) => {
  const filePath = store.normalizePath(String(req.query.path || ''))
  const node = store.files.get(filePath)
  if (!node || node.isDir) {
    res.status(404).json({ error: 'file not found' })
    return
  }
  res.setHeader('Content-Type', 'application/octet-stream')
  res.send(node.content)
})

api.post('/files/write', (req: Request, res: Response) => {
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

api.post('/files/mkdir', (req: Request, res: Response) => {
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

api.delete('/files/delete', (req: Request, res: Response) => {
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

api.post('/files/rename', (req: Request, res: Response) => {
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

api.post('/files/upload', upload.single('file'), (req: Request, res: Response) => {
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

api.get('/backups', (_req: Request, res: Response) => {
  res.json(store.backups)
})

api.post('/backups', (req: Request, res: Response) => {
  const rawName = String(req.body?.name || '').trim()
  const name = rawName || `backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`
  const bkp = {
    id: store.newId('bkp'),
    name,
    created_at: new Date().toISOString(),
    size: '4.8 MB',
  }
  store.backups.unshift(bkp)
  res.json(bkp)
})

api.delete('/backups/:id', (req: Request, res: Response) => {
  const idx = store.backups.findIndex((b) => b.id === req.params.id)
  if (idx === -1) {
    res.status(404).json({ error: 'backup not found' })
    return
  }
  store.backups.splice(idx, 1)
  res.json({ status: 'deleted' })
})

api.post('/backups/:id/restore', (req: Request, res: Response) => {
  const bkp = store.backups.find((b) => b.id === req.params.id)
  if (!bkp) {
    res.status(404).json({ error: 'backup not found' })
    return
  }
  res.json({ status: 'restored', message: `Snapshot "${bkp.name}" restored cleanly.` })
})

api.get('/backups/export', (_req: Request, res: Response) => {
  const payload = JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      version: VERSION,
      settings: store.settings,
      proxyRoutes: store.proxyRoutes,
      databases: store.databases,
      composeProjects: store.composeProjects,
      envVars: store.envVars,
    },
    null,
    2
  )
  res.setHeader('Content-Type', 'application/zip')
  res.setHeader('Content-Disposition', 'attachment; filename="kathal-export.zip"')
  res.send(Buffer.from(payload, 'utf8'))
})

api.post('/backups/import', upload.single('file'), (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: 'no file provided' })
    return
  }
  try {
    const parsed = JSON.parse(req.file.buffer.toString('utf8'))
    if (Array.isArray(parsed.proxyRoutes)) store.proxyRoutes = parsed.proxyRoutes
    if (Array.isArray(parsed.databases)) store.databases = parsed.databases
    if (Array.isArray(parsed.composeProjects)) store.composeProjects = parsed.composeProjects
    if (Array.isArray(parsed.envVars)) store.envVars = parsed.envVars
    if (parsed.settings && typeof parsed.settings === 'object') {
      store.settings = { ...store.settings, ...parsed.settings }
    }
  } catch {
    // Non-JSON archive still acknowledged cleanly
  }
  res.json({ status: 'imported', message: 'Backup archive imported successfully.' })
})

// ==================== APP STORE, RUNTIMES & INSTALLATION ENGINE ====================

api.get('/runtimes', async (req: Request, res: Response) => {
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

  let list = SERVICE_TEMPLATES.filter((t) => {
    if (category && t.category !== category) return false
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

api.get('/templates', (req: Request, res: Response) => {
  res.json(filterAndSortTemplates(req.query))
})

api.get('/templates/search', (req: Request, res: Response) => {
  res.json(filterAndSortTemplates(req.query))
})

api.get('/templates/categories', (_req: Request, res: Response) => {
  const counts: Record<string, number> = {}
  for (const t of SERVICE_TEMPLATES) {
    counts[t.category] = (counts[t.category] || 0) + 1
  }
  res.json({
    counts,
    definitions: CATEGORY_DEFINITIONS,
    total: SERVICE_TEMPLATES.length,
  })
})

api.get('/templates/:id/preflight', async (req: Request, res: Response) => {
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

api.get('/templates/:id', async (req: Request, res: Response) => {
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

api.post('/templates/:id/install', handleTemplateInstallRequest)
api.post('/templates/:id/deploy', handleTemplateInstallRequest)

api.get('/installations', (_req: Request, res: Response) => {
  res.json(installerEngine.listAll().map(serializeInstallation))
})

api.get('/installations/:id', (req: Request, res: Response) => {
  const id = String(req.params.id)
  const rec = installerEngine.installations.get(id) || installerEngine.findByName(id) || installerEngine.findByTemplateId(id)
  if (!rec) {
    res.status(404).json({ error: 'installation not found' })
    return
  }
  res.json(serializeInstallation(rec))
})

api.post('/installations/:id/start', async (req: Request, res: Response) => {
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

api.post('/installations/:id/stop', async (req: Request, res: Response) => {
  const rec = await installerEngine.stopApp(String(req.params.id))
  if (!rec) {
    res.status(404).json({ error: 'installation not found' })
    return
  }
  res.json({ status: 'stopped', installation: serializeInstallation(rec) })
})

api.post('/installations/:id/restart', async (req: Request, res: Response) => {
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

api.post('/installations/:id/health', async (req: Request, res: Response) => {
  const health = await installerEngine.checkHealth(String(req.params.id))
  if (!health) {
    res.status(404).json({ error: 'installation not found' })
    return
  }
  res.json(health)
})

api.put('/installations/:id/env', (req: Request, res: Response) => {
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

api.delete('/installations/:id', async (req: Request, res: Response) => {
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

api.get('/git/repos', (_req: Request, res: Response) => {
  res.json(store.gitRepos)
})

api.post('/git/repos', (req: Request, res: Response) => {
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
  res.json(repo)
})

api.put('/git/repos/:id', (req: Request, res: Response) => {
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
  res.json(repo)
})

api.delete('/git/repos/:id', (req: Request, res: Response) => {
  const idx = store.gitRepos.findIndex((r) => r.id === req.params.id)
  if (idx === -1) {
    res.status(404).json({ error: 'repo not found' })
    return
  }
  store.gitRepos.splice(idx, 1)
  store.gitHistory.delete(String(req.params.id))
  res.json({ status: 'deleted' })
})

api.post('/git/repos/:id/deploy', async (req: Request, res: Response) => {
  const repo = store.gitRepos.find((r) => r.id === req.params.id)
  if (!repo) {
    res.status(404).json({ error: 'repo not found' })
    return
  }
  try {
    const log = await executeGitDeployment(repo)
    res.json(log)
  } catch (err) {
    res.status(400).json({ error: (err as Error).message || 'Git deploy failed' })
  }
})

api.get('/git/repos/:id/history', (req: Request, res: Response) => {
  res.json(store.gitHistory.get(String(req.params.id)) || [])
})

api.post('/git/webhook', async (req: Request, res: Response) => {
  const repoId = String(req.body?.repo_id || req.query?.repo_id || '')
  const target = (repoId ? store.gitRepos.find((r) => r.id === repoId) : store.gitRepos[0])
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
    res.json({ repo_id: target.id, status: 'deployed', ...log })
  } catch (err) {
    res.status(400).json({ error: (err as Error).message || 'Webhook deploy failed' })
  }
})

// ==================== WEB TERMINAL ====================

const terminalSessions = new Map<string, { id: string; cols: number; rows: number; cwd: string }>()

api.post('/terminal/sessions', (req: Request, res: Response) => {
  const id = String(req.body?.id || `term-${Date.now()}`)
  const cols = Number(req.body?.cols) || 120
  const rows = Number(req.body?.rows) || 30
  const session = { id, cols, rows, cwd: '/data' }
  terminalSessions.set(id, session)
  res.json(session)
})

api.delete('/terminal/sessions/:id', (req: Request, res: Response) => {
  terminalSessions.delete(String(req.params.id))
  res.json({ status: 'closed' })
})

// ==================== MONITORING ====================

api.get('/monitoring/current', (_req: Request, res: Response) => {
  const runningApps = getAllRunningForMetrics()
  const latest = store.monitoringHistory[store.monitoringHistory.length - 1]
  res.json(latest || store.collectMonitoringSample(Date.now(), runningApps))
})

api.get('/monitoring/history', (_req: Request, res: Response) => {
  res.json(store.monitoringHistory)
})

// ==================== LOGS ====================

api.get('/logs/containers', (_req: Request, res: Response) => {
  res.json(
    listAllSerializedWorkload().map((s) => ({
      id: s.id,
      name: s.name,
      image: s.runtimeLabel,
      status: s.status,
    }))
  )
})

api.get('/logs', (req: Request, res: Response) => {
  const containerId = String(req.query.container || '')
  const tail = Number(req.query.tail) || 100
  const filter = String(req.query.filter || '')
  const appLogs = localRuntime.getAppLogs(containerId, tail, filter)
  res.json(appLogs.length > 0 ? appLogs : nativeProcesses.getLogs(containerId, tail, filter))
})

api.post('/logs/search', (req: Request, res: Response) => {
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

api.get('/compose', (_req: Request, res: Response) => {
  syncDiscoveredComposeFiles()
  res.json(store.composeProjects.map(serializeComposeProject))
})

api.post('/compose/scan', (_req: Request, res: Response) => {
  syncDiscoveredComposeFiles()
  res.json(store.composeProjects.map(serializeComposeProject))
})

api.post('/compose', (req: Request, res: Response) => {
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
  res.json(serializeComposeProject(project))
})

api.post('/compose/validate', (req: Request, res: Response) => {
  const config = String(req.body?.config || '')
  const services = extractComposeServices(config)
  res.json({ valid: services.length > 0, services })
})

api.get('/compose/:name', (req: Request, res: Response) => {
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
  res.json(serializeComposeProject(p))
}

api.put('/compose/:name', handleUpdateCompose)
api.post('/compose/:name', handleUpdateCompose)

api.delete('/compose/:name', async (req: Request, res: Response) => {
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
  return { ...serializeComposeProject(p), deployedCount }
}

api.post('/compose/:name/start', async (req: Request, res: Response) => {
  const p = store.composeProjects.find((item) => item.name === req.params.name)
  if (!p) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  res.json(await startComposeProject(p))
})

api.post('/compose/:name/deploy', async (req: Request, res: Response) => {
  const p = store.composeProjects.find((item) => item.name === req.params.name)
  if (!p) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  res.json(await startComposeProject(p))
})

api.post('/compose/:name/restart', async (req: Request, res: Response) => {
  const p = store.composeProjects.find((item) => item.name === req.params.name)
  if (!p) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const result = await startComposeProject(p)
  res.json({ ...result, restarted: true })
})

api.post('/compose/:name/stop', async (req: Request, res: Response) => {
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
  res.json(serializeComposeProject(p))
})

// ==================== ENV ====================

api.get('/env', (_req: Request, res: Response) => {
  res.json(store.envVars)
})

api.post('/env', (req: Request, res: Response) => {
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
  res.json({ status: 'created' })
})

api.delete('/env/:key', (req: Request, res: Response) => {
  const idx = store.envVars.findIndex((e) => e.key === req.params.key)
  if (idx >= 0) store.envVars.splice(idx, 1)
  res.json({ status: 'deleted' })
})

// ==================== NETWORK & VOLUMES ====================

api.get('/network', (_req: Request, res: Response) => {
  res.json(store.networks)
})

api.post('/network', (req: Request, res: Response) => {
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
  res.json(net)
})

api.post('/network/prune', (_req: Request, res: Response) => {
  const before = store.networks.length
  store.networks = store.networks.filter((n) => n.name === 'bridge' || n.containers.length > 0)
  res.json({ networks_deleted: before - store.networks.length })
})

api.delete('/network/:name', (req: Request, res: Response) => {
  const idx = store.networks.findIndex((n) => n.name === req.params.name)
  if (idx === -1) {
    res.status(404).json({ error: 'network not found' })
    return
  }
  store.networks.splice(idx, 1)
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

api.get('/volumes', (_req: Request, res: Response) => {
  res.json(
    store.volumes.map((v) => ({
      ...v,
      ...getVolumeUsage(v),
    }))
  )
})

api.post('/volumes', (req: Request, res: Response) => {
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
  res.json({ ...vol, ...getVolumeUsage(vol) })
})

api.post('/volumes/prune', (_req: Request, res: Response) => {
  const unused = store.volumes.filter((v) => !getVolumeUsage(v).inUse)
  const reclaimed = unused.reduce((sum, v) => sum + (v.sizeBytes || 0), 0)
  const deletedNames = unused.map((v) => v.name)
  store.volumes = store.volumes.filter((v) => getVolumeUsage(v).inUse)
  res.json({
    volumes_deleted: unused.length,
    deleted_names: deletedNames,
    space_reclaimed_bytes: reclaimed,
  })
})

api.delete('/volumes/:name', (req: Request, res: Response) => {
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

api.get('/registries', (_req: Request, res: Response) => {
  res.json(store.registries.map(serializeRegistry))
})

api.post('/registries', (req: Request, res: Response) => {
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
  res.json(serializeRegistry(reg))
})

api.put('/registries/:id', (req: Request, res: Response) => {
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
  res.json(serializeRegistry(reg))
})

api.post('/registries/:id/test', (req: Request, res: Response) => {
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
  res.json({
    ok: true,
    message: `Login succeeded for ${reg.username}@${reg.registryUrl}`,
    registry: serializeRegistry(reg),
  })
})

api.delete('/registries/:id', (req: Request, res: Response) => {
  const idx = store.registries.findIndex((r) => r.id === req.params.id)
  if (idx === -1) {
    res.status(404).json({ error: 'registry not found' })
    return
  }
  store.registries.splice(idx, 1)
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
    case 'whoami':
      return { nextCwd: cwd, output: 'root' }
    case 'date':
      return { nextCwd: cwd, output: new Date().toUTCString() }
    case 'uname':
      return { nextCwd: cwd, output: `Linux ${os.hostname()} ${os.release()} ${os.arch()} KATHAL-OS/${VERSION}` }
    case 'uptime': {
      const up = Math.floor(os.uptime())
      const h = Math.floor(up / 3600)
      const m = Math.floor((up % 3600) / 60)
      return { nextCwd: cwd, output: `up ${h}h ${m}m, load average: ${os.loadavg().map((n) => n.toFixed(2)).join(', ')}` }
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
      if (!node || !node.isDir) return { nextCwd: cwd, output: `bash: cd: ${args[0]}: No such directory` }
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
    case 'df':
      return {
        nextCwd: cwd,
        output: 'Filesystem      Size  Used Avail Use% Mounted on\r\noverlay         100G   34G   66G  34% /',
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
      return { nextCwd: cwd, output: `bash: ${cmd}: command not found (type 'help' for built-ins)` }
  }
}

function attachTerminalSession(ws: WebSocket, sessionId: string) {
  const session = terminalSessions.get(sessionId) || { id: sessionId, cols: 120, rows: 30, cwd: '/data' }
  let lineBuffer = ''
  const prompt = () => `root@kathal:${session.cwd}# `

  ws.send(`\x1b[1;32mKATHAL OS Web Terminal\x1b[0m (session ${sessionId})\r\nType 'help' for available commands.\r\n\r\n${prompt()}`)

  ws.on('message', (raw) => {
    let input = ''
    try {
      const parsed = JSON.parse(raw.toString()) as { type?: string; data?: string; cols?: number; rows?: number }
      if (parsed.type === 'resize') {
        session.cols = parsed.cols || session.cols
        session.rows = parsed.rows || session.rows
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
        const result = runShellCommand(lineBuffer, session.cwd)
        session.cwd = result.nextCwd
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

async function startServer() {
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
    const reqUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
    const match = /^\/api\/v1\/terminal\/ws\/([^/]+)$/.exec(reqUrl.pathname)
    if (!match) {
      socket.destroy()
      return
    }
    const token = reqUrl.searchParams.get('token') || ''
    try {
      jwt.verify(token, JWT_SECRET)
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      attachTerminalSession(ws, match[1])
    })
  })

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`KATHAL OS listening on http://0.0.0.0:${PORT}`)
  })
}

startServer().catch((err) => {
  console.error('Failed to start KATHAL OS server:', err)
  process.exit(1)
})
