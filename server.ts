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
const ADMIN_PASSWORD = process.env.KATHAL_ADMIN_PASSWORD || 'kathal'
const ADMIN_HASH = bcrypt.hashSync(ADMIN_PASSWORD, 10)
const JWT_SECRET = process.env.KATHAL_JWT_SECRET || crypto.randomBytes(32).toString('hex')

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

function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  if (req.path === '/login' || req.path === '/health') {
    next()
    return
  }
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
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

api.post('/login', async (req: Request, res: Response) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const password = String(req.body?.password || '')
  if (!email || !password) {
    res.status(400).json({ error: 'email and password are required' })
    return
  }
  if (!canAttemptLogin(email)) {
    res.status(429).json({ error: 'too many failed attempts, try again later' })
    return
  }
  const valid = email === ADMIN_EMAIL && (await bcrypt.compare(password, ADMIN_HASH))
  if (!valid) {
    recordLoginFailure(email)
    res.status(401).json({ error: 'invalid credentials' })
    return
  }
  loginAttempts.delete(email)
  const user = { id: 'admin', email: ADMIN_EMAIL, role: 'admin' }
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
  const stopped = store.containers.length - running
  res.json({
    system: sys,
    docker: {
      containersRunning: running,
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

// ==================== CONTAINERS & IMAGES ====================

api.get('/containers', (req: Request, res: Response) => {
  const showAll = req.query.all === 'true'
  const list = showAll ? store.containers : store.containers.filter((c) => c.state === 'running')
  res.json(list)
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

api.get('/images', (_req: Request, res: Response) => {
  res.json(store.images)
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
  res.json({ status: 'restored', message: 'backup restored' })
})

api.get('/backups/export', (_req: Request, res: Response) => {
  const payload = JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      version: VERSION,
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
  res.json({ status: 'imported', message: 'import complete' })
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

// ==================== GIT DEPLOY ====================

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
    status: 'idle' as const,
  }
  store.gitRepos.push(repo)
  store.gitHistory.set(repo.id, [])
  res.json(repo)
})

api.post('/git/repos/:id/deploy', (req: Request, res: Response) => {
  const repo = store.gitRepos.find((r) => r.id === req.params.id)
  if (!repo) {
    res.status(404).json({ error: 'repo not found' })
    return
  }
  const commit = crypto.randomBytes(4).toString('hex').slice(0, 7)
  const timestamp = new Date().toISOString()
  repo.status = 'success'
  repo.last_deploy = timestamp
  const log = {
    timestamp,
    commit,
    output: `Fetched ${repo.branch} from ${repo.url}\nChecked out ${commit}\nExecuted: ${repo.deploy_cmd || 'docker compose up -d'}\nDeployment succeeded.`,
  }
  const list = store.gitHistory.get(repo.id) || []
  list.unshift(log)
  store.gitHistory.set(repo.id, list)
  res.json(log)
})

api.get('/git/repos/:id/history', (req: Request, res: Response) => {
  res.json(store.gitHistory.get(String(req.params.id)) || [])
})

api.post('/git/webhook', (_req: Request, res: Response) => {
  const first = store.gitRepos[0]
  res.json({ repo_id: first?.id || 'none', status: 'triggered' })
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

function extractComposeServices(config: string): string[] {
  const lines = config.split('\n')
  const services: string[] = []
  let inServices = false
  for (const line of lines) {
    if (/^services:\s*$/.test(line)) {
      inServices = true
      continue
    }
    if (inServices) {
      if (/^\S/.test(line) && line.trim() !== '') {
        inServices = false
        continue
      }
      const match = /^ {2}([a-zA-Z0-9_-]+):\s*$/.exec(line)
      if (match) services.push(match[1])
    }
  }
  return services
}

api.get('/compose', (_req: Request, res: Response) => {
  res.json(store.composeProjects)
})

api.post('/compose', (req: Request, res: Response) => {
  const name = String(req.body?.name || '').trim()
  const config = String(req.body?.config || '')
  if (!name) {
    res.status(400).json({ error: 'project name is required' })
    return
  }
  const project = {
    name,
    workingDir: `/data/compose/${name}`,
    status: 'created' as const,
    services: extractComposeServices(config),
    config,
    updatedAt: new Date().toISOString(),
  }
  store.composeProjects.push(project)
  res.json(project)
})

api.post('/compose/validate', (req: Request, res: Response) => {
  const config = String(req.body?.config || '')
  const services = extractComposeServices(config)
  res.json({ valid: services.length > 0, services })
})

api.get('/compose/:name', (req: Request, res: Response) => {
  const p = store.composeProjects.find((item) => item.name === req.params.name)
  if (!p) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  res.json(p)
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
  res.json(p)
}

api.put('/compose/:name', handleUpdateCompose)
api.post('/compose/:name', handleUpdateCompose)

api.delete('/compose/:name', (req: Request, res: Response) => {
  const idx = store.composeProjects.findIndex((item) => item.name === req.params.name)
  if (idx === -1) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  store.composeProjects.splice(idx, 1)
  res.json({ status: 'deleted' })
})

api.post('/compose/:name/deploy', (req: Request, res: Response) => {
  const p = store.composeProjects.find((item) => item.name === req.params.name)
  if (!p) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  p.status = 'running'
  p.updatedAt = new Date().toISOString()
  res.json(p)
})

api.post('/compose/:name/stop', (req: Request, res: Response) => {
  const p = store.composeProjects.find((item) => item.name === req.params.name)
  if (!p) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  p.status = 'stopped'
  p.updatedAt = new Date().toISOString()
  res.json({ status: 'stopped' })
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

api.get('/volumes', (_req: Request, res: Response) => {
  res.json(store.volumes)
})

api.post('/volumes', (req: Request, res: Response) => {
  const name = String(req.body?.name || '').trim() || store.newId('vol')
  const vol = {
    name,
    driver: String(req.body?.driver || 'local'),
    mountpoint: `/var/lib/docker/volumes/${name}/_data`,
    scope: 'local',
  }
  store.volumes.push(vol)
  res.json(vol)
})

api.post('/volumes/prune', (_req: Request, res: Response) => {
  const before = store.volumes.length
  store.volumes = store.volumes.filter((v) => v.name === 'pgdata' || v.name === 'redisdata')
  res.json({ space_reclaimed_bytes: (before - store.volumes.length) * 1024 * 1024 })
})

api.delete('/volumes/:name', (req: Request, res: Response) => {
  const idx = store.volumes.findIndex((v) => v.name === req.params.name)
  if (idx === -1) {
    res.status(404).json({ error: 'volume not found' })
    return
  }
  store.volumes.splice(idx, 1)
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
