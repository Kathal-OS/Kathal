import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import http from 'node:http'
import crypto from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'

export interface NativeProcessLogLine {
  timestamp: string
  stream: 'stdout' | 'stderr'
  content: string
}

export interface NativeProcessInstance {
  id: string
  name: string
  label: string
  executable: string
  args: string[]
  workingDir: string
  port: number
  state: 'running' | 'exited'
  pid: number | null
  env: Record<string, string>
  created: number
  startedAt: number | null
  lastExitCode: number | null
  lastError: string | null
  logs: NativeProcessLogLine[]
  child?: ChildProcess
}

const SHELL_METACHARS = /[;|&$`><\r\n\0]/
const BLOCKED_ENV_KEYS = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'IFS',
])
const BLOCKED_SYSTEM_DIRS = ['/etc', '/proc', '/sys', '/dev', '/boot', '/root']

export function sanitizeProcessName(rawName: string): string {
  const cleaned = String(rawName || '')
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return cleaned || `proc-${crypto.randomBytes(2).toString('hex')}`
}

export function validateBinaryExecutable(rawExec: string): { ok: true; executable: string } | { ok: false; error: string } {
  const trimmed = String(rawExec || '').trim()
  if (!trimmed) {
    return { ok: false, error: 'Binary executable command is required (e.g. node, python3, npx)' }
  }
  if (SHELL_METACHARS.test(trimmed)) {
    return { ok: false, error: 'Executable contains forbidden shell characters' }
  }
  if (trimmed.includes('..')) {
    return { ok: false, error: 'Executable path must not contain parent directory traversal (..)' }
  }

  // Allow explicit absolute/relative paths to an existing executable file
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    const resolved = path.resolve(trimmed)
    if (!fs.existsSync(resolved)) {
      return { ok: false, error: `Executable not found at path: ${resolved}` }
    }
    const stat = fs.statSync(resolved)
    if (!stat.isFile()) {
      return { ok: false, error: `Executable path is not a file: ${resolved}` }
    }
    return { ok: true, executable: resolved }
  }

  if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
    return { ok: false, error: 'Executable name may only contain letters, numbers, dots, underscores, and hyphens' }
  }

  // Resolve "node" reliably to the active Node binary
  if (trimmed === 'node') {
    return { ok: true, executable: process.execPath }
  }

  return { ok: true, executable: trimmed }
}

export function parseCommandArgs(rawArgs?: string | string[]): string[] {
  if (Array.isArray(rawArgs)) {
    return rawArgs.map((a) => {
      const s = String(a ?? '')
      if (s.includes('\0')) throw new Error('Arguments contain forbidden null byte')
      return s
    })
  }
  const input = String(rawArgs || '').trim()
  if (!input) return []
  if (input.includes('\0')) throw new Error('Arguments contain forbidden null byte')

  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaping = false

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]
    if (escaping) {
      current += ch
      escaping = false
      continue
    }
    if (ch === '\\' && quote !== "'") {
      escaping = true
      continue
    }
    if (quote) {
      if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (quote) {
    throw new Error('Unterminated quote in command arguments')
  }
  if (current.length > 0) {
    tokens.push(current)
  }
  return tokens
}

export function resolveProcessWorkingDir(
  rawDir: string | undefined,
  appsRoot: string,
  procName: string
): string {
  fs.mkdirSync(appsRoot, { recursive: true })
  const trimmed = String(rawDir || '').trim()
  if (!trimmed) {
    const dir = path.resolve(appsRoot, sanitizeProcessName(procName))
    if (!dir.startsWith(appsRoot + path.sep)) {
      throw new Error('Invalid working directory path')
    }
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  if (trimmed.includes('\0') || trimmed.includes('..')) {
    throw new Error('Working directory contains invalid path traversal')
  }

  if (!path.isAbsolute(trimmed)) {
    const dir = path.resolve(appsRoot, trimmed)
    if (!dir.startsWith(appsRoot + path.sep) && dir !== appsRoot) {
      throw new Error('Relative working directory must stay inside workspace apps directory')
    }
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  const resolved = path.resolve(trimmed)
  for (const blocked of BLOCKED_SYSTEM_DIRS) {
    if (resolved === blocked || resolved.startsWith(blocked + path.sep)) {
      throw new Error(`Working directory "${resolved}" is a protected system path`)
    }
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Working directory does not exist: ${resolved}`)
  }
  return resolved
}

export function sanitizeProcessEnv(rawEnv?: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {}
  if (!rawEnv) return result
  for (const [k, v] of Object.entries(rawEnv)) {
    const key = String(k || '').trim()
    if (!key) continue
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    if (BLOCKED_ENV_KEYS.has(key.toUpperCase())) continue
    result[key] = String(v ?? '')
  }
  return result
}

function checkPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer()
    tester.once('error', () => resolve(false))
    tester.once('listening', () => {
      tester.close(() => resolve(true))
    })
    tester.listen(port, '127.0.0.1')
  })
}

function waitForPortOpen(port: number, timeoutMs = 3500): Promise<boolean> {
  const start = Date.now()
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = new net.Socket()
      socket.setTimeout(300)
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      const retry = () => {
        socket.destroy()
        if (Date.now() - start >= timeoutMs) {
          resolve(false)
        } else {
          setTimeout(attempt, 120)
        }
      }
      socket.once('error', retry)
      socket.once('timeout', retry)
      socket.connect(port, '127.0.0.1')
    }
    attempt()
  })
}

export interface ProcessResourceMetrics {
  cpuPercent: number
  memoryBytes: number
  memoryMb: number
  memoryPercent: number
  threads: number
}

const cpuTickHistory = new Map<number, { procTicks: number; tsMs: number }>()

export function samplePidResourceMetrics(pid: number | null): ProcessResourceMetrics {
  if (!pid || pid <= 0) {
    return { cpuPercent: 0, memoryBytes: 0, memoryMb: 0, memoryPercent: 0, threads: 0 }
  }

  let memoryBytes = 0
  let threads = 1
  let cpuPercent = 0
  const totalMem = os.totalmem() || 1

  try {
    const statusText = fs.readFileSync(`/proc/${pid}/status`, 'utf8')
    const rssMatch = /^VmRSS:\s+(\d+)\s+kB/m.exec(statusText)
    if (rssMatch) {
      memoryBytes = Number(rssMatch[1]) * 1024
    }
    const threadsMatch = /^Threads:\s+(\d+)/m.exec(statusText)
    if (threadsMatch) {
      threads = Number(threadsMatch[1]) || 1
    }
  } catch {
    // Process exited or non-Linux host
  }

  try {
    const statText = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const closeParen = statText.lastIndexOf(')')
    if (closeParen !== -1) {
      const fields = statText.slice(closeParen + 2).trim().split(/\s+/)
      // fields[0] is state (field 3), utime is field 14 -> index 11, stime is field 15 -> index 12
      const utime = Number(fields[11] || 0)
      const stime = Number(fields[12] || 0)
      const procTicks = utime + stime
      const now = Date.now()
      const prev = cpuTickHistory.get(pid)
      if (prev && now > prev.tsMs) {
        const deltaSec = (now - prev.tsMs) / 1000
        const deltaTicks = Math.max(0, procTicks - prev.procTicks)
        // Standard Linux USER_HZ = 100 ticks/sec
        const pct = ((deltaTicks / 100) / deltaSec) * 100
        cpuPercent = Number(Math.min(100 * Math.max(1, os.cpus().length), Math.max(0, pct)).toFixed(1))
      }
      cpuTickHistory.set(pid, { procTicks, tsMs: now })
    }
  } catch {
    cpuTickHistory.delete(pid)
  }

  const memoryMb = Number((memoryBytes / (1024 * 1024)).toFixed(1))
  const memoryPercent = Number(((memoryBytes / totalMem) * 100).toFixed(2))
  return {
    cpuPercent,
    memoryBytes,
    memoryMb,
    memoryPercent,
    threads,
  }
}

export function formatProcessUptime(startedAt: number | null): { uptimeSeconds: number; uptimeLabel: string } {
  if (!startedAt) return { uptimeSeconds: 0, uptimeLabel: 'Stopped' }
  const sec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  if (sec < 60) return { uptimeSeconds: sec, uptimeLabel: `${sec}s` }
  const mins = Math.floor(sec / 60)
  const remSec = sec % 60
  if (mins < 60) return { uptimeSeconds: sec, uptimeLabel: `${mins}m ${remSec}s` }
  const hours = Math.floor(mins / 60)
  const remMins = mins % 60
  if (hours < 24) return { uptimeSeconds: sec, uptimeLabel: `${hours}h ${remMins}m` }
  const days = Math.floor(hours / 24)
  return { uptimeSeconds: sec, uptimeLabel: `${days}d ${hours % 24}h` }
}

export class NativeProcessService {
  processes = new Map<string, NativeProcessInstance>()
  private appsRoot: string
  private isPortExternallyReserved: (port: number) => boolean

  constructor(opts: { appsRoot: string; isPortReserved?: (port: number) => boolean }) {
    this.appsRoot = path.resolve(opts.appsRoot)
    fs.mkdirSync(this.appsRoot, { recursive: true })
    this.isPortExternallyReserved = opts.isPortReserved || (() => false)

    const cleanupAll = () => this.shutdownAllSync()
    process.once('exit', cleanupAll)
    process.once('SIGINT', cleanupAll)
    process.once('SIGTERM', cleanupAll)
  }

  shutdownAllSync() {
    for (const proc of this.processes.values()) {
      if (proc.child && !proc.child.killed) {
        try {
          proc.child.kill('SIGTERM')
        } catch {
          // ignore
        }
      }
    }
  }

  async allocateFreePort(preferredPort?: number): Promise<number> {
    const usedLocal = new Set(Array.from(this.processes.values()).map((p) => p.port))
    let candidate =
      preferredPort && Number.isInteger(preferredPort) && preferredPort >= 1024 && preferredPort <= 65535
        ? preferredPort
        : 9100
    for (let i = 0; i < 600; i += 1) {
      if (
        !usedLocal.has(candidate) &&
        !this.isPortExternallyReserved(candidate) &&
        candidate !== Number(process.env.PORT || 3000)
      ) {
        if (await checkPortFree(candidate)) return candidate
      }
      candidate += 1
      if (candidate > 64000) candidate = 9100
    }
    throw new Error('No free host port available')
  }

  appendLog(proc: NativeProcessInstance, stream: 'stdout' | 'stderr', content: string) {
    const clean = content.trimEnd()
    if (!clean) return
    proc.logs.push({ timestamp: new Date().toISOString(), stream, content: clean })
    if (proc.logs.length > 500) {
      proc.logs = proc.logs.slice(-500)
    }
  }

  async spawnProcess(proc: NativeProcessInstance): Promise<void> {
    if (proc.child && proc.state === 'running') {
      await this.stopProcess(proc.id)
    }

    proc.port = await this.allocateFreePort(proc.port)
    const resolvedArgs = proc.args.map((arg) =>
      arg.replace(/\{PORT\}/g, String(proc.port)).replace(/\$PORT\b/g, String(proc.port))
    )

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...proc.env,
      PORT: String(proc.port),
      HOST: '127.0.0.1',
    }

    const displayCmd = `${path.basename(proc.executable)} ${resolvedArgs.join(' ')}`.trim()
    this.appendLog(
      proc,
      'stdout',
      `[${proc.name}] Spawning native binary (${proc.workingDir}): ${displayCmd}`
    )

    const child = spawn(proc.executable, resolvedArgs, {
      cwd: proc.workingDir,
      shell: false,
      env: childEnv,
    })

    proc.child = child
    proc.pid = child.pid ?? null
    proc.state = 'running'
    proc.startedAt = Date.now()
    proc.lastExitCode = null
    proc.lastError = null

    child.stdout?.on('data', (buf: Buffer) => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) this.appendLog(proc, 'stdout', line)
      }
    })

    child.stderr?.on('data', (buf: Buffer) => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) this.appendLog(proc, 'stderr', line)
      }
    })

    child.on('error', (err) => {
      if (proc.child === child) {
        proc.state = 'exited'
        proc.pid = null
        proc.lastExitCode = 1
        proc.lastError = err.message
        proc.child = undefined
        this.appendLog(proc, 'stderr', `[${proc.name}] Failed to execute binary: ${err.message}`)
      }
    })

    child.on('exit', (code) => {
      if (proc.child === child) {
        proc.state = 'exited'
        proc.pid = null
        proc.lastExitCode = code ?? 0
        proc.child = undefined
        this.appendLog(
          proc,
          code === 0 ? 'stdout' : 'stderr',
          `[${proc.name}] Native process exited (code ${code ?? 0})`
        )
      }
    })

    const listening = await waitForPortOpen(proc.port, 3500)
    if (proc.lastError) {
      throw new Error(proc.lastError)
    }
    if (listening) {
      this.appendLog(
        proc,
        'stdout',
        `[${proc.name}] Verified host TCP listener on http://127.0.0.1:${proc.port} (PID ${proc.pid})`
      )
    } else if (proc.state === 'running') {
      this.appendLog(
        proc,
        'stdout',
        `[${proc.name}] Native process running (PID ${proc.pid}, assigned PORT=${proc.port})`
      )
    }
  }

  async deployBinaryProcess(opts: {
    name: string
    executable: string
    args?: string | string[]
    workingDir?: string
    port?: number
    env?: Record<string, string>
    label?: string
  }): Promise<NativeProcessInstance> {
    const cleanName = sanitizeProcessName(opts.name)
    const execCheck = validateBinaryExecutable(opts.executable)
    if (!execCheck.ok) {
      throw new Error(execCheck.error)
    }
    const parsedArgs = parseCommandArgs(opts.args)
    const workingDir = resolveProcessWorkingDir(opts.workingDir, this.appsRoot, cleanName)
    const env = sanitizeProcessEnv(opts.env)

    const existing = this.findByName(cleanName)
    if (existing && existing.state === 'running') {
      await this.stopProcess(existing.id)
    }

    const port = await this.allocateFreePort(opts.port)
    const instance: NativeProcessInstance = existing || {
      id: `bin-${crypto.randomBytes(5).toString('hex')}`,
      name: cleanName,
      label: opts.label || `Binary (${path.basename(execCheck.executable)})`,
      executable: execCheck.executable,
      args: parsedArgs,
      workingDir,
      port,
      state: 'exited',
      pid: null,
      env,
      created: Math.floor(Date.now() / 1000),
      startedAt: null,
      lastExitCode: null,
      lastError: null,
      logs: [],
    }

    instance.executable = execCheck.executable
    instance.args = parsedArgs
    instance.workingDir = workingDir
    instance.port = port
    instance.env = env
    instance.label = opts.label || `Binary (${path.basename(execCheck.executable)})`

    this.processes.set(instance.id, instance)
    await this.spawnProcess(instance)
    return instance
  }

  async startProcess(id: string): Promise<NativeProcessInstance | null> {
    const proc = this.processes.get(id)
    if (!proc) return null
    await this.spawnProcess(proc)
    return proc
  }

  async stopProcess(id: string): Promise<NativeProcessInstance | null> {
    const proc = this.processes.get(id)
    if (!proc) return null
    const child = proc.child
    if (child && !child.killed) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            // ignore
          }
          resolve()
        }, 1800)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
        try {
          child.kill('SIGTERM')
        } catch {
          clearTimeout(timer)
          resolve()
        }
      })
    }
    proc.state = 'exited'
    proc.pid = null
    proc.child = undefined
    return proc
  }

  async restartProcess(id: string): Promise<NativeProcessInstance | null> {
    const proc = this.processes.get(id)
    if (!proc) return null
    await this.stopProcess(id)
    await this.spawnProcess(proc)
    return proc
  }

  async deleteProcess(id: string): Promise<boolean> {
    const proc = this.processes.get(id)
    if (!proc) return false
    await this.stopProcess(id)
    this.processes.delete(id)
    if (proc.workingDir && proc.workingDir.startsWith(this.appsRoot + path.sep)) {
      fs.rmSync(proc.workingDir, { recursive: true, force: true })
    }
    return true
  }

  findByName(name: string): NativeProcessInstance | undefined {
    const clean = sanitizeProcessName(name)
    return Array.from(this.processes.values()).find((p) => p.name === clean)
  }

  getProcess(idOrName: string): NativeProcessInstance | undefined {
    return this.processes.get(idOrName) || this.findByName(idOrName)
  }

  listProcesses(): NativeProcessInstance[] {
    return Array.from(this.processes.values()).sort((a, b) => b.created - a.created)
  }

  getLogs(idOrName: string, tail = 100, filter = ''): NativeProcessLogLine[] {
    const proc = this.getProcess(idOrName)
    if (!proc) return []
    const lines = filter
      ? proc.logs.filter((l) => l.content.toLowerCase().includes(filter.toLowerCase()))
      : proc.logs
    return lines.slice(-tail)
  }

  probeProcess(idOrName: string): Promise<{ ok: boolean; statusCode: number | null; latencyMs: number; error?: string }> {
    const proc = this.getProcess(idOrName)
    if (!proc) {
      return Promise.resolve({ ok: false, statusCode: null, latencyMs: 0, error: 'Process not found' })
    }
    const start = Date.now()
    return new Promise((resolve) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: proc.port,
          path: '/',
          method: 'GET',
          timeout: 2000,
        },
        (res) => {
          res.resume()
          resolve({
            ok: (res.statusCode || 500) < 500,
            statusCode: res.statusCode || null,
            latencyMs: Date.now() - start,
          })
        }
      )
      req.on('timeout', () => {
        req.destroy()
        resolve({ ok: false, statusCode: null, latencyMs: Date.now() - start, error: 'Timeout' })
      })
      req.on('error', (err) => {
        resolve({ ok: false, statusCode: null, latencyMs: Date.now() - start, error: err.message })
      })
      req.end()
    })
  }

  serializeProcess(proc: NativeProcessInstance) {
    const { uptimeSeconds, uptimeLabel } =
      proc.state === 'running'
        ? formatProcessUptime(proc.startedAt)
        : {
            uptimeSeconds: 0,
            uptimeLabel: proc.lastExitCode !== null ? `Exited (${proc.lastExitCode})` : 'Stopped',
          }
    const telemetry =
      proc.state === 'running'
        ? samplePidResourceMetrics(proc.pid)
        : { cpuPercent: 0, memoryBytes: 0, memoryMb: 0, memoryPercent: 0, threads: 0 }

    const commandPreview = `${path.basename(proc.executable)} ${proc.args.join(' ')}`.trim()
    return {
      id: proc.id,
      name: proc.name,
      image: proc.label,
      runtime: 'binary',
      runtimeLabel: proc.label,
      source: 'binary' as const,
      command: commandPreview,
      executable: proc.executable,
      args: proc.args,
      workingDir: proc.workingDir,
      state: proc.state,
      status: proc.state === 'running' ? `Up ${uptimeLabel}` : uptimeLabel,
      uptimeSeconds,
      uptimeLabel,
      cpuPercent: telemetry.cpuPercent,
      memoryBytes: telemetry.memoryBytes,
      memoryMb: telemetry.memoryMb,
      memoryPercent: telemetry.memoryPercent,
      threads: telemetry.threads,
      pid: proc.pid,
      port: proc.port,
      ports: [{ hostPort: proc.port, containerPort: proc.port, protocol: 'tcp' }],
      appDir: proc.workingDir,
      liveUrl: `/live/${proc.name}/`,
      lastError: proc.lastError,
      created: proc.created,
    }
  }
}
