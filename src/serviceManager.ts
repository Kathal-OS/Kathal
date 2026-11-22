import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import http from 'node:http'
import crypto from 'node:crypto'
import { type ChildProcess } from 'node:child_process'
import type { AppHealthCheckDefinition } from './templateTypes.ts'
import { getRegistryAppById } from './appRegistry.ts'
import {
  sanitizeProcessName,
  sanitizeProcessEnv,
  validateBinaryExecutable,
  parseCommandArgs,
  resolveProcessWorkingDir,
  formatProcessUptime,
} from './nativeProcess.ts'
import {
  getDataDir,
  getVenvPaths,
  resolveNpmBinEntrypoint,
  spawnCrossPlatform,
  terminateProcessTree,
  samplePidMetricsCrossPlatform,
  refreshPlatformProcessTable,
  clearPidMetricHistory,
} from './platform.ts'

export interface ServiceLogEntry {
  timestamp: string
  stream: 'stdout' | 'stderr' | 'system'
  content: string
}

export interface ServiceResourceSample {
  timestamp: number
  cpuPercent: number
  memoryBytes: number
  memoryMb: number
  memoryPercent: number
  threads: number
}

export interface ServiceHealthResult {
  ok: boolean
  type: 'http' | 'tcp'
  path: string
  statusCode: number | null
  latencyMs: number
  checkedAt: string
  error?: string
}

export interface ManagedServiceRecord {
  id: string
  name: string
  displayName: string
  templateId: string | null
  source: 'service-engine' | 'app-store' | 'binary'
  runtime: string
  executable: string
  args: string[]
  workingDir: string
  dataDir: string
  port: number
  env: Record<string, string>
  healthCheck: AppHealthCheckDefinition
  state: 'running' | 'exited'
  pid: number | null
  created: number
  startedAt: number | null
  lastExitCode: number | null
  lastError: string | null
  restartCount: number
  lastHealth: ServiceHealthResult | null
  logs: ServiceLogEntry[]
  metricsHistory: ServiceResourceSample[]
  child?: ChildProcess
}

export interface SpawnServiceOptions {
  id?: string
  name: string
  displayName?: string
  templateId?: string | null
  source?: 'service-engine' | 'app-store' | 'binary'
  runtime?: string
  executable: string
  args?: string | string[]
  workingDir?: string
  dataDir?: string
  port?: number
  env?: Record<string, string>
  healthCheck?: Partial<AppHealthCheckDefinition>
}

const DEFAULT_HEALTH_CHECK: AppHealthCheckDefinition = {
  type: 'http',
  path: '/',
  expectedStatus: [200, 204, 301, 302, 401],
  intervalSeconds: 30,
  timeoutMs: 3000,
  retries: 3,
}

function isPidAlive(pid: number | null): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function checkPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer()
    tester.once('error', () => resolve(false))
    tester.once('listening', () => tester.close(() => resolve(true)))
    tester.listen(port, '127.0.0.1')
  })
}

function waitForTcpReady(port: number, timeoutMs = 4000): Promise<boolean> {
  const start = Date.now()
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = new net.Socket()
      socket.setTimeout(350)
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      const retry = () => {
        socket.destroy()
        if (Date.now() - start >= timeoutMs) resolve(false)
        else setTimeout(attempt, 180)
      }
      socket.once('error', retry)
      socket.once('timeout', retry)
      socket.connect(port, '127.0.0.1')
    }
    attempt()
  })
}

export function sampleServiceResourceMetrics(serviceKey: string, rootPid: number | null): ServiceResourceSample {
  const sample = samplePidMetricsCrossPlatform(rootPid, `svc:${serviceKey}`)
  return {
    timestamp: Date.now(),
    ...sample,
  }
}

export class ServiceManager {
  services = new Map<string, ManagedServiceRecord>()
  private appsRoot: string
  private stateFilePath: string
  private isPortExternallyReserved: (port: number, excludeId?: string) => boolean
  private monitorTimer: NodeJS.Timeout | null = null
  private healthTickCounter = 0

  constructor(opts: {
    appsRoot: string
    stateFilePath?: string
    isPortReserved?: (port: number, excludeId?: string) => boolean
  }) {
    this.appsRoot = path.resolve(opts.appsRoot)
    fs.mkdirSync(this.appsRoot, { recursive: true })
    this.stateFilePath = opts.stateFilePath
      ? path.resolve(opts.stateFilePath)
      : path.resolve(getDataDir(), 'services-state.json')
    this.isPortExternallyReserved = opts.isPortReserved || (() => false)

    this.loadPersistedState()
    this.startBackgroundMonitor()

    const cleanupAll = () => this.shutdownAllSync()
    process.once('exit', cleanupAll)
    process.once('SIGINT', cleanupAll)
    process.once('SIGTERM', cleanupAll)
  }

  private resolveConfinedDataDir(rawDataDir: string | undefined, workingDir: string): string {
    const defaultDataDir = path.join(workingDir, 'data')
    if (!rawDataDir) return defaultDataDir
    const trimmed = String(rawDataDir).trim()
    if (!trimmed || trimmed.includes('\0') || trimmed.includes('..')) {
      throw new Error('Data directory contains invalid path characters')
    }
    const resolved = path.isAbsolute(trimmed)
      ? path.resolve(trimmed)
      : path.resolve(workingDir, trimmed)
    if (
      resolved !== workingDir &&
      !resolved.startsWith(workingDir + path.sep) &&
      !resolved.startsWith(this.appsRoot + path.sep)
    ) {
      throw new Error(`Data directory must stay within ${this.appsRoot}`)
    }
    return resolved
  }

  private startBackgroundMonitor() {
    if (this.monitorTimer) return
    this.monitorTimer = setInterval(() => {
      this.healthTickCounter += 1
      void refreshPlatformProcessTable()
      for (const svc of this.services.values()) {
        if (svc.state !== 'running') continue
        if (!svc.child && !isPidAlive(svc.pid)) {
          svc.state = 'exited'
          svc.pid = null
          this.appendLog(svc, 'system', `[${svc.name}] Tracked PID is no longer active; marked exited`)
          this.saveStateToDisk()
          continue
        }
        const sample = sampleServiceResourceMetrics(svc.id, svc.pid)
        svc.metricsHistory.push(sample)
        if (svc.metricsHistory.length > 60) {
          svc.metricsHistory = svc.metricsHistory.slice(-60)
        }
        const intervalSamples = Math.max(3, Math.round((svc.healthCheck.intervalSeconds || 30) / 2))
        if (this.healthTickCounter % intervalSamples === 0) {
          void this.runHealthCheck(svc.id)
        }
      }
    }, 2000)
    this.monitorTimer.unref()
  }

  private loadPersistedState() {
    try {
      if (!fs.existsSync(this.stateFilePath)) return
      const raw = fs.readFileSync(this.stateFilePath, 'utf8')
      const parsed = JSON.parse(raw) as { services?: Partial<ManagedServiceRecord>[] }
      if (!Array.isArray(parsed.services)) return
      for (const item of parsed.services) {
        if (!item.id || !item.name || !item.executable) continue
        const cleanName = sanitizeProcessName(item.name)
        const safeWorkingDir =
          item.workingDir && path.resolve(item.workingDir).startsWith(this.appsRoot + path.sep)
            ? path.resolve(item.workingDir)
            : path.join(this.appsRoot, cleanName)
        const safeDataDir =
          item.dataDir && path.resolve(item.dataDir).startsWith(this.appsRoot + path.sep)
            ? path.resolve(item.dataDir)
            : path.join(safeWorkingDir, 'data')
        const alive = item.state === 'running' && isPidAlive(item.pid ?? null)
        const svc: ManagedServiceRecord = {
          id: item.id,
          name: cleanName,
          displayName: item.displayName || cleanName,
          templateId: item.templateId ?? null,
          source: item.source || 'service-engine',
          runtime: item.runtime || 'native',
          executable: item.executable,
          args: Array.isArray(item.args) ? item.args : [],
          workingDir: safeWorkingDir,
          dataDir: safeDataDir,
          port: Number(item.port) || 9300,
          env: item.env || {},
          healthCheck: item.healthCheck || { ...DEFAULT_HEALTH_CHECK },
          state: alive ? 'running' : 'exited',
          pid: alive ? (item.pid ?? null) : null,
          created: item.created || Math.floor(Date.now() / 1000),
          startedAt: alive ? (item.startedAt ?? Date.now()) : null,
          lastExitCode: item.lastExitCode ?? null,
          lastError: item.lastError ?? null,
          restartCount: item.restartCount ?? 0,
          lastHealth: item.lastHealth ?? null,
          logs: Array.isArray(item.logs) ? item.logs.slice(-200) : [],
          metricsHistory: [],
        }
        this.services.set(svc.id, svc)
      }
    } catch {
      // Ignore corrupt persisted state file on boot
    }
  }

  private saveStateToDisk() {
    try {
      fs.mkdirSync(path.dirname(this.stateFilePath), { recursive: true })
      const serializable = Array.from(this.services.values()).map((svc) => ({
        id: svc.id,
        name: svc.name,
        displayName: svc.displayName,
        templateId: svc.templateId,
        source: svc.source,
        runtime: svc.runtime,
        executable: svc.executable,
        args: svc.args,
        workingDir: svc.workingDir,
        dataDir: svc.dataDir,
        port: svc.port,
        env: svc.env,
        healthCheck: svc.healthCheck,
        state: svc.state,
        pid: svc.pid,
        created: svc.created,
        startedAt: svc.startedAt,
        lastExitCode: svc.lastExitCode,
        lastError: svc.lastError,
        restartCount: svc.restartCount,
        lastHealth: svc.lastHealth,
        logs: svc.logs.slice(-150),
      }))
      fs.writeFileSync(
        this.stateFilePath,
        `${JSON.stringify({ updatedAt: new Date().toISOString(), services: serializable }, null, 2)}\n`,
        'utf8'
      )
    } catch {
      // Non-fatal state write failure
    }
  }

  shutdownAllSync() {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer)
      this.monitorTimer = null
    }
    for (const svc of this.services.values()) {
      if (svc.child && !svc.child.killed) {
        void terminateProcessTree(svc.pid, svc.child)
      }
    }
  }

  async allocateFreePort(preferredPort?: number, excludeId?: string): Promise<number> {
    const usedLocal = new Set(
      Array.from(this.services.values())
        .filter((s) => s.id !== excludeId)
        .map((s) => s.port)
    )
    let candidate =
      preferredPort && Number.isInteger(preferredPort) && preferredPort >= 1024 && preferredPort <= 65535
        ? preferredPort
        : 9300
    for (let i = 0; i < 600; i += 1) {
      if (
        !usedLocal.has(candidate) &&
        !this.isPortExternallyReserved(candidate, excludeId) &&
        candidate !== Number(process.env.PORT || 3000)
      ) {
        if (await checkPortFree(candidate)) return candidate
      }
      candidate += 1
      if (candidate > 64000) candidate = 9300
    }
    throw new Error('No free host port available')
  }

  appendLog(svc: ManagedServiceRecord, stream: 'stdout' | 'stderr' | 'system', content: string) {
    const clean = content.trimEnd()
    if (!clean) return
    svc.logs.push({ timestamp: new Date().toISOString(), stream, content: clean })
    if (svc.logs.length > 1000) {
      svc.logs = svc.logs.slice(-1000)
    }
  }

  private resolvePlaceholders(value: string, svc: ManagedServiceRecord): string {
    return value
      .replace(/\{PORT\}/g, String(svc.port))
      .replace(/\$PORT\b/g, String(svc.port))
      .replace(/\{DATA_DIR\}/g, svc.dataDir)
      .replace(/\{DIR\}/g, svc.workingDir)
      .replace(/\{HOST\}/g, '127.0.0.1')
      .replace(/\{APP_NAME\}/g, svc.name)
  }

  async spawn(opts: SpawnServiceOptions): Promise<ManagedServiceRecord> {
    return this.registerAndSpawn(opts)
  }

  async registerAndSpawn(opts: SpawnServiceOptions): Promise<ManagedServiceRecord> {
    const cleanName = sanitizeProcessName(opts.name)
    const execCheck = validateBinaryExecutable(opts.executable)
    if (!execCheck.ok) {
      throw new Error(execCheck.error)
    }

    const parsedArgs = parseCommandArgs(opts.args)
    const workingDir = resolveProcessWorkingDir(opts.workingDir, this.appsRoot, cleanName)
    const dataDir = this.resolveConfinedDataDir(opts.dataDir, workingDir)
    fs.mkdirSync(dataDir, { recursive: true })
    const cleanEnv = sanitizeProcessEnv(opts.env)

    const existing = (opts.id ? this.services.get(opts.id) : undefined) || this.findByName(cleanName)
    if (existing && existing.state === 'running') {
      await this.stopService(existing.id)
    }

    const serviceId = existing?.id || opts.id || `svc-${crypto.randomBytes(5).toString('hex')}`
    const tmpl = opts.templateId ? getRegistryAppById(opts.templateId) : undefined
    const hc: AppHealthCheckDefinition = {
      type: opts.healthCheck?.type || tmpl?.healthCheck.type || 'http',
      path: opts.healthCheck?.path || tmpl?.healthCheck.path || '/',
      expectedStatus:
        opts.healthCheck?.expectedStatus ||
        tmpl?.healthCheck.expectedStatus ||
        DEFAULT_HEALTH_CHECK.expectedStatus,
      intervalSeconds: opts.healthCheck?.intervalSeconds || tmpl?.healthCheck.intervalSeconds || 30,
      timeoutMs: opts.healthCheck?.timeoutMs || tmpl?.healthCheck.timeoutMs || 3000,
      retries: opts.healthCheck?.retries || tmpl?.healthCheck.retries || 3,
    }

    const port = await this.allocateFreePort(opts.port || tmpl?.defaultPort, serviceId)

    const svc: ManagedServiceRecord = existing || {
      id: serviceId,
      name: cleanName,
      displayName: opts.displayName || tmpl?.name || cleanName,
      templateId: opts.templateId ?? null,
      source: opts.source || 'service-engine',
      runtime: opts.runtime || tmpl?.runtime || `Native (${path.basename(execCheck.executable)})`,
      executable: execCheck.executable,
      args: parsedArgs,
      workingDir,
      dataDir,
      port,
      env: cleanEnv,
      healthCheck: hc,
      state: 'exited',
      pid: null,
      created: Math.floor(Date.now() / 1000),
      startedAt: null,
      lastExitCode: null,
      lastError: null,
      restartCount: 0,
      lastHealth: null,
      logs: [],
      metricsHistory: [],
    }

    svc.displayName = opts.displayName || svc.displayName
    svc.templateId = opts.templateId !== undefined ? opts.templateId : svc.templateId
    svc.source = opts.source || svc.source
    svc.runtime = opts.runtime || svc.runtime
    svc.executable = execCheck.executable
    svc.args = parsedArgs
    svc.workingDir = workingDir
    svc.dataDir = dataDir
    svc.port = port
    svc.env = cleanEnv
    svc.healthCheck = hc

    this.services.set(svc.id, svc)
    await this.spawnServiceProcess(svc)
    return svc
  }

  async spawnFromRegistry(opts: {
    templateId: string
    name?: string
    port?: number
    env?: Record<string, string>
  }): Promise<ManagedServiceRecord> {
    const tmpl = getRegistryAppById(opts.templateId)
    if (!tmpl) {
      throw new Error(`Registry application "${opts.templateId}" not found`)
    }
    const cleanName = sanitizeProcessName(opts.name || tmpl.id)
    const appDir = resolveProcessWorkingDir(undefined, this.appsRoot, cleanName)
    const dataDir = path.join(appDir, 'data')
    fs.mkdirSync(dataDir, { recursive: true })

    let executable = tmpl.installSpec?.systemBinary || 'node'
    let args: string[] = tmpl.installSpec?.systemArgs || []

    if (tmpl.installMethod === 'npm' && tmpl.installSpec?.npmBin) {
      const resolvedNpm = resolveNpmBinEntrypoint(appDir, tmpl.installSpec.npmBin, tmpl.installSpec.npmPackage)
      if (!resolvedNpm) {
        throw new Error(`${tmpl.name} is not installed yet in ${appDir}. Use the App Store installer first.`)
      }
      executable = resolvedNpm.executable
      args = [...resolvedNpm.argsPrefix, ...(tmpl.installSpec.npmArgs || [])]
    } else if (tmpl.installMethod === 'python-venv') {
      const venv = getVenvPaths(path.join(appDir, '.venv'))
      const pyBin = venv.resolveTool(tmpl.installSpec?.pythonBin || 'python3')
      if (!fs.existsSync(pyBin)) {
        throw new Error(`${tmpl.name} Python virtual environment not installed yet. Use the App Store installer first.`)
      }
      executable = pyBin
      args = tmpl.installSpec?.pythonArgs || []
    } else if (tmpl.installMethod === 'binary-download') {
      const baseName = tmpl.installSpec?.binaryName || tmpl.id
      const winExe = path.join(appDir, 'bin', `${baseName}.exe`)
      const posixBin = path.join(appDir, 'bin', baseName)
      const binPath = process.platform === 'win32' && fs.existsSync(winExe) ? winExe : posixBin
      if (!fs.existsSync(binPath)) {
        throw new Error(`${tmpl.name} binary not downloaded yet. Use the App Store installer first.`)
      }
      executable = binPath
      args = tmpl.installSpec?.binaryArgs || []
    }

    return this.registerAndSpawn({
      name: cleanName,
      displayName: tmpl.name,
      templateId: tmpl.id,
      source: 'app-store',
      runtime: tmpl.runtime,
      executable,
      args,
      workingDir: appDir,
      dataDir,
      port: opts.port || tmpl.defaultPort,
      env: { ...tmpl.installCommands.env, ...(opts.env || {}) },
      healthCheck: tmpl.healthCheck,
    })
  }

  async spawnServiceProcess(svc: ManagedServiceRecord): Promise<void> {
    if (svc.child && svc.state === 'running') {
      await this.stopService(svc.id)
    }

    svc.port = await this.allocateFreePort(svc.port, svc.id)
    const resolvedArgs = svc.args.map((a) => this.resolvePlaceholders(a, svc))
    const resolvedEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(svc.env)) {
      resolvedEnv[k] = this.resolvePlaceholders(v, svc)
    }

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...resolvedEnv,
      PORT: String(svc.port),
      HOST: '127.0.0.1',
      DATA_DIR: svc.dataDir,
    }

    const displayCmd = `${path.basename(svc.executable)} ${resolvedArgs.join(' ')}`.trim()
    this.appendLog(svc, 'system', `[${svc.name}] Spawning via child_process: ${displayCmd} (cwd: ${svc.workingDir})`)

    const child = spawnCrossPlatform(svc.executable, resolvedArgs, {
      cwd: svc.workingDir,
      env: childEnv,
    })

    svc.child = child
    svc.pid = child.pid ?? null
    svc.state = 'running'
    svc.startedAt = Date.now()
    svc.lastExitCode = null
    svc.lastError = null

    child.stdout?.on('data', (buf: Buffer) => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) this.appendLog(svc, 'stdout', line)
      }
    })

    child.stderr?.on('data', (buf: Buffer) => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) this.appendLog(svc, 'stderr', line)
      }
    })

    child.on('error', (err) => {
      if (svc.child === child) {
        svc.state = 'exited'
        svc.pid = null
        svc.lastExitCode = 1
        svc.lastError = err.message
        svc.child = undefined
        this.appendLog(svc, 'stderr', `[${svc.name}] Process spawn error: ${err.message}`)
        this.saveStateToDisk()
      }
    })

    child.on('exit', (code) => {
      if (svc.child === child) {
        svc.state = 'exited'
        svc.pid = null
        svc.lastExitCode = code ?? 0
        svc.child = undefined
        this.appendLog(
          svc,
          code === 0 ? 'stdout' : 'stderr',
          `[${svc.name}] Process exited (code ${code ?? 0})`
        )
        this.saveStateToDisk()
      }
    })

    const tcpReady = await waitForTcpReady(svc.port, 4000)
    if (svc.lastError) {
      throw new Error(svc.lastError)
    }

    const initialSample = sampleServiceResourceMetrics(svc.id, svc.pid)
    svc.metricsHistory.push(initialSample)
    if (tcpReady && svc.state === 'running') {
      this.appendLog(svc, 'system', `[${svc.name}] Listening on 127.0.0.1:${svc.port} (PID ${svc.pid})`)
      await this.runHealthCheck(svc.id)
    } else if (svc.state === 'running') {
      this.appendLog(svc, 'system', `[${svc.name}] Running (PID ${svc.pid}, PORT=${svc.port})`)
    }
    this.saveStateToDisk()
  }

  async start(idOrName: string): Promise<ManagedServiceRecord | null> {
    return this.startService(idOrName)
  }

  async startService(idOrName: string): Promise<ManagedServiceRecord | null> {
    const svc = this.getService(idOrName)
    if (!svc) return null
    await this.spawnServiceProcess(svc)
    return svc
  }

  async stop(idOrName: string): Promise<ManagedServiceRecord | null> {
    return this.stopService(idOrName)
  }

  async stopService(idOrName: string): Promise<ManagedServiceRecord | null> {
    const svc = this.getService(idOrName)
    if (!svc) return null
    await terminateProcessTree(svc.pid, svc.child, 2500)

    svc.state = 'exited'
    svc.pid = null
    svc.child = undefined
    clearPidMetricHistory(`svc:${svc.id}`)
    this.appendLog(svc, 'system', `[${svc.name}] Stopped cleanly`)
    this.saveStateToDisk()
    return svc
  }

  async restart(idOrName: string): Promise<ManagedServiceRecord | null> {
    return this.restartService(idOrName)
  }

  async restartService(idOrName: string): Promise<ManagedServiceRecord | null> {
    const svc = this.getService(idOrName)
    if (!svc) return null
    svc.restartCount += 1
    this.appendLog(svc, 'system', `[${svc.name}] Restarting service (#${svc.restartCount})...`)
    await this.stopService(svc.id)
    await this.spawnServiceProcess(svc)
    return svc
  }

  async delete(idOrName: string, keepData = false): Promise<boolean> {
    return this.deleteService(idOrName, keepData)
  }

  async deleteService(idOrName: string, keepData = false): Promise<boolean> {
    const svc = this.getService(idOrName)
    if (!svc) return false
    await this.stopService(svc.id)
    this.services.delete(svc.id)
    clearPidMetricHistory(`svc:${svc.id}`)
    if (!keepData && svc.workingDir.startsWith(this.appsRoot + path.sep) && fs.existsSync(svc.workingDir)) {
      fs.rmSync(svc.workingDir, { recursive: true, force: true })
    }
    this.saveStateToDisk()
    return true
  }

  async checkHealth(idOrName: string): Promise<ServiceHealthResult | null> {
    return this.runHealthCheck(idOrName)
  }

  async runHealthCheck(idOrName: string): Promise<ServiceHealthResult | null> {
    const svc = this.getService(idOrName)
    if (!svc) return null
    const hc = svc.healthCheck || DEFAULT_HEALTH_CHECK
    const start = Date.now()
    const checkedAt = new Date().toISOString()

    if (hc.type === 'tcp') {
      const open = await waitForTcpReady(svc.port, Math.min(2000, hc.timeoutMs || 2000))
      const result: ServiceHealthResult = {
        ok: open,
        type: 'tcp',
        path: `tcp://127.0.0.1:${svc.port}`,
        statusCode: null,
        latencyMs: Date.now() - start,
        checkedAt,
        error: open ? undefined : 'TCP socket unreachable',
      }
      svc.lastHealth = result
      return result
    }

    const result = await new Promise<ServiceHealthResult>((resolve) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: svc.port,
          path: hc.path.startsWith('/') ? hc.path : `/${hc.path}`,
          method: 'GET',
          timeout: hc.timeoutMs || 3000,
        },
        (res) => {
          res.resume()
          const code = res.statusCode || 500
          const expected = hc.expectedStatus?.length ? hc.expectedStatus : DEFAULT_HEALTH_CHECK.expectedStatus
          const ok = expected.includes(code) || code < 500
          resolve({
            ok,
            type: 'http',
            path: hc.path,
            statusCode: code,
            latencyMs: Date.now() - start,
            checkedAt,
            error: ok ? undefined : `Unexpected HTTP status ${code}`,
          })
        }
      )
      req.on('timeout', () => {
        req.destroy()
        resolve({
          ok: false,
          type: 'http',
          path: hc.path,
          statusCode: null,
          latencyMs: Date.now() - start,
          checkedAt,
          error: 'Health check timed out',
        })
      })
      req.on('error', (err) => {
        resolve({
          ok: false,
          type: 'http',
          path: hc.path,
          statusCode: null,
          latencyMs: Date.now() - start,
          checkedAt,
          error: err.message,
        })
      })
      req.end()
    })

    svc.lastHealth = result
    return result
  }

  getLogs(idOrName: string, tail = 200, query = ''): ServiceLogEntry[] {
    const svc = this.getService(idOrName)
    if (!svc) return []
    const q = query.trim().toLowerCase()
    const filtered = q ? svc.logs.filter((l) => l.content.toLowerCase().includes(q)) : svc.logs
    return filtered.slice(-tail)
  }

  getFormattedLogs(idOrName: string, tail = 200, query = ''): string {
    return this.getLogs(idOrName, tail, query)
      .map((l) => `${l.timestamp} [${l.stream}] ${l.content}`)
      .join('\n')
  }

  getMetrics(idOrName: string): { current: ServiceResourceSample; history: ServiceResourceSample[] } | null {
    return this.getMetricsHistory(idOrName)
  }

  getMetricsHistory(idOrName: string): { current: ServiceResourceSample; history: ServiceResourceSample[] } | null {
    const svc = this.getService(idOrName)
    if (!svc) return null
    const current =
      svc.state === 'running'
        ? sampleServiceResourceMetrics(svc.id, svc.pid)
        : { timestamp: Date.now(), cpuPercent: 0, memoryBytes: 0, memoryMb: 0, memoryPercent: 0, threads: 0 }
    return {
      current,
      history: svc.metricsHistory,
    }
  }

  findByName(name: string): ManagedServiceRecord | undefined {
    const clean = sanitizeProcessName(name)
    return Array.from(this.services.values()).find((s) => s.name === clean)
  }

  getService(idOrName: string): ManagedServiceRecord | undefined {
    return this.services.get(idOrName) || this.findByName(idOrName)
  }

  listServices(): ManagedServiceRecord[] {
    return Array.from(this.services.values()).sort((a, b) => b.created - a.created)
  }

  serializeService(svc: ManagedServiceRecord) {
    const { uptimeSeconds, uptimeLabel } =
      svc.state === 'running'
        ? formatProcessUptime(svc.startedAt)
        : {
            uptimeSeconds: 0,
            uptimeLabel: svc.lastExitCode !== null ? `Exited (${svc.lastExitCode})` : 'Stopped',
          }
    const telemetry =
      svc.state === 'running'
        ? sampleServiceResourceMetrics(svc.id, svc.pid)
        : { timestamp: Date.now(), cpuPercent: 0, memoryBytes: 0, memoryMb: 0, memoryPercent: 0, threads: 0 }

    return {
      id: svc.id,
      name: svc.name,
      displayName: svc.displayName,
      image: svc.displayName,
      templateId: svc.templateId,
      source: svc.source,
      runtime: svc.runtime,
      runtimeLabel: svc.runtime,
      executable: svc.executable,
      args: svc.args,
      command: `${path.basename(svc.executable)} ${svc.args.join(' ')}`.trim(),
      workingDir: svc.workingDir,
      dataDir: svc.dataDir,
      port: svc.port,
      ports: [{ hostPort: svc.port, containerPort: svc.port, protocol: 'tcp' }],
      state: svc.state,
      status: svc.state === 'running' ? `Up ${uptimeLabel}` : uptimeLabel,
      pid: svc.pid,
      uptimeSeconds,
      uptimeLabel,
      cpuPercent: telemetry.cpuPercent,
      memoryBytes: telemetry.memoryBytes,
      memoryMb: telemetry.memoryMb,
      memoryPercent: telemetry.memoryPercent,
      threads: telemetry.threads,
      restartCount: svc.restartCount,
      healthCheck: svc.healthCheck,
      lastHealth: svc.lastHealth,
      liveUrl: `/live/${svc.name}/`,
      lastExitCode: svc.lastExitCode,
      lastError: svc.lastError,
      created: svc.created,
      metricsHistory: svc.metricsHistory.slice(-20),
    }
  }
}
