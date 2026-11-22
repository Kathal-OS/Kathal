import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
import { execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import {
  sanitizeAppName,
  resolveConfinedAppDir,
  probeLocalHttp,
  isValidPublicHttpsGitUrl,
} from './localRuntime.ts'
import {
  sanitizeProcessEnv,
  formatProcessUptime,
} from './nativeProcess.ts'
import {
  getPlatformLabel,
  getPlatformBinaryCandidates,
  findExecutableOnPath,
  resolveNpmInvocation,
  resolveNpmBinEntrypoint,
  resolvePythonCommand,
  getVenvPaths,
  spawnCrossPlatform,
  terminateProcessTree,
  samplePidMetricsCrossPlatform,
  detectArchiveType,
  downloadHttpsFile,
  extractArchiveCrossPlatform,
} from './platform.ts'
import { getTemplateById, type ServiceTemplate } from './templates.ts'
import type { ServiceManager } from './serviceManager.ts'

const execFileAsync = promisify(execFile)

const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'releases.hashicorp.com',
  'dl.min.io',
  'codeberg.org',
])

export interface RuntimeProbeItem {
  id: string
  label: string
  available: boolean
  version: string | null
  detail: string
}

export interface HostRuntimesReport {
  platform: string
  platformLabel: string
  arch: string
  checkedAt: string
  runtimes: Record<string, RuntimeProbeItem>
}

export interface PreflightCheckResult {
  templateId: string
  installable: boolean
  dockerFreeSupported: boolean
  compatibility: string
  installMethod: string
  alreadyExists: boolean
  existingAppDir: string | null
  checks: { label: string; ok: boolean; detail: string }[]
  missingRequirements: string[]
  remediation: string[]
}

export type InstallPhase =
  | 'queued'
  | 'preflight'
  | 'preparing'
  | 'downloading'
  | 'installing_deps'
  | 'configuring'
  | 'starting'
  | 'verifying'
  | 'completed'
  | 'failed'

export interface InstallationLogEntry {
  timestamp: string
  stream: 'stdout' | 'stderr' | 'system'
  content: string
}

export interface InstalledAppRecord {
  id: string
  templateId: string
  name: string
  displayName: string
  runtime: string
  compatibility: string
  installMethod: string
  appDir: string
  dataDir: string
  configFilePath: string
  executable: string
  args: string[]
  port: number
  state: 'running' | 'exited'
  pid: number | null
  installStatus: 'installing' | 'installed' | 'failed'
  phase: InstallPhase
  progress: number
  errorMessage: string | null
  env: Record<string, string>
  healthCheckPath: string
  lastHealth: { ok: boolean; statusCode: number | null; latencyMs: number; checkedAt: string; error?: string } | null
  installedAt: string
  created: number
  startedAt: number | null
  lastExitCode: number | null
  logs: InstallationLogEntry[]
  child?: ChildProcess
}

let cachedRuntimes: { expiresAt: number; report: HostRuntimesReport } | null = null

async function probeBinary(cmd: string, args: string[] = ['--version']): Promise<{ ok: boolean; version: string | null }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: 3000, windowsHide: true })
    const line = `${stdout}\n${stderr}`.trim().split(/\r?\n/)[0] || ''
    return { ok: true, version: line.slice(0, 80) || 'installed' }
  } catch {
    return { ok: false, version: null }
  }
}

export async function detectHostRuntimes(forceRefresh = false): Promise<HostRuntimesReport> {
  if (!forceRefresh && cachedRuntimes && Date.now() < cachedRuntimes.expiresAt) {
    return cachedRuntimes.report
  }

  const npmInv = resolveNpmInvocation(['--version'])
  const pyCmd = resolvePythonCommand()

  const [
    npmProbe,
    pyProbe,
    pyVenvProbe,
    pipProbe,
    gitProbe,
    curlProbe,
    goProbe,
    javaProbe,
    phpProbe,
    dockerProbe,
    dotnetProbe,
  ] = await Promise.all([
    probeBinary(npmInv.executable, npmInv.args),
    probeBinary(pyCmd.executable, [...pyCmd.prefixArgs, '--version']),
    probeBinary(pyCmd.executable, [...pyCmd.prefixArgs, '-c', 'import venv, ensurepip; print("venv+ensurepip")']),
    probeBinary(pyCmd.executable, [...pyCmd.prefixArgs, '-m', 'pip', '--version']),
    probeBinary(findExecutableOnPath('git') || 'git', ['--version']),
    probeBinary(findExecutableOnPath('curl') || 'curl', ['--version']),
    probeBinary(findExecutableOnPath('go') || 'go', ['version']),
    probeBinary(findExecutableOnPath('java') || 'java', ['-version']),
    probeBinary(findExecutableOnPath('php') || 'php', ['-v']),
    probeBinary(findExecutableOnPath('docker') || 'docker', ['--version']),
    probeBinary(findExecutableOnPath('dotnet') || 'dotnet', ['--version']),
  ])

  const tarExists = Boolean(findExecutableOnPath('tar'))
  const powershellExists = process.platform === 'win32' && Boolean(findExecutableOnPath('powershell'))
  const unzipExists =
    process.platform === 'win32'
      ? powershellExists
      : Boolean(findExecutableOnPath('unzip') || tarExists)
  const bzip2Exists = Boolean(findExecutableOnPath('bzip2'))
  const postgresExists = Boolean(findExecutableOnPath('postgres'))
  const mysqlExists = Boolean(findExecutableOnPath('mysqld'))
  const mariadbExists = Boolean(findExecutableOnPath('mariadbd'))
  const mongoExists = Boolean(findExecutableOnPath('mongod'))
  const redisExists = Boolean(findExecutableOnPath('redis-server'))
  const nginxExists = Boolean(findExecutableOnPath('nginx'))
  const ollamaExists = Boolean(findExecutableOnPath('ollama'))
  const mosquittoExists = Boolean(findExecutableOnPath('mosquitto'))

  const runtimes: Record<string, RuntimeProbeItem> = {
    node: { id: 'node', label: 'Node.js', available: true, version: process.version, detail: `Runtime ${process.version}` },
    npm: { id: 'npm', label: 'npm', available: npmProbe.ok, version: npmProbe.version, detail: npmProbe.ok ? `npm v${npmProbe.version}` : 'npm not found' },
    python3: { id: 'python3', label: 'Python 3', available: pyProbe.ok, version: pyProbe.version, detail: pyProbe.ok ? pyProbe.version || 'available' : 'Python 3 not found' },
    pythonVenv: {
      id: 'pythonVenv',
      label: 'Python venv & pip',
      available: pyVenvProbe.ok && pipProbe.ok,
      version: pipProbe.version,
      detail: pyVenvProbe.ok && pipProbe.ok ? 'venv + ensurepip ready' : 'python venv / pip missing on host',
    },
    git: { id: 'git', label: 'Git', available: gitProbe.ok, version: gitProbe.version, detail: gitProbe.ok ? gitProbe.version || 'available' : 'git not found' },
    curl: {
      id: 'curl',
      label: 'HTTPS Fetch',
      available: true,
      version: curlProbe.ok ? curlProbe.version : `Node ${process.version}`,
      detail: 'Built-in Node HTTPS downloader ready',
    },
    tar: { id: 'tar', label: 'tar', available: tarExists, version: tarExists ? 'installed' : null, detail: tarExists ? 'tar extractor available' : 'tar missing' },
    unzip: {
      id: 'unzip',
      label: process.platform === 'win32' ? 'PowerShell Expand-Archive' : 'unzip / tar',
      available: unzipExists,
      version: unzipExists ? 'installed' : null,
      detail: unzipExists ? 'zip extractor available' : 'zip extractor missing',
    },
    bzip2: { id: 'bzip2', label: 'bzip2', available: bzip2Exists, version: bzip2Exists ? 'installed' : null, detail: bzip2Exists ? 'bzip2 extractor available' : 'bzip2 missing' },
    go: { id: 'go', label: 'Go Toolchain', available: goProbe.ok, version: goProbe.version, detail: goProbe.ok ? goProbe.version || 'installed' : 'Go compiler not installed' },
    java: { id: 'java', label: 'Java JDK/JRE', available: javaProbe.ok, version: javaProbe.version, detail: javaProbe.ok ? javaProbe.version || 'installed' : 'Java 17+ runtime not installed' },
    php: { id: 'php', label: 'PHP', available: phpProbe.ok, version: phpProbe.version, detail: phpProbe.ok ? phpProbe.version || 'installed' : 'PHP 8.2+ not installed' },
    docker: { id: 'docker', label: 'Docker Engine (Optional)', available: dockerProbe.ok, version: dockerProbe.version, detail: dockerProbe.ok ? dockerProbe.version || 'installed' : 'Docker not required for native apps' },
    dotnet: { id: 'dotnet', label: '.NET Runtime', available: dotnetProbe.ok, version: dotnetProbe.version, detail: dotnetProbe.ok ? dotnetProbe.version || 'installed' : '.NET 8 runtime not installed' },
    postgres: { id: 'postgres', label: 'PostgreSQL Server', available: postgresExists, version: postgresExists ? 'installed' : null, detail: postgresExists ? 'postgres binary available' : 'PostgreSQL server not installed' },
    mysqld: { id: 'mysqld', label: 'MySQL Server', available: mysqlExists, version: mysqlExists ? 'installed' : null, detail: mysqlExists ? 'mysqld binary available' : 'MySQL server not installed' },
    mariadbd: { id: 'mariadbd', label: 'MariaDB Server', available: mariadbExists, version: mariadbExists ? 'installed' : null, detail: mariadbExists ? 'mariadbd binary available' : 'MariaDB server not installed' },
    mongod: { id: 'mongod', label: 'MongoDB Server', available: mongoExists, version: mongoExists ? 'installed' : null, detail: mongoExists ? 'mongod binary available' : 'MongoDB server not installed' },
    'redis-server': { id: 'redis-server', label: 'Redis Server', available: redisExists, version: redisExists ? 'installed' : null, detail: redisExists ? 'redis-server binary available' : 'Redis server not installed' },
    nginx: { id: 'nginx', label: 'Nginx', available: nginxExists, version: nginxExists ? 'installed' : null, detail: nginxExists ? 'nginx binary available' : 'Nginx not installed' },
    ollama: { id: 'ollama', label: 'Ollama', available: ollamaExists, version: ollamaExists ? 'installed' : null, detail: ollamaExists ? 'ollama binary available' : 'Ollama binary not installed' },
    mosquitto: { id: 'mosquitto', label: 'Mosquitto', available: mosquittoExists, version: mosquittoExists ? 'installed' : null, detail: mosquittoExists ? 'mosquitto binary available' : 'Mosquitto not installed' },
  }

  const report: HostRuntimesReport = {
    platform: os.platform(),
    platformLabel: getPlatformLabel(),
    arch: os.arch(),
    checkedAt: new Date().toISOString(),
    runtimes,
  }
  cachedRuntimes = { expiresAt: Date.now() + 15_000, report }
  return report
}

function isValidVerifiedHttpsDownloadUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'https:') return false
    const host = parsed.hostname.toLowerCase()
    return ALLOWED_DOWNLOAD_HOSTS.has(host)
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

function waitForPortOpen(port: number, timeoutMs = 6000): Promise<boolean> {
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

function runCommandSafe(
  cmd: string,
  args: string[],
  cwd: string,
  envOverrides: Record<string, string>,
  onLog: (stream: 'stdout' | 'stderr', line: string) => void,
  timeoutMs = 180_000
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnCrossPlatform(cmd, args, {
      cwd,
      env: { ...process.env, ...envOverrides, GIT_TERMINAL_PROMPT: '0', npm_config_update_notifier: 'false' },
    })
    let output = ''
    const timer = setTimeout(() => {
      void terminateProcessTree(child.pid ?? null, child)
      reject(new Error(`Command "${cmd} ${args.join(' ')}" timed out after ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)

    const consume = (stream: 'stdout' | 'stderr', buf: Buffer) => {
      const text = buf.toString('utf8')
      output += text
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) onLog(stream, line)
      }
    }

    child.stdout?.on('data', (d: Buffer) => consume('stdout', d))
    child.stderr?.on('data', (d: Buffer) => consume('stderr', d))
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, output })
    })
  })
}

export class AppInstallerEngine {
  installations = new Map<string, InstalledAppRecord>()
  private appsRoot: string
  private isPortExternallyReserved: (port: number) => boolean
  private serviceEngine?: ServiceManager

  constructor(opts: {
    appsRoot: string
    isPortReserved?: (port: number) => boolean
    serviceEngine?: ServiceManager
  }) {
    this.appsRoot = path.resolve(opts.appsRoot)
    fs.mkdirSync(this.appsRoot, { recursive: true })
    this.isPortExternallyReserved = opts.isPortReserved || (() => false)
    this.serviceEngine = opts.serviceEngine

    const cleanupAll = () => this.shutdownAllSync()
    process.once('exit', cleanupAll)
    process.once('SIGINT', cleanupAll)
    process.once('SIGTERM', cleanupAll)
  }

  shutdownAllSync() {
    for (const rec of this.installations.values()) {
      if (rec.child && !rec.child.killed) {
        void terminateProcessTree(rec.pid, rec.child)
      }
    }
  }

  async allocateFreePort(preferredPort?: number): Promise<number> {
    const usedLocal = new Set(Array.from(this.installations.values()).map((a) => a.port))
    let candidate =
      preferredPort && Number.isInteger(preferredPort) && preferredPort >= 9000 && preferredPort <= 64000
        ? preferredPort
        : preferredPort && Number.isInteger(preferredPort) && preferredPort >= 1024 && preferredPort <= 65535
        ? preferredPort
        : 9200
    for (let i = 0; i < 600; i += 1) {
      if (
        !usedLocal.has(candidate) &&
        !this.isPortExternallyReserved(candidate) &&
        candidate !== Number(process.env.PORT || 3000)
      ) {
        if (await checkPortFree(candidate)) return candidate
      }
      candidate += 1
      if (candidate > 64000) candidate = 9200
    }
    throw new Error('No free host port available')
  }

  appendLog(rec: InstalledAppRecord, stream: 'stdout' | 'stderr' | 'system', content: string) {
    const clean = content.trimEnd()
    if (!clean) return
    rec.logs.push({ timestamp: new Date().toISOString(), stream, content: clean })
    if (rec.logs.length > 800) {
      rec.logs = rec.logs.slice(-800)
    }
  }

  async checkPreflight(tmpl: ServiceTemplate, customName?: string): Promise<PreflightCheckResult> {
    const report = await detectHostRuntimes()
    const rt = report.runtimes
    const checks: { label: string; ok: boolean; detail: string }[] = []
    const missingRequirements: string[] = []
    const remediation: string[] = []

    const cleanName = sanitizeAppName(customName || tmpl.id)
    const targetDir = resolveConfinedAppDir(cleanName)
    const alreadyExists =
      Boolean(this.findByName(cleanName)) ||
      (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0)

    if (!tmpl.dockerFreeSupported || tmpl.installMethod === 'docker-required') {
      const dockerOk = rt.docker.available
      checks.push({
        label: 'Container Runtime (Docker Engine)',
        ok: dockerOk,
        detail: dockerOk
          ? `Docker available (${rt.docker.version})`
          : `${tmpl.name} officially requires Docker / multi-container orchestration and is NOT supported as a Docker-free native install`,
      })
      if (!dockerOk) {
        missingRequirements.push('docker (Docker Engine + Docker Compose required)')
        remediation.push(`Install Docker Engine on the host or follow ${tmpl.docs} for container deployment.`)
      }
    } else if (tmpl.installMethod === 'npm') {
      checks.push({ label: 'Node.js Runtime', ok: rt.node.available, detail: rt.node.detail })
      checks.push({ label: 'npm Package Manager', ok: rt.npm.available, detail: rt.npm.detail })
      if (!rt.npm.available) {
        missingRequirements.push('npm')
        remediation.push('Install Node.js LTS & npm on the host.')
      }
      if (!tmpl.installSpec?.npmPackage) {
        checks.push({ label: 'Package Spec', ok: false, detail: 'Missing npm package specifier' })
        missingRequirements.push('npm package specifier')
      }
    } else if (tmpl.installMethod === 'python-venv') {
      checks.push({ label: 'Python 3 Interpreter', ok: rt.python3.available, detail: rt.python3.detail })
      checks.push({ label: 'Python venv & pip', ok: rt.pythonVenv.available, detail: rt.pythonVenv.detail })
      if (!rt.python3.available) {
        missingRequirements.push('python3')
        remediation.push(
          process.platform === 'win32'
            ? 'Install Python 3.10+ from python.org or run `winget install Python.Python.3.12`.'
            : process.platform === 'darwin'
            ? 'Install Python 3 via `brew install python`.'
            : 'Install Python 3.10+ on the host.'
        )
      }
      if (!rt.pythonVenv.available) {
        missingRequirements.push('python venv / pip')
        remediation.push(
          process.platform === 'win32'
            ? 'Reinstall Python 3 with pip and venv enabled.'
            : process.platform === 'darwin'
            ? 'Install Python 3 with pip & venv via Homebrew (`brew install python`).'
            : 'Install python3-venv and pip (e.g. apt install python3-venv python3-pip) to isolate Python packages safely.'
        )
      }
    } else if (tmpl.installMethod === 'binary-download') {
      const candidates = getPlatformBinaryCandidates()
      const matchedKey = candidates.find((k) => Boolean(tmpl.installSpec?.binaryUrls?.[k])) || candidates[0]
      const downloadUrl = tmpl.installSpec?.binaryUrls?.[matchedKey]
      const urlOk = Boolean(downloadUrl && isValidVerifiedHttpsDownloadUrl(downloadUrl))
      checks.push({
        label: `Official ${matchedKey} Binary Release`,
        ok: urlOk,
        detail: urlOk ? `Verified HTTPS release URL ready` : `No verified ${matchedKey} binary URL configured for ${report.platformLabel}`,
      })
      if (!urlOk) {
        missingRequirements.push(`Verified ${matchedKey} binary URL`)
        remediation.push(`Check ${tmpl.github}/releases for a native ${report.platformLabel} (${os.arch()}) build.`)
      }

      checks.push({ label: 'Built-in HTTPS Downloader', ok: true, detail: `Node ${process.version} fetch ready` })

      const archiveType = detectArchiveType(downloadUrl || '', tmpl.installSpec?.binaryArchive || 'raw')
      if (archiveType === 'zip') {
        checks.push({ label: rt.unzip.label, ok: rt.unzip.available, detail: rt.unzip.detail })
        if (!rt.unzip.available) missingRequirements.push('zip extractor')
      } else if (archiveType === 'tar.gz') {
        checks.push({ label: 'tar Archive Tool', ok: rt.tar.available, detail: rt.tar.detail })
        if (!rt.tar.available) missingRequirements.push('tar')
      } else if (archiveType === 'bz2') {
        checks.push({ label: 'bzip2 Decompressor', ok: rt.bzip2.available, detail: rt.bzip2.detail })
        if (!rt.bzip2.available) {
          missingRequirements.push('bzip2')
          remediation.push('Install bzip2 (or choose an app distributed as .zip / .tar.gz / raw binary).')
        }
      }
    } else if (tmpl.installMethod === 'git') {
      const repoUrl = tmpl.installSpec?.gitRepo || ''
      const repoValid = isValidPublicHttpsGitUrl(repoUrl)
      checks.push({ label: 'Verified HTTPS Git Source', ok: repoValid, detail: repoValid ? repoUrl : 'Invalid repository URL' })
      checks.push({ label: 'Git CLI', ok: rt.git.available, detail: rt.git.detail })
      if (!repoValid) missingRequirements.push('HTTPS Git URL')
      if (!rt.git.available) missingRequirements.push('git')
      if (tmpl.compatibility === 'Node.js' || tmpl.runtime.toLowerCase().includes('node')) {
        checks.push({ label: 'Node.js & npm', ok: rt.node.available && rt.npm.available, detail: `${rt.node.detail} · ${rt.npm.detail}` })
        if (!rt.npm.available) missingRequirements.push('npm')
      }
      if (tmpl.compatibility === 'Python') {
        checks.push({ label: 'Python venv & pip', ok: rt.pythonVenv.available, detail: rt.pythonVenv.detail })
        if (!rt.pythonVenv.available) missingRequirements.push('python venv / pip')
      }
    } else if (tmpl.installMethod === 'system-binary') {
      const sysBin = tmpl.installSpec?.systemBinary || tmpl.id
      const binaryInstalled = Boolean(rt[sysBin]?.available) || Boolean(findExecutableOnPath(sysBin))
      checks.push({
        label: `Host Binary (${sysBin})`,
        ok: binaryInstalled,
        detail: binaryInstalled ? `${sysBin} detected on host PATH` : `${sysBin} is not installed on this host`,
      })
      if (!binaryInstalled) {
        missingRequirements.push(`${sysBin} binary`)
        remediation.push(`Install ${tmpl.name} (${sysBin}) via your OS package manager or follow ${tmpl.docs}.`)
      }
    }

    // Check external service dependencies declared in requirements (postgres, mysql, redis, java, php, go, dotnet)
    for (const reqStr of tmpl.requirements) {
      const low = reqStr.toLowerCase()
      if (low.includes('postgresql') && !rt.postgres.available && tmpl.compatibility === 'External Dependencies') {
        checks.push({ label: 'External Dependency: PostgreSQL', ok: false, detail: 'PostgreSQL server not detected locally' })
        missingRequirements.push('PostgreSQL 14+ (external database)')
        remediation.push('Provision a PostgreSQL database before installing or configure DATABASE_URL.')
      } else if (low.includes('mongodb') && !rt.mongod.available && tmpl.compatibility === 'External Dependencies') {
        checks.push({ label: 'External Dependency: MongoDB', ok: false, detail: 'MongoDB server not detected locally' })
        missingRequirements.push('MongoDB 7+ (external database)')
      } else if (low.includes('java') && tmpl.compatibility === 'Java' && !rt.java.available) {
        if (!missingRequirements.some((m) => m.includes('java'))) {
          checks.push({ label: 'Java JDK/JRE', ok: false, detail: rt.java.detail })
          missingRequirements.push('Java 17+ JDK/JRE')
        }
      } else if (low.includes('php') && tmpl.compatibility === 'PHP' && !rt.php.available) {
        if (!missingRequirements.some((m) => m.includes('php'))) {
          checks.push({ label: 'PHP Runtime', ok: false, detail: rt.php.detail })
          missingRequirements.push('PHP 8.2+')
        }
      } else if (low.includes('go >') && !rt.go.available) {
        checks.push({ label: 'Go Compiler', ok: false, detail: rt.go.detail })
        missingRequirements.push('Go >= 1.22')
      }
    }

    return {
      templateId: tmpl.id,
      installable: missingRequirements.length === 0,
      dockerFreeSupported: tmpl.dockerFreeSupported,
      compatibility: tmpl.compatibility,
      installMethod: tmpl.installMethod,
      alreadyExists,
      existingAppDir: alreadyExists ? targetDir : null,
      checks,
      missingRequirements,
      remediation,
    }
  }

  async startInstallation(opts: {
    template: ServiceTemplate
    name?: string
    hostPort?: number
    env?: Record<string, string>
    overwrite?: boolean
    onInstalled?: (rec: InstalledAppRecord) => void
  }): Promise<InstalledAppRecord> {
    const cleanName = sanitizeAppName(opts.name || opts.template.id)
    const appDir = resolveConfinedAppDir(cleanName)
    const dataDir = path.join(appDir, 'data')

    const existingRec = this.findByName(cleanName)
    const dirNonEmpty = fs.existsSync(appDir) && fs.readdirSync(appDir).length > 0
    if ((existingRec || dirNonEmpty) && !opts.overwrite) {
      const err = new Error(
        `Installation "${cleanName}" already exists at ${appDir}. Choose another name or confirm overwrite to preserve user data.`
      ) as Error & { statusCode?: number; code?: string }
      err.statusCode = 409
      err.code = 'ALREADY_EXISTS'
      throw err
    }

    const preflight = await this.checkPreflight(opts.template, cleanName)
    if (!preflight.installable) {
      const err = new Error(
        `Cannot safely install ${opts.template.name}: missing ${preflight.missingRequirements.join(', ')}`
      ) as Error & { statusCode?: number; preflight?: PreflightCheckResult }
      err.statusCode = 422
      err.preflight = preflight
      throw err
    }

    if (existingRec && existingRec.state === 'running') {
      await this.stopApp(existingRec.id)
    }

    const port = await this.allocateFreePort(opts.hostPort || opts.template.defaultPort)
    const mergedEnv = sanitizeProcessEnv({
      ...this.parseTemplateEnv(opts.template),
      ...(opts.env || {}),
    })

    const rec: InstalledAppRecord = existingRec || {
      id: `inst-${crypto.randomBytes(5).toString('hex')}`,
      templateId: opts.template.id,
      name: cleanName,
      displayName: opts.template.name,
      runtime: opts.template.runtime,
      compatibility: opts.template.compatibility,
      installMethod: opts.template.installMethod,
      appDir,
      dataDir,
      configFilePath: path.join(appDir, opts.template.configTemplate.filename || '.env'),
      executable: process.execPath,
      args: [],
      port,
      state: 'exited',
      pid: null,
      installStatus: 'installing',
      phase: 'preflight',
      progress: 10,
      errorMessage: null,
      env: mergedEnv,
      healthCheckPath: opts.template.healthCheckPath || '/',
      lastHealth: null,
      installedAt: new Date().toISOString(),
      created: Math.floor(Date.now() / 1000),
      startedAt: null,
      lastExitCode: null,
      logs: [],
    }

    rec.port = port
    rec.env = mergedEnv
    rec.installStatus = 'installing'
    rec.phase = 'preparing'
    rec.progress = 15
    rec.errorMessage = null

    this.installations.set(rec.id, rec)
    this.appendLog(rec, 'system', `[${cleanName}] Preflight passed (${opts.template.compatibility} / ${opts.template.installMethod})`)

    // Run real asynchronous installation workflow so UI streams progress & logs cleanly
    void this.executePipeline(rec, opts.template, Boolean(opts.overwrite), opts.onInstalled)
    return rec
  }

  private parseTemplateEnv(tmpl: ServiceTemplate): Record<string, string> {
    const out: Record<string, string> = {}
    for (const pair of tmpl.env_vars || []) {
      const idx = pair.indexOf('=')
      if (idx > 0) {
        const k = pair.slice(0, idx).trim()
        const v = pair.slice(idx + 1).trim()
        if (k) out[k] = v
      }
    }
    return out
  }

  private resolvePlaceholders(input: string, rec: InstalledAppRecord): string {
    return input
      .replace(/\{PORT\}/g, String(rec.port))
      .replace(/\{DATA_DIR\}/g, rec.dataDir)
      .replace(/\{DIR\}/g, rec.appDir)
      .replace(/\{APP_NAME\}/g, rec.name)
      .replace(/\{HOST\}/g, '127.0.0.1')
  }

  private async executePipeline(
    rec: InstalledAppRecord,
    tmpl: ServiceTemplate,
    overwrite: boolean,
    onInstalled?: (rec: InstalledAppRecord) => void
  ): Promise<void> {
    try {
      // 1. Prepare confined directories (preserve dataDir if overwrite)
      rec.phase = 'preparing'
      rec.progress = 20
      fs.mkdirSync(rec.appDir, { recursive: true })
      fs.mkdirSync(rec.dataDir, { recursive: true })
      fs.mkdirSync(path.join(rec.appDir, 'bin'), { recursive: true })
      this.appendLog(rec, 'system', `[${rec.name}] Prepared isolated app directory: ${rec.appDir}`)

      // 2. Install runtime dependencies or download official binary
      rec.phase = 'installing_deps'
      rec.progress = 35
      const spec = tmpl.installSpec || {}

      if (tmpl.installMethod === 'npm' && spec.npmPackage) {
        const pkgJsonPath = path.join(rec.appDir, 'package.json')
        if (!fs.existsSync(pkgJsonPath) || overwrite) {
          fs.writeFileSync(
            pkgJsonPath,
            JSON.stringify(
              {
                name: rec.name,
                version: '1.0.0',
                private: true,
                description: `${tmpl.name} managed by KATHAL`,
              },
              null,
              2
            ),
            'utf8'
          )
        }
        const npmInstallInv = resolveNpmInvocation(['install', '--no-audit', '--no-fund', '--omit=dev', spec.npmPackage])
        this.appendLog(rec, 'system', `[${rec.name}] Running: npm install --no-audit --no-fund --omit=dev ${spec.npmPackage}`)
        const res = await runCommandSafe(
          npmInstallInv.executable,
          npmInstallInv.args,
          rec.appDir,
          {},
          (stream, line) => this.appendLog(rec, stream, line),
          240_000
        )
        if (res.code !== 0) {
          throw new Error(`npm install ${spec.npmPackage} exited with code ${res.code}`)
        }
        const binName = spec.npmBin || spec.npmPackage.split('/').pop() || rec.name
        const resolved = resolveNpmBinEntrypoint(rec.appDir, binName, spec.npmPackage)
        if (!resolved) {
          throw new Error(`Expected entrypoint "${binName}" was not created by npm install`)
        }
        rec.executable = resolved.executable
        rec.args = [...resolved.argsPrefix, ...(spec.npmArgs || []).map((a) => this.resolvePlaceholders(a, rec))]
      } else if (tmpl.installMethod === 'python-venv' && spec.pythonPackage) {
        const venvDir = path.join(rec.appDir, '.venv')
        const pyCmd = resolvePythonCommand()
        const venvPaths = getVenvPaths(venvDir)
        if (!fs.existsSync(venvDir) || overwrite) {
          this.appendLog(rec, 'system', `[${rec.name}] Creating Python virtual environment at ${venvDir}`)
          const venvRes = await runCommandSafe(
            pyCmd.executable,
            [...pyCmd.prefixArgs, '-m', 'venv', venvDir],
            rec.appDir,
            {},
            (stream, line) => this.appendLog(rec, stream, line),
            60_000
          )
          if (venvRes.code !== 0) {
            throw new Error(`python venv creation failed (exit ${venvRes.code})`)
          }
        }
        this.appendLog(rec, 'system', `[${rec.name}] Installing Python package: ${spec.pythonPackage}`)
        const pipRes = await runCommandSafe(
          venvPaths.pip,
          ['install', '--no-input', spec.pythonPackage],
          rec.appDir,
          {},
          (stream, line) => this.appendLog(rec, stream, line),
          240_000
        )
        if (pipRes.code !== 0) {
          throw new Error(`pip install ${spec.pythonPackage} exited with code ${pipRes.code}`)
        }
        const pyBinName = spec.pythonBin || 'python3'
        const candidateBin = venvPaths.resolveTool(pyBinName)
        rec.executable = fs.existsSync(candidateBin) ? candidateBin : venvPaths.python
        rec.args = (spec.pythonArgs || []).map((a) => this.resolvePlaceholders(a, rec))
      } else if (tmpl.installMethod === 'binary-download') {
        const candidates = getPlatformBinaryCandidates()
        const matchedKey = candidates.find((k) => Boolean(spec.binaryUrls?.[k])) || candidates[0]
        const url = spec.binaryUrls?.[matchedKey]
        if (!url || !isValidVerifiedHttpsDownloadUrl(url)) {
          throw new Error(`No verified HTTPS download URL for ${matchedKey}`)
        }
        const binDir = path.join(rec.appDir, 'bin')
        const binName = spec.binaryName || rec.name
        const targetBinName =
          process.platform === 'win32' && !binName.toLowerCase().endsWith('.exe')
            ? `${binName}.exe`
            : binName
        const targetBin = path.join(binDir, targetBinName)
        const archiveKind = detectArchiveType(url, spec.binaryArchive || 'raw')
        const downloadDest =
          archiveKind === 'raw'
            ? targetBin
            : path.join(rec.appDir, `download.${archiveKind === 'tar.gz' ? 'tar.gz' : archiveKind}`)

        rec.phase = 'downloading'
        rec.progress = 45
        this.appendLog(rec, 'system', `[${rec.name}] Downloading verified ${matchedKey} release from ${url}`)
        await downloadHttpsFile(url, downloadDest, (host) => ALLOWED_DOWNLOAD_HOSTS.has(host))

        if (archiveKind !== 'raw') {
          this.appendLog(rec, 'system', `[${rec.name}] Extracting ${archiveKind} archive into ${binDir}`)
          await extractArchiveCrossPlatform(archiveKind, downloadDest, binDir, targetBin)
        }

        // Locate binary inside binDir (handling nested release subdirectories & .exe suffix cleanly)
        const resolvedBin = this.findExecutableInDir(binDir, binName)
        if (!resolvedBin) {
          throw new Error(`Binary "${binName}" not found after extracting archive`)
        }
        if (process.platform !== 'win32') {
          fs.chmodSync(resolvedBin, 0o755)
        }
        rec.executable = resolvedBin
        rec.args = (spec.binaryArgs || []).map((a) => this.resolvePlaceholders(a, rec))
      } else if (tmpl.installMethod === 'git' && spec.gitRepo) {
        if (!isValidPublicHttpsGitUrl(spec.gitRepo)) {
          throw new Error('Git repository must be a public https:// URL')
        }
        const branch = spec.gitBranch || 'main'
        if (!fs.existsSync(path.join(rec.appDir, '.git'))) {
          this.appendLog(rec, 'system', `[${rec.name}] Cloning ${spec.gitRepo} (${branch})`)
          const gitBin = findExecutableOnPath('git') || 'git'
          const cloneRes = await runCommandSafe(
            gitBin,
            ['clone', '--depth', '1', '--branch', branch, '--', spec.gitRepo, rec.appDir],
            this.appsRoot,
            {},
            (stream, line) => this.appendLog(rec, stream, line),
            180_000
          )
          if (cloneRes.code !== 0) throw new Error(`git clone failed (exit ${cloneRes.code})`)
        }
        if (fs.existsSync(path.join(rec.appDir, 'package.json'))) {
          this.appendLog(rec, 'system', `[${rec.name}] Installing Node.js dependencies via npm...`)
          const npmInstallInv = resolveNpmInvocation(['install', '--no-audit', '--no-fund', '--omit=dev'])
          const npmRes = await runCommandSafe(
            npmInstallInv.executable,
            npmInstallInv.args,
            rec.appDir,
            {},
            (stream, line) => this.appendLog(rec, stream, line),
            240_000
          )
          if (npmRes.code !== 0) throw new Error(`npm install failed (exit ${npmRes.code})`)
          const startInv = resolveNpmInvocation(['run', 'start'])
          rec.executable = startInv.executable
          rec.args = startInv.args
        } else if (fs.existsSync(path.join(rec.appDir, 'requirements.txt'))) {
          const venvDir = path.join(rec.appDir, '.venv')
          const pyCmd = resolvePythonCommand()
          const venvPaths = getVenvPaths(venvDir)
          if (!fs.existsSync(venvDir)) {
            await runCommandSafe(
              pyCmd.executable,
              [...pyCmd.prefixArgs, '-m', 'venv', venvDir],
              rec.appDir,
              {},
              (stream, line) => this.appendLog(rec, stream, line),
              60_000
            )
          }
          this.appendLog(rec, 'system', `[${rec.name}] Installing Python dependencies from requirements.txt...`)
          const pipRes = await runCommandSafe(
            venvPaths.pip,
            ['install', '--no-input', '-r', 'requirements.txt'],
            rec.appDir,
            {},
            (stream, line) => this.appendLog(rec, stream, line),
            240_000
          )
          if (pipRes.code !== 0) throw new Error(`pip install -r requirements.txt failed (exit ${pipRes.code})`)
          rec.executable = venvPaths.python
          rec.args = ['-m', 'http.server', String(rec.port)]
        }
      } else if (tmpl.installMethod === 'system-binary' && spec.systemBinary) {
        rec.executable = findExecutableOnPath(spec.systemBinary) || spec.systemBinary
        rec.args = (spec.systemArgs || []).map((a) => this.resolvePlaceholders(a, rec))
      }

      // 3. Apply configuration templates & .env safely (without clobbering existing user files)
      rec.phase = 'configuring'
      rec.progress = 70
      const resolvedEnv: Record<string, string> = {}
      for (const [k, v] of Object.entries(rec.env)) {
        resolvedEnv[k] = this.resolvePlaceholders(v, rec)
      }
      rec.env = resolvedEnv

      const envPath = path.join(rec.appDir, '.env')
      if (!fs.existsSync(envPath) || overwrite) {
        const envText = Object.entries(resolvedEnv)
          .map(([k, v]) => `${k}=${v}`)
          .join('\n')
        fs.writeFileSync(envPath, `${envText}\n`, { encoding: 'utf8', mode: 0o600 })
      }

      if (tmpl.configTemplate && tmpl.configTemplate.filename !== '.env') {
        const cfgTarget = path.resolve(rec.appDir, path.basename(tmpl.configTemplate.filename))
        if (cfgTarget.startsWith(rec.appDir + path.sep) && (!fs.existsSync(cfgTarget) || overwrite)) {
          fs.writeFileSync(cfgTarget, this.resolvePlaceholders(tmpl.configTemplate.content, rec), 'utf8')
          rec.configFilePath = cfgTarget
        }
      }
      this.appendLog(rec, 'system', `[${rec.name}] Generated configuration template & .env (${rec.configFilePath})`)

      // 4. Launch process
      rec.phase = 'starting'
      rec.progress = 85
      await this.spawnRecordProcess(rec)

      // 5. Verify HTTP / TCP health check
      rec.phase = 'verifying'
      rec.progress = 95
      const probe = await probeLocalHttp(rec.port, rec.healthCheckPath)
      rec.lastHealth = { ...probe, checkedAt: new Date().toISOString() }
      rec.installStatus = 'installed'
      rec.phase = 'completed'
      rec.progress = 100

      // Persist manifest inside appDir
      fs.writeFileSync(
        path.join(rec.appDir, 'kathal.manifest.json'),
        JSON.stringify(
          {
            id: rec.id,
            templateId: rec.templateId,
            name: rec.name,
            version: tmpl.version,
            port: rec.port,
            executable: rec.executable,
            args: rec.args,
            installedAt: rec.installedAt,
          },
          null,
          2
        ),
        'utf8'
      )

      this.appendLog(
        rec,
        'system',
        `[${rec.name}] Installation complete! Running on http://127.0.0.1:${rec.port} (PID ${rec.pid})`
      )
      if (onInstalled) onInstalled(rec)
    } catch (err) {
      rec.installStatus = 'failed'
      rec.phase = 'failed'
      rec.state = 'exited'
      rec.errorMessage = (err as Error).message || 'Installation failed'
      this.appendLog(rec, 'stderr', `[${rec.name}] Installation error: ${rec.errorMessage}`)
    }
  }

  private findExecutableInDir(dir: string, binName: string, depth = 0): string | null {
    if (depth > 3 || !fs.existsSync(dir)) return null
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    const lowerTarget = binName.toLowerCase()
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const lower = entry.name.toLowerCase()
      if (/\.(txt|md|sha256|sha512|sig|asc|license)$/i.test(lower)) continue
      const full = path.join(dir, entry.name)
      if (
        lower === lowerTarget ||
        lower === `${lowerTarget}.exe` ||
        lower.startsWith(`${lowerTarget}-`)
      ) {
        return full
      }
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const nested = this.findExecutableInDir(path.join(dir, entry.name), binName, depth + 1)
        if (nested) return nested
      }
    }
    return null
  }

  private resolveLaunchArgs(rec: InstalledAppRecord, tmpl: ServiceTemplate | undefined, rawTemplateArgs: string[] | undefined): string[] {
    if (
      tmpl?.installMethod === 'npm' &&
      rec.executable === process.execPath &&
      rec.args.length > 0 &&
      rec.args[0].startsWith(rec.appDir + path.sep)
    ) {
      const rest = rawTemplateArgs && rawTemplateArgs.length > 0 ? rawTemplateArgs : rec.args.slice(1)
      return [rec.args[0], ...rest]
    }
    return rawTemplateArgs && rawTemplateArgs.length > 0 ? rawTemplateArgs : rec.args
  }

  async spawnRecordProcess(rec: InstalledAppRecord): Promise<void> {
    const tmpl = getTemplateById(rec.templateId)
    const rawTemplateArgs = tmpl?.installSpec
      ? tmpl.installSpec.npmArgs ||
        tmpl.installSpec.pythonArgs ||
        tmpl.installSpec.binaryArgs ||
        tmpl.installSpec.systemArgs
      : undefined

    const launchArgs = this.resolveLaunchArgs(rec, tmpl, rawTemplateArgs)

    if (this.serviceEngine) {
      const svc = await this.serviceEngine.registerAndSpawn({
        id: rec.id,
        name: rec.name,
        displayName: rec.displayName,
        templateId: rec.templateId,
        source: 'app-store',
        runtime: rec.runtime,
        executable: rec.executable,
        args: launchArgs,
        workingDir: rec.appDir,
        dataDir: rec.dataDir,
        port: rec.port,
        env: rec.env,
        healthCheck: tmpl?.healthCheck,
      })
      rec.port = svc.port
      rec.pid = svc.pid
      rec.state = svc.state
      rec.startedAt = svc.startedAt
      rec.lastExitCode = svc.lastExitCode
      rec.lastHealth = svc.lastHealth
      rec.args = svc.args.map((a) => this.resolvePlaceholders(a, rec))
      this.appendLog(rec, 'system', `[${rec.name}] Supervised by ServiceEngine (PID ${svc.pid}, port ${svc.port})`)
      return
    }

    rec.args = launchArgs.map((a) => this.resolvePlaceholders(a, rec))

    if (rec.child && rec.state === 'running') {
      await this.stopApp(rec.id)
    }
    rec.port = await this.allocateFreePort(rec.port)

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...rec.env,
      PORT: String(rec.port),
      HOST: '127.0.0.1',
    }
    this.appendLog(rec, 'system', `[${rec.name}] Starting: ${path.basename(rec.executable)} ${rec.args.join(' ')}`)

    const child = spawnCrossPlatform(rec.executable, rec.args, {
      cwd: rec.appDir,
      env: childEnv,
    })

    rec.child = child
    rec.pid = child.pid ?? null
    rec.state = 'running'
    rec.startedAt = Date.now()
    rec.lastExitCode = null

    child.stdout?.on('data', (buf: Buffer) => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) this.appendLog(rec, 'stdout', line)
      }
    })
    child.stderr?.on('data', (buf: Buffer) => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) this.appendLog(rec, 'stderr', line)
      }
    })
    child.on('error', (err) => {
      if (rec.child === child) {
        rec.state = 'exited'
        rec.pid = null
        rec.lastExitCode = 1
        rec.child = undefined
        this.appendLog(rec, 'stderr', `[${rec.name}] Process error: ${err.message}`)
      }
    })
    child.on('exit', (code) => {
      if (rec.child === child) {
        rec.state = 'exited'
        rec.pid = null
        rec.lastExitCode = code ?? 0
        rec.child = undefined
        this.appendLog(rec, code === 0 ? 'stdout' : 'stderr', `[${rec.name}] Exited with code ${code ?? 0}`)
      }
    })

    await waitForPortOpen(rec.port, 5000)
  }

  async startApp(id: string): Promise<InstalledAppRecord | null> {
    const rec = this.installations.get(id) || this.findByName(id)
    if (!rec) return null
    if (this.serviceEngine && this.serviceEngine.getService(rec.id)) {
      const svc = await this.serviceEngine.startService(rec.id)
      if (svc) {
        rec.pid = svc.pid
        rec.state = svc.state
        rec.port = svc.port
        rec.startedAt = svc.startedAt
        rec.lastHealth = svc.lastHealth
        return rec
      }
    }
    await this.spawnRecordProcess(rec)
    return rec
  }

  async stopApp(id: string): Promise<InstalledAppRecord | null> {
    const rec = this.installations.get(id) || this.findByName(id)
    if (!rec) return null
    if (this.serviceEngine && this.serviceEngine.getService(rec.id)) {
      await this.serviceEngine.stopService(rec.id)
    }
    if (rec.child || rec.pid) {
      await terminateProcessTree(rec.pid, rec.child)
    }
    rec.state = 'exited'
    rec.pid = null
    rec.child = undefined
    return rec
  }

  async restartApp(id: string): Promise<InstalledAppRecord | null> {
    const rec = this.installations.get(id) || this.findByName(id)
    if (!rec) return null
    if (this.serviceEngine && this.serviceEngine.getService(rec.id)) {
      const svc = await this.serviceEngine.restartService(rec.id)
      if (svc) {
        rec.pid = svc.pid
        rec.state = svc.state
        rec.port = svc.port
        rec.startedAt = svc.startedAt
        rec.lastHealth = svc.lastHealth
        return rec
      }
    }
    await this.stopApp(rec.id)
    await this.spawnRecordProcess(rec)
    return rec
  }

  async checkHealth(id: string) {
    const rec = this.installations.get(id) || this.findByName(id)
    if (!rec) return null
    if (this.serviceEngine && this.serviceEngine.getService(rec.id)) {
      const res = await this.serviceEngine.runHealthCheck(rec.id)
      if (res) {
        rec.lastHealth = res
        return res
      }
    }
    const probe = await probeLocalHttp(rec.port, rec.healthCheckPath)
    rec.lastHealth = { ...probe, checkedAt: new Date().toISOString() }
    return rec.lastHealth
  }

  updateEnv(id: string, envMap: Record<string, string>): InstalledAppRecord | null {
    const rec = this.installations.get(id) || this.findByName(id)
    if (!rec) return null
    rec.env = sanitizeProcessEnv(envMap)
    const svc = this.serviceEngine?.getService(rec.id)
    if (svc) {
      svc.env = { ...rec.env }
    }
    const envPath = path.join(rec.appDir, '.env')
    const envText = Object.entries(rec.env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')
    fs.writeFileSync(envPath, `${envText}\n`, { encoding: 'utf8', mode: 0o600 })
    this.appendLog(rec, 'system', `[${rec.name}] Updated .env (${Object.keys(rec.env).length} variable(s))`)
    return rec
  }

  async uninstall(id: string, keepData = false): Promise<{ deleted: boolean; keptDataDir: string | null }> {
    const rec = this.installations.get(id) || this.findByName(id)
    if (!rec) return { deleted: false, keptDataDir: null }
    await this.stopApp(rec.id)
    if (this.serviceEngine && this.serviceEngine.getService(rec.id)) {
      await this.serviceEngine.deleteService(rec.id, true)
    }
    this.installations.delete(rec.id)

    let keptDataDir: string | null = null
    if (rec.appDir.startsWith(this.appsRoot + path.sep) && fs.existsSync(rec.appDir)) {
      if (keepData && fs.existsSync(rec.dataDir)) {
        const archiveDir = path.resolve(this.appsRoot, `${rec.name}-preserved-data-${Date.now()}`)
        if (archiveDir.startsWith(this.appsRoot + path.sep)) {
          fs.renameSync(rec.dataDir, archiveDir)
          keptDataDir = archiveDir
        }
      }
      fs.rmSync(rec.appDir, { recursive: true, force: true })
    }
    return { deleted: true, keptDataDir }
  }

  findByName(name: string): InstalledAppRecord | undefined {
    const clean = sanitizeAppName(name)
    return Array.from(this.installations.values()).find((r) => r.name === clean)
  }

  findByTemplateId(templateId: string): InstalledAppRecord | undefined {
    return Array.from(this.installations.values()).find((r) => r.templateId === templateId)
  }

  listAll(): InstalledAppRecord[] {
    return Array.from(this.installations.values()).sort((a, b) => b.created - a.created)
  }

  serializeInstallation(rec: InstalledAppRecord) {
    const svc = this.serviceEngine?.getService(rec.id)
    const svcView = svc ? this.serviceEngine!.serializeService(svc) : null
    if (svcView) {
      rec.pid = svcView.pid
      rec.state = svcView.state
      rec.lastHealth = svcView.lastHealth
    }

    const { uptimeSeconds, uptimeLabel } = svcView
      ? { uptimeSeconds: svcView.uptimeSeconds, uptimeLabel: svcView.uptimeLabel }
      : rec.state === 'running'
      ? formatProcessUptime(rec.startedAt)
      : {
          uptimeSeconds: 0,
          uptimeLabel: rec.lastExitCode !== null ? `Exited (${rec.lastExitCode})` : 'Stopped',
        }
    const telemetry = svcView
      ? {
          cpuPercent: svcView.cpuPercent,
          memoryBytes: svcView.memoryBytes,
          memoryMb: svcView.memoryMb,
          memoryPercent: svcView.memoryPercent,
          threads: svcView.threads,
        }
      : rec.state === 'running'
      ? samplePidMetricsCrossPlatform(rec.pid, rec.id)
      : { cpuPercent: 0, memoryBytes: 0, memoryMb: 0, memoryPercent: 0, threads: 0 }

    const mergedLogs = svc
      ? [...rec.logs.slice(-80), ...svc.logs.slice(-80)].slice(-120)
      : rec.logs.slice(-120)

    return {
      id: rec.id,
      templateId: rec.templateId,
      name: rec.name,
      displayName: rec.displayName,
      image: rec.displayName,
      runtime: rec.runtime,
      runtimeLabel: `${rec.compatibility} (${rec.installMethod})`,
      source: 'app-store' as const,
      compatibility: rec.compatibility,
      installMethod: rec.installMethod,
      command: `${path.basename(rec.executable)} ${rec.args.join(' ')}`.trim(),
      executable: rec.executable,
      args: rec.args,
      workingDir: rec.appDir,
      appDir: rec.appDir,
      dataDir: rec.dataDir,
      configFilePath: rec.configFilePath,
      port: rec.port,
      ports: [{ hostPort: rec.port, containerPort: rec.port, protocol: 'tcp' }],
      state: rec.state,
      status: rec.state === 'running' ? `Up ${uptimeLabel}` : uptimeLabel,
      uptimeSeconds,
      uptimeLabel,
      cpuPercent: telemetry.cpuPercent,
      memoryBytes: telemetry.memoryBytes,
      memoryMb: telemetry.memoryMb,
      memoryPercent: telemetry.memoryPercent,
      threads: telemetry.threads,
      pid: rec.pid,
      restartCount: svcView?.restartCount ?? 0,
      metricsHistory: svcView?.metricsHistory ?? [],
      installStatus: rec.installStatus,
      phase: rec.phase,
      progress: rec.progress,
      errorMessage: rec.errorMessage,
      env: rec.env,
      lastHealth: rec.lastHealth,
      liveUrl: `/live/${rec.name}/`,
      installedAt: rec.installedAt,
      created: rec.created,
      logs: mergedLogs,
    }
  }
}
