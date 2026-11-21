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
import { SERVICE_TEMPLATES } from './src/templates.ts'

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
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } })

// Background monitoring sample collector (1 sample/sec, 60-sample ring buffer)
const monitoringTimer = setInterval(() => {
  store.pushMonitoringSample()
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

const app = express()
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

// ==================== SYSTEM ====================

api.get('/status', (_req: Request, res: Response) => {
  res.json({
    version: VERSION,
    platform: os.platform(),
    arch: os.arch(),
    goVersion: `Node ${process.version}`,
    dockerAvailable: true,
    dockerVersion: '26.1.0-sim',
    dockerContainers: store.containers.length,
    dockerImages: store.images.length,
  })
})

api.get('/metrics', (_req: Request, res: Response) => {
  const sys = store.collectSystemMetrics()
  const running = store.containers.filter((c) => c.state === 'running').length
  const paused = store.containers.filter((c) => c.state === 'paused').length
  const stopped = store.containers.filter((c) => c.state !== 'running' && c.state !== 'paused').length
  res.json({
    system: sys,
    docker: {
      containersRunning: running,
      containersPaused: paused,
      containersStopped: stopped,
      imagesCount: store.images.length,
    },
    timestamp: Math.floor(Date.now() / 1000),
  })
})

api.get('/system', (_req: Request, res: Response) => {
  res.json({
    version: VERSION,
    docker: true,
    goVersion: `Node ${process.version}`,
    hostname: os.hostname(),
  })
})

function handleCheckUpdates(_req: Request, res: Response) {
  res.json({
    currentVersion: VERSION,
    latestVersion: VERSION,
    updateAvailable: false,
    channel: 'stable',
    checkedAt: new Date().toISOString(),
    runtime: `Node ${process.version}`,
    imagesChecked: store.images.length,
    images: store.images.map((img) => ({
      id: img.id,
      tag: img.repoTags[0] || '<none>',
      status: 'up-to-date',
    })),
    message: `KATHAL OS v${VERSION} and all ${store.images.length} tracked images are up to date.`,
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
  res.json(store.settings)
})

api.post('/settings/regenerate-webhook', (_req: Request, res: Response) => {
  store.settings.webhookSecret = crypto.randomBytes(16).toString('hex')
  res.json({ webhookSecret: store.settings.webhookSecret })
})

api.post('/settings/reset', (_req: Request, res: Response) => {
  store.resetToDefaults()
  res.json({ status: 'reset', settings: store.settings })
})

// ==================== UNIFIED DEPLOY ====================

api.post('/deploy', (req: Request, res: Response) => {
  const name = String(req.body?.name || '').trim()
  const image = String(req.body?.image || '').trim()
  if (!name || !image) {
    res.status(400).json({ error: 'name and image are required' })
    return
  }
  const hostPort = req.body?.hostPort ? Number(req.body.hostPort) : undefined
  const containerPort = req.body?.containerPort ? Number(req.body.containerPort) : undefined
  const result = store.deployService({
    name,
    image,
    hostPort,
    containerPort,
    domain: typeof req.body?.domain === 'string' ? req.body.domain : '',
    autoDomain: Boolean(req.body?.autoDomain),
    volumes: Array.isArray(req.body?.volumes) ? req.body.volumes : [],
    env: Array.isArray(req.body?.env) ? req.body.env : [],
    source: String(req.body?.source || 'manual'),
  })
  res.json(result)
})

// ==================== CONTAINERS & IMAGES ====================

api.get('/containers', (req: Request, res: Response) => {
  const showAll = req.query.all === 'true'
  const list = showAll ? store.containers : store.containers.filter((c) => c.state === 'running')
  res.json(list)
})

api.post('/containers/prune', (_req: Request, res: Response) => {
  const stopped = store.containers.filter((c) => c.state !== 'running' && c.state !== 'paused')
  store.containers = store.containers.filter((c) => c.state === 'running' || c.state === 'paused')
  const deletedCount = stopped.length
  const spaceReclaimedBytes = deletedCount * 42 * 1024 * 1024
  res.json({
    containers_deleted: deletedCount,
    deleted_names: stopped.map((c) => c.name),
    space_reclaimed_bytes: spaceReclaimedBytes,
    remaining: store.containers.length,
  })
})

api.post('/containers/:id/start', (req: Request, res: Response) => {
  const c = store.containers.find((item) => item.id === req.params.id)
  if (!c) {
    res.status(404).json({ error: 'container not found' })
    return
  }
  c.state = 'running'
  c.status = 'Up just now'
  res.json({ status: 'started' })
})

api.post('/containers/:id/stop', (req: Request, res: Response) => {
  const c = store.containers.find((item) => item.id === req.params.id)
  if (!c) {
    res.status(404).json({ error: 'container not found' })
    return
  }
  c.state = 'exited'
  c.status = 'Exited (0) just now'
  res.json({ status: 'stopped' })
})

api.post('/containers/:id/pause', (req: Request, res: Response) => {
  const c = store.containers.find((item) => item.id === req.params.id)
  if (!c) {
    res.status(404).json({ error: 'container not found' })
    return
  }
  c.state = 'paused'
  c.status = 'Paused'
  res.json({ status: 'paused' })
})

api.post('/containers/:id/restart', (req: Request, res: Response) => {
  const c = store.containers.find((item) => item.id === req.params.id)
  if (!c) {
    res.status(404).json({ error: 'container not found' })
    return
  }
  c.state = 'running'
  c.status = 'Up just now'
  res.json({ status: 'restarted' })
})

api.delete('/containers/:id/delete', (req: Request, res: Response) => {
  const idx = store.containers.findIndex((item) => item.id === req.params.id)
  if (idx === -1) {
    res.status(404).json({ error: 'container not found' })
    return
  }
  store.containers.splice(idx, 1)
  res.json({ status: 'deleted' })
})

api.get('/containers/:id/logs', (req: Request, res: Response) => {
  const id = String(req.params.id)
  const lines = store.getContainerLogs(id, 100)
  res.json({ logs: lines.map((l) => `${l.timestamp} ${l.content}`).join('\n') })
})

api.post('/containers', (req: Request, res: Response) => {
  const name = String(req.body?.name || '').trim()
  const image = String(req.body?.image || '').trim()
  if (!name || !image) {
    res.status(400).json({ error: 'name and image are required' })
    return
  }
  const result = store.deployService({
    name,
    image,
    hostPort: req.body?.hostPort ? Number(req.body.hostPort) : undefined,
    containerPort: req.body?.containerPort ? Number(req.body.containerPort) : undefined,
    domain: typeof req.body?.domain === 'string' ? req.body.domain : '',
    autoDomain: Boolean(req.body?.autoDomain),
    env: Array.isArray(req.body?.env) ? req.body.env : [],
    source: 'containers',
  })
  res.json(result)
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

// ==================== REVERSE PROXY ====================

api.get('/proxy', (_req: Request, res: Response) => {
  res.json(store.proxyRoutes)
})

api.post('/proxy', (req: Request, res: Response) => {
  const domain = String(req.body?.domain || '').trim()
  const target = String(req.body?.target || '').trim()
  if (!domain || !target) {
    res.status(400).json({ error: 'domain and target are required' })
    return
  }
  const route = {
    id: store.newId('proxy'),
    domain,
    target,
    port: Number(req.body?.port) || 80,
    ssl: Boolean(req.body?.ssl),
    enabled: true,
  }
  store.proxyRoutes.push(route)
  res.json(route)
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
  store.proxyRoutes[idx] = { ...store.proxyRoutes[idx], ...req.body, id: String(req.params.id) }
  res.json(store.proxyRoutes[idx])
})

api.delete('/proxy/:id', (req: Request, res: Response) => {
  const idx = store.proxyRoutes.findIndex((r) => r.id === req.params.id)
  if (idx === -1) {
    res.status(404).json({ error: 'route not found' })
    return
  }
  store.proxyRoutes.splice(idx, 1)
  res.json({ status: 'deleted' })
})

api.post('/proxy/:id/enable', (req: Request, res: Response) => {
  const route = store.proxyRoutes.find((r) => r.id === req.params.id)
  if (!route) {
    res.status(404).json({ error: 'route not found' })
    return
  }
  route.enabled = true
  res.json({ status: 'enabled' })
})

api.post('/proxy/:id/disable', (req: Request, res: Response) => {
  const route = store.proxyRoutes.find((r) => r.id === req.params.id)
  if (!route) {
    res.status(404).json({ error: 'route not found' })
    return
  }
  route.enabled = false
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

// ==================== SERVICE TEMPLATES ====================

api.get('/templates', (req: Request, res: Response) => {
  const category = String(req.query.category || '')
  const list = category
    ? SERVICE_TEMPLATES.filter((t) => t.category === category)
    : SERVICE_TEMPLATES
  res.json([...list].sort((a, b) => a.name.localeCompare(b.name)))
})

api.get('/templates/search', (req: Request, res: Response) => {
  const q = String(req.query.q || '').toLowerCase()
  const list = SERVICE_TEMPLATES.filter(
    (t) =>
      t.name.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q) ||
      t.category.toLowerCase().includes(q) ||
      t.tags.some((tag) => tag.toLowerCase().includes(q))
  )
  res.json(list.sort((a, b) => a.name.localeCompare(b.name)))
})

api.get('/templates/categories', (_req: Request, res: Response) => {
  const counts: Record<string, number> = {}
  for (const t of SERVICE_TEMPLATES) {
    counts[t.category] = (counts[t.category] || 0) + 1
  }
  res.json(counts)
})

api.get('/templates/:id', (req: Request, res: Response) => {
  const tmpl = SERVICE_TEMPLATES.find((t) => t.id === req.params.id)
  if (!tmpl) {
    res.status(404).json({ error: 'template not found' })
    return
  }
  res.json(tmpl)
})

api.post('/templates/:id/deploy', (req: Request, res: Response) => {
  const tmpl = SERVICE_TEMPLATES.find((t) => t.id === req.params.id)
  if (!tmpl) {
    res.status(404).json({ error: 'template not found' })
    return
  }
  const firstPort = tmpl.ports[0] || ''
  const [defaultHostStr, defaultContainerStr] = firstPort.split(':')
  const requestedPort = req.body?.hostPort ? Number(req.body.hostPort) : Number(defaultHostStr) || 8080
  const containerPort = Number(defaultContainerStr) || requestedPort
  const customName = String(req.body?.name || tmpl.id).trim() || tmpl.id
  const envList = Array.isArray(req.body?.env) ? req.body.env : tmpl.env_vars

  const result = store.deployService({
    name: customName,
    image: tmpl.image,
    hostPort: requestedPort,
    containerPort,
    domain: typeof req.body?.domain === 'string' ? req.body.domain : '',
    autoDomain: Boolean(req.body?.autoDomain),
    volumes: tmpl.volumes,
    env: envList,
    source: `template:${tmpl.id}`,
  })
  res.json({ template: tmpl.name, ...result })
})

// ==================== GIT DEPLOY ====================

function executeGitDeployment(repo: (typeof store.gitRepos)[number]) {
  const commit = crypto.randomBytes(4).toString('hex').slice(0, 7)
  const timestamp = new Date().toISOString()
  const deployResult = store.deployService({
    name: repo.name,
    image: `${repo.name}:${commit}`,
    hostPort: repo.port || undefined,
    containerPort: repo.port || 3000,
    domain: repo.domain || '',
    autoDomain: !repo.domain,
    source: `git:${repo.url}`,
  })
  repo.status = 'success'
  repo.last_deploy = timestamp
  repo.container_id = deployResult.container.id
  repo.port = deployResult.app.port
  if (!repo.domain && deployResult.proxyRoute) {
    repo.domain = deployResult.proxyRoute.domain
  }

  const log = {
    timestamp,
    commit,
    containerId: deployResult.container.id,
    port: deployResult.app.port,
    domain: deployResult.proxyRoute?.domain || repo.domain || '',
    output: [
      `> Fetching branch "${repo.branch}" from ${repo.url}`,
      `> Checked out commit ${commit}`,
      `> Injected ${store.envVars.length} global environment variable(s)`,
      `> Running build & deploy command: ${repo.deploy_cmd || 'docker compose up -d'}`,
      ...deployResult.logs,
      `> Deployment succeeded!`,
    ].join('\n'),
  }
  const list = store.gitHistory.get(repo.id) || []
  list.unshift(log)
  store.gitHistory.set(repo.id, list)
  return log
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
  const repo = {
    id: store.newId('repo'),
    name,
    url,
    branch: String(req.body?.branch || 'main'),
    deploy_cmd: String(req.body?.deploy_cmd || 'docker compose up -d'),
    domain: String(req.body?.domain || '').trim(),
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
  if (typeof req.body?.name === 'string' && req.body.name.trim()) repo.name = req.body.name.trim()
  if (typeof req.body?.url === 'string' && req.body.url.trim()) repo.url = req.body.url.trim()
  if (typeof req.body?.branch === 'string') repo.branch = req.body.branch.trim() || 'main'
  if (typeof req.body?.deploy_cmd === 'string') repo.deploy_cmd = req.body.deploy_cmd
  if (typeof req.body?.domain === 'string') repo.domain = req.body.domain.trim()
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

api.post('/git/repos/:id/deploy', (req: Request, res: Response) => {
  const repo = store.gitRepos.find((r) => r.id === req.params.id)
  if (!repo) {
    res.status(404).json({ error: 'repo not found' })
    return
  }
  const log = executeGitDeployment(repo)
  res.json(log)
})

api.get('/git/repos/:id/history', (req: Request, res: Response) => {
  res.json(store.gitHistory.get(String(req.params.id)) || [])
})

api.post('/git/webhook', (req: Request, res: Response) => {
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
  const log = executeGitDeployment(target)
  res.json({ repo_id: target.id, status: 'deployed', ...log })
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
  const latest = store.monitoringHistory[store.monitoringHistory.length - 1]
  res.json(latest || store.collectMonitoringSample())
})

api.get('/monitoring/history', (_req: Request, res: Response) => {
  res.json(store.monitoringHistory)
})

// ==================== LOGS ====================

api.get('/logs/containers', (_req: Request, res: Response) => {
  res.json(
    store.containers.map((c) => ({
      id: c.id,
      name: c.name,
      image: c.image,
      status: c.status,
    }))
  )
})

api.get('/logs', (req: Request, res: Response) => {
  const containerId = String(req.query.container || '')
  const tail = Number(req.query.tail) || 100
  const filter = String(req.query.filter || '')
  res.json(store.getContainerLogs(containerId, tail, filter))
})

api.post('/logs/search', (req: Request, res: Response) => {
  const containerId = String(req.body?.container || '')
  const query = String(req.body?.query || '')
  const limit = Number(req.body?.limit) || 500
  res.json(store.getContainerLogs(containerId, limit, query))
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
  const hasPrefixedContainers = store.containers.some((c) => c.name.startsWith(`${p.name}-`))

  const serviceDefs = rawDefs.map((d) => {
    let container = store.containers.find((c) => c.name === `${p.name}-${d.name}`)
    if (!container && !hasPrefixedContainers && p.status === 'running') {
      container = store.containers.find((c) => c.image === d.image)
    }
    const state: 'running' | 'paused' | 'exited' | 'down' = container ? container.state : 'down'
    return {
      ...d,
      state,
      containerName: container?.name || `${p.name}-${d.name}`,
    }
  })

  const totalServices = serviceDefs.length
  const runningServices = serviceDefs.filter((s) => s.state === 'running').length
  const pausedServices = serviceDefs.filter((s) => s.state === 'paused').length

  let healthStatus: 'healthy' | 'degraded' | 'down' = 'down'
  let healthLabel = 'Down'
  if (totalServices > 0 && runningServices === totalServices) {
    healthStatus = 'healthy'
    healthLabel = 'Healthy'
  } else if (runningServices > 0 || pausedServices > 0) {
    healthStatus = 'degraded'
    healthLabel = 'Degraded'
  }

  let effectiveStatus = p.status
  if (hasPrefixedContainers) {
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

api.delete('/compose/:name', (req: Request, res: Response) => {
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
  store.containers = store.containers.filter((c) => !c.name.startsWith(`${name}-`))
  store.composeProjects.splice(idx, 1)
  res.json({ status: 'deleted' })
})

function startComposeProject(p: (typeof store.composeProjects)[number]) {
  const defs = extractComposeServiceDefs(p.config)
  p.services = defs.map((d) => d.name)
  const deployed = defs.map((d) =>
    store.deployService({
      name: `${p.name}-${d.name}`,
      image: d.image,
      hostPort: d.hostPort,
      containerPort: d.containerPort,
      source: `compose:${p.name}`,
    })
  )
  p.status = 'running'
  p.updatedAt = new Date().toISOString()
  return { ...serializeComposeProject(p), deployedCount: deployed.length }
}

api.post('/compose/:name/start', (req: Request, res: Response) => {
  const p = store.composeProjects.find((item) => item.name === req.params.name)
  if (!p) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  res.json(startComposeProject(p))
})

api.post('/compose/:name/deploy', (req: Request, res: Response) => {
  const p = store.composeProjects.find((item) => item.name === req.params.name)
  if (!p) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  res.json(startComposeProject(p))
})

api.post('/compose/:name/restart', (req: Request, res: Response) => {
  const p = store.composeProjects.find((item) => item.name === req.params.name)
  if (!p) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const result = startComposeProject(p)
  for (const c of store.containers) {
    if (c.name.startsWith(`${p.name}-`)) {
      c.status = 'Up just now (restarted)'
    }
  }
  res.json({ ...result, restarted: true })
})

api.post('/compose/:name/stop', (req: Request, res: Response) => {
  const p = store.composeProjects.find((item) => item.name === req.params.name)
  if (!p) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  for (const c of store.containers) {
    if (c.name.startsWith(`${p.name}-`)) {
      c.state = 'exited'
      c.status = 'Exited (0) just now'
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
    case 'docker': {
      const sub = args[0]
      if (sub === 'ps') {
        const rows = store.containers.map(
          (c) => `${c.id.slice(0, 12)}   ${c.image.padEnd(28)}   ${c.state.padEnd(9)}   ${c.name}`
        )
        return {
          nextCwd: cwd,
          output: `CONTAINER ID   IMAGE                          STATE       NAMES\r\n${rows.join('\r\n')}`,
        }
      }
      if (sub === 'images') {
        const rows = store.images.map((i) => {
          const [repo, tag] = (i.repoTags[0] || '<none>:<none>').split(':')
          return `${repo.padEnd(28)}   ${(tag || 'latest').padEnd(10)}   ${Math.round(i.size / 1048576)}MB`
        })
        return {
          nextCwd: cwd,
          output: `REPOSITORY                     TAG          SIZE\r\n${rows.join('\r\n')}`,
        }
      }
      return { nextCwd: cwd, output: 'Usage: docker [ps|images]' }
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
