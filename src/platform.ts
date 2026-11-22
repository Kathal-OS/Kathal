import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type PlatformBinaryKey =
  | 'linux_x64'
  | 'linux_arm64'
  | 'darwin_x64'
  | 'darwin_arm64'
  | 'win32_x64'
  | 'win32_arm64'

export function isWindows(): boolean {
  return process.platform === 'win32'
}

export function isMacOS(): boolean {
  return process.platform === 'darwin'
}

export function isLinux(): boolean {
  return process.platform === 'linux'
}

export function getPlatformLabel(platform: string = process.platform): 'Windows' | 'macOS' | 'Linux' {
  if (platform === 'win32') return 'Windows'
  if (platform === 'darwin') return 'macOS'
  return 'Linux'
}

export function getPlatformBinaryKey(): PlatformBinaryKey {
  const arch = os.arch() === 'arm64' ? 'arm64' : 'x64'
  if (process.platform === 'win32') return arch === 'arm64' ? 'win32_arm64' : 'win32_x64'
  if (process.platform === 'darwin') return arch === 'arm64' ? 'darwin_arm64' : 'darwin_x64'
  return arch === 'arm64' ? 'linux_arm64' : 'linux_x64'
}

export function getPlatformBinaryCandidates(): PlatformBinaryKey[] {
  const primary = getPlatformBinaryKey()
  if (primary === 'win32_arm64') return ['win32_arm64', 'win32_x64']
  if (primary === 'darwin_arm64') return ['darwin_arm64', 'darwin_x64']
  return [primary]
}

export function getDataDir(): string {
  const configured = (process.env.KATHAL_DATA_DIR || '').trim()
  if (configured) return path.resolve(configured)
  return path.resolve(process.cwd(), 'data')
}

export function getDefaultAppsRoot(): string {
  const configured = (process.env.KATHAL_APPS_DIR || '').trim()
  if (configured) return path.resolve(configured)
  return path.resolve(getDataDir(), 'apps')
}

export function getSystemDiskMount(): string {
  if (process.platform === 'win32') {
    const parsed = path.parse(process.cwd())
    return parsed.root || (process.env.SystemDrive ? `${process.env.SystemDrive}\\` : 'C:\\')
  }
  return '/'
}

export function getProtectedSystemDirs(): string[] {
  if (process.platform === 'win32') {
    const sysRoot = process.env.SystemRoot || 'C:\\Windows'
    const pf = process.env.ProgramFiles || 'C:\\Program Files'
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    const pd = process.env.ProgramData || 'C:\\ProgramData'
    return [sysRoot, pf, pf86, pd].filter(Boolean).map((p) => path.resolve(p))
  }
  return [
    '/etc',
    '/proc',
    '/sys',
    '/dev',
    '/boot',
    '/root',
    '/System',
    '/Library',
    '/private/etc',
  ]
}

export function isProtectedSystemPath(resolvedPath: string): boolean {
  const normalized = path.resolve(resolvedPath)
  const blocked = getProtectedSystemDirs()
  if (process.platform === 'win32') {
    const lower = normalized.toLowerCase()
    return blocked.some((dir) => {
      const b = dir.toLowerCase()
      return lower === b || lower.startsWith(b + path.sep)
    })
  }
  return blocked.some((dir) => normalized === dir || normalized.startsWith(dir + path.sep))
}

/**
 * Pure Node.js PATH lookup supporting Windows PATHEXT (.exe, .cmd, .bat)
 * and POSIX executable bits without shelling out to `which`.
 */
export function findExecutableOnPath(binName: string): string | null {
  const raw = String(binName || '').trim()
  if (!raw) return null

  const pathExts =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
          .split(';')
          .map((e) => e.trim())
          .filter(Boolean)
      : ['']

  const hasExt = process.platform === 'win32' && /\.[a-z0-9]+$/i.test(raw)
  const candidatesForDir = (dir: string): string[] => {
    if (process.platform !== 'win32' || hasExt) {
      return [path.join(dir, raw)]
    }
    return ['', ...pathExts].map((ext) => path.join(dir, `${raw}${ext}`))
  }

  if (raw.includes('/') || raw.includes('\\')) {
    const resolved = path.resolve(raw)
    const dir = path.dirname(resolved)
    const base = path.basename(resolved)
    const checks =
      process.platform === 'win32' && !hasExt
        ? ['', ...pathExts].map((ext) => path.join(dir, `${base}${ext}`))
        : [resolved]
    for (const candidate of checks) {
      if (isExecutableFile(candidate)) return candidate
    }
    return null
  }

  const pathEnv = process.env.PATH || process.env.Path || ''
  for (const dir of pathEnv.split(path.delimiter)) {
    const trimmedDir = dir.trim()
    if (!trimmedDir) continue
    for (const candidate of candidatesForDir(trimmedDir)) {
      if (isExecutableFile(candidate)) return candidate
    }
  }
  return null
}

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) return false
    if (process.platform === 'win32') return true
    fs.accessSync(filePath, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Resolves npm so it executes via Node.js directly (shell: false safe on Windows, macOS, and Linux).
 */
export function resolveNpmInvocation(npmArgs: string[]): { executable: string; args: string[] } {
  const nodeDir = path.dirname(process.execPath)
  const candidates = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  for (const cliPath of candidates) {
    if (fs.existsSync(cliPath)) {
      return { executable: process.execPath, args: [cliPath, ...npmArgs] }
    }
  }
  const onPath = findExecutableOnPath('npm')
  if (onPath) {
    return { executable: onPath, args: npmArgs }
  }
  return { executable: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: npmArgs }
}

/**
 * Resolves an installed npm package binary cleanly across Windows, macOS, and Linux.
 * Prefers resolving the underlying JS entrypoint via package.json so it spawns directly
 * with `node` (`shell: false`), avoiding Windows `.cmd` shim pitfalls.
 */
export function resolveNpmBinEntrypoint(
  appDir: string,
  binName: string,
  packageNameHint?: string
): { executable: string; argsPrefix: string[] } | null {
  const cleanPkgName = packageNameHint ? packageNameHint.replace(/@[^@/]+$/, '') : ''
  const candidatePkgDirs: string[] = []
  if (cleanPkgName) {
    candidatePkgDirs.push(path.join(appDir, 'node_modules', ...cleanPkgName.split('/')))
  }
  const pkgRoot = path.join(appDir, 'node_modules', binName)
  if (!candidatePkgDirs.includes(pkgRoot)) {
    candidatePkgDirs.push(pkgRoot)
  }

  for (const pkgDir of candidatePkgDirs) {
    const pkgJsonPath = path.join(pkgDir, 'package.json')
    if (!fs.existsSync(pkgJsonPath)) continue
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as {
        bin?: string | Record<string, string>
      }
      let relBin = ''
      if (typeof pkg.bin === 'string') {
        relBin = pkg.bin
      } else if (pkg.bin && typeof pkg.bin === 'object') {
        relBin = pkg.bin[binName] || Object.values(pkg.bin)[0] || ''
      }
      if (relBin) {
        const entry = path.resolve(pkgDir, relBin)
        if (entry.startsWith(appDir + path.sep) && fs.existsSync(entry)) {
          if (/\.(m|c)?js$/i.test(entry) || readHasNodeShebang(entry)) {
            return { executable: process.execPath, argsPrefix: [entry] }
          }
          return { executable: entry, argsPrefix: [] }
        }
      }
    } catch {
      // fall through to .bin lookup
    }
  }

  const binDir = path.join(appDir, 'node_modules', '.bin')
  if (process.platform === 'win32') {
    for (const ext of ['.exe', '.cmd', '.bat', '']) {
      const full = path.join(binDir, `${binName}${ext}`)
      if (fs.existsSync(full)) {
        return { executable: full, argsPrefix: [] }
      }
    }
  } else {
    const full = path.join(binDir, binName)
    if (fs.existsSync(full)) {
      return { executable: full, argsPrefix: [] }
    }
  }
  return null
}

function readHasNodeShebang(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(64)
    const bytes = fs.readSync(fd, buf, 0, 64, 0)
    fs.closeSync(fd)
    const head = buf.subarray(0, bytes).toString('utf8')
    return head.startsWith('#!') && head.toLowerCase().includes('node')
  } catch {
    return false
  }
}

export function resolvePythonCommand(): { executable: string; prefixArgs: string[] } {
  const py3 = findExecutableOnPath('python3')
  if (py3) {
    // On Windows Store stubs, `python3.exe` in WindowsApps can be an alias stub; prefer real `python` if python3 is in WindowsApps
    if (process.platform !== 'win32' || !py3.toLowerCase().includes('windowsapps')) {
      return { executable: py3, prefixArgs: [] }
    }
  }
  const py = findExecutableOnPath('python')
  if (py) {
    return { executable: py, prefixArgs: [] }
  }
  if (process.platform === 'win32') {
    const pyLauncher = findExecutableOnPath('py')
    if (pyLauncher) {
      return { executable: pyLauncher, prefixArgs: ['-3'] }
    }
  }
  return { executable: process.platform === 'win32' ? 'python' : 'python3', prefixArgs: [] }
}

export function getVenvPaths(venvDir: string): {
  binDir: string
  python: string
  pip: string
  resolveTool: (toolName: string) => string
} {
  const binDir = path.join(venvDir, process.platform === 'win32' ? 'Scripts' : 'bin')
  const ext = process.platform === 'win32' ? '.exe' : ''
  const python =
    process.platform === 'win32'
      ? path.join(binDir, 'python.exe')
      : fs.existsSync(path.join(binDir, 'python3'))
      ? path.join(binDir, 'python3')
      : path.join(binDir, 'python')
  const pip = path.join(binDir, `pip${ext}`)

  const resolveTool = (toolName: string): string => {
    if (toolName === 'python' || toolName === 'python3') return python
    if (process.platform === 'win32') {
      for (const suffix of ['.exe', '.cmd', '.bat', '']) {
        const candidate = path.join(binDir, `${toolName}${suffix}`)
        if (fs.existsSync(candidate)) return candidate
      }
      return path.join(binDir, `${toolName}.exe`)
    }
    return path.join(binDir, toolName)
  }

  return { binDir, python, pip, resolveTool }
}

/**
 * Safely spawns executables across Linux, macOS, and Windows.
 * Uses `shell: false` everywhere; on Windows, only wraps verified `.cmd`/`.bat` shims
 * via `cmd.exe /d /s /c` so Node 20+ does not throw EINVAL.
 */
export function spawnCrossPlatform(
  executable: string,
  args: string[],
  options: Omit<SpawnOptions, 'shell'> = {}
): ChildProcess {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) {
    const comspec = process.env.ComSpec || 'cmd.exe'
    return spawn(comspec, ['/d', '/s', '/c', executable, ...args], {
      ...options,
      shell: false,
      windowsHide: true,
    })
  }

  return spawn(executable, args, {
    ...options,
    shell: false,
    windowsHide: true,
  })
}

export async function terminateProcessTree(
  pid: number | null,
  child?: ChildProcess,
  timeoutMs = 2200
): Promise<void> {
  if (process.platform === 'win32') {
    const targetPid = pid || child?.pid || null
    if (targetPid && targetPid > 0) {
      try {
        await execFileAsync('taskkill', ['/PID', String(targetPid), '/T', '/F'], {
          timeout: 3000,
          windowsHide: true,
        })
        return
      } catch {
        // Fallback to child.kill() if process already exited
      }
    }
    if (child && !child.killed) {
      try {
        child.kill()
      } catch {
        // ignore
      }
    }
    return
  }

  if (child && !child.killed) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // ignore
        }
        resolve()
      }, timeoutMs)
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
    return
  }

  if (pid && pid > 0) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // ignore
    }
  }
}

export interface ProcessMetricSnapshot {
  cpuPercent: number
  memoryBytes: number
  memoryMb: number
  memoryPercent: number
  threads: number
}

interface CachedOsProcEntry {
  pid: number
  ppid: number
  cpuPercent: number
  memoryBytes: number
  threads: number
}

let cachedOsProcTable = new Map<number, CachedOsProcEntry>()
let lastOsProcRefreshMs = 0
let osProcRefreshInFlight: Promise<void> | null = null
const linuxCpuTickHistory = new Map<string, { procTicks: number; tsMs: number }>()

/**
 * Refreshes the cross-platform OS process telemetry table asynchronously (used on macOS & Windows;
 * Linux reads /proc synchronously with zero overhead).
 */
export async function refreshPlatformProcessTable(force = false): Promise<void> {
  if (process.platform === 'linux') return
  const now = Date.now()
  if (!force && now - lastOsProcRefreshMs < 1500) return
  if (osProcRefreshInFlight) return osProcRefreshInFlight

  osProcRefreshInFlight = (async () => {
    try {
      const next = new Map<number, CachedOsProcEntry>()
      if (process.platform === 'darwin') {
        const { stdout } = await execFileAsync(
          'ps',
          ['-ax', '-o', 'pid=,ppid=,%cpu=,rss='],
          { timeout: 2500 }
        )
        for (const line of stdout.split(/\r?\n/)) {
          const parts = line.trim().split(/\s+/)
          if (parts.length < 4) continue
          const pid = Number(parts[0])
          const ppid = Number(parts[1])
          const cpu = Number(parts[2]) || 0
          const rssKb = Number(parts[3]) || 0
          if (Number.isInteger(pid) && pid > 0) {
            next.set(pid, {
              pid,
              ppid: Number.isInteger(ppid) ? ppid : 0,
              cpuPercent: cpu,
              memoryBytes: rssKb * 1024,
              threads: 1,
            })
          }
        }
      } else if (process.platform === 'win32') {
        const psScript =
          'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.WorkingSetSize)|$($_.ThreadCount)" }'
        const { stdout } = await execFileAsync(
          'powershell',
          ['-NoProfile', '-NonInteractive', '-Command', psScript],
          { timeout: 3500, windowsHide: true }
        )
        for (const line of stdout.split(/\r?\n/)) {
          const [pidS, ppidS, wsS, thrS] = line.trim().split('|')
          const pid = Number(pidS)
          if (!Number.isInteger(pid) || pid <= 0) continue
          next.set(pid, {
            pid,
            ppid: Number(ppidS) || 0,
            cpuPercent: 0,
            memoryBytes: Number(wsS) || 0,
            threads: Number(thrS) || 1,
          })
        }
      }
      cachedOsProcTable = next
      lastOsProcRefreshMs = Date.now()
    } catch {
      // Non-fatal telemetry fallback
    } finally {
      osProcRefreshInFlight = null
    }
  })()

  return osProcRefreshInFlight
}

function collectLinuxDescendantPids(rootPid: number, maxDepth = 4): number[] {
  const seen = new Set<number>([rootPid])
  const queue: { pid: number; depth: number }[] = [{ pid: rootPid, depth: 0 }]

  while (queue.length > 0) {
    const current = queue.shift()!
    if (current.depth >= maxDepth) continue
    try {
      const taskDir = `/proc/${current.pid}/task`
      if (!fs.existsSync(taskDir)) continue
      for (const tid of fs.readdirSync(taskDir)) {
        const childrenFile = path.join(taskDir, tid, 'children')
        if (!fs.existsSync(childrenFile)) continue
        const raw = fs.readFileSync(childrenFile, 'utf8').trim()
        if (!raw) continue
        for (const tok of raw.split(/\s+/)) {
          const childPid = Number(tok)
          if (Number.isInteger(childPid) && childPid > 0 && !seen.has(childPid)) {
            seen.add(childPid)
            queue.push({ pid: childPid, depth: current.depth + 1 })
          }
        }
      }
    } catch {
      // ignore exited pid
    }
  }
  return Array.from(seen)
}

function collectCachedTreePids(rootPid: number): number[] {
  const seen = new Set<number>([rootPid])
  const queue = [rootPid]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const entry of cachedOsProcTable.values()) {
      if (entry.ppid === current && !seen.has(entry.pid)) {
        seen.add(entry.pid)
        queue.push(entry.pid)
      }
    }
  }
  return Array.from(seen)
}

export function samplePidMetricsCrossPlatform(
  rootPid: number | null,
  metricKey?: string
): ProcessMetricSnapshot {
  if (!rootPid || rootPid <= 0) {
    return { cpuPercent: 0, memoryBytes: 0, memoryMb: 0, memoryPercent: 0, threads: 0 }
  }

  const totalMem = os.totalmem() || 1
  const key = metricKey || `pid:${rootPid}`

  if (process.platform === 'linux') {
    const pids = collectLinuxDescendantPids(rootPid)
    let totalBytes = 0
    let totalThreads = 0
    let totalTicks = 0

    for (const pid of pids) {
      try {
        const statusText = fs.readFileSync(`/proc/${pid}/status`, 'utf8')
        const rssMatch = /^VmRSS:\s+(\d+)\s+kB/m.exec(statusText)
        if (rssMatch) totalBytes += Number(rssMatch[1]) * 1024
        const threadsMatch = /^Threads:\s+(\d+)/m.exec(statusText)
        totalThreads += Number(threadsMatch?.[1] || 1)
      } catch {
        // ignore exited pid
      }

      try {
        const statText = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
        const closeParen = statText.lastIndexOf(')')
        if (closeParen !== -1) {
          const fields = statText.slice(closeParen + 2).trim().split(/\s+/)
          totalTicks += Number(fields[11] || 0) + Number(fields[12] || 0)
        }
      } catch {
        // ignore exited pid
      }
    }

    let cpuPercent = 0
    const now = Date.now()
    const prev = linuxCpuTickHistory.get(key)
    if (prev && now > prev.tsMs && totalTicks >= prev.procTicks) {
      const deltaSec = (now - prev.tsMs) / 1000
      const deltaTicks = totalTicks - prev.procTicks
      const pct = (deltaTicks / 100 / deltaSec) * 100
      cpuPercent = Number(Math.min(100 * Math.max(1, os.cpus().length), Math.max(0, pct)).toFixed(1))
    }
    linuxCpuTickHistory.set(key, { procTicks: totalTicks, tsMs: now })

    return {
      cpuPercent,
      memoryBytes: totalBytes,
      memoryMb: Number((totalBytes / (1024 * 1024)).toFixed(1)),
      memoryPercent: Number(((totalBytes / totalMem) * 100).toFixed(2)),
      threads: totalThreads || 1,
    }
  }

  // Trigger async background refresh on macOS / Windows if stale
  if (Date.now() - lastOsProcRefreshMs > 1800) {
    void refreshPlatformProcessTable()
  }

  const pids = collectCachedTreePids(rootPid)
  let totalBytes = 0
  let totalCpu = 0
  let totalThreads = 0
  for (const p of pids) {
    const entry = cachedOsProcTable.get(p)
    if (!entry) continue
    totalBytes += entry.memoryBytes
    totalCpu += entry.cpuPercent
    totalThreads += entry.threads
  }

  return {
    cpuPercent: Number(totalCpu.toFixed(1)),
    memoryBytes: totalBytes,
    memoryMb: Number((totalBytes / (1024 * 1024)).toFixed(1)),
    memoryPercent: Number(((totalBytes / totalMem) * 100).toFixed(2)),
    threads: totalThreads || 1,
  }
}

export function clearPidMetricHistory(metricKey: string): void {
  linuxCpuTickHistory.delete(metricKey)
}

export function detectArchiveType(
  url: string,
  fallback: 'zip' | 'tar.gz' | 'bz2' | 'raw' = 'raw'
): 'zip' | 'tar.gz' | 'bz2' | 'raw' {
  const cleanUrl = url.split('?')[0].toLowerCase()
  if (cleanUrl.endsWith('.tar.gz') || cleanUrl.endsWith('.tgz')) return 'tar.gz'
  if (cleanUrl.endsWith('.zip')) return 'zip'
  if (cleanUrl.endsWith('.bz2')) return 'bz2'
  if (cleanUrl.endsWith('.exe')) return 'raw'
  return fallback
}

export async function downloadHttpsFile(
  url: string,
  destPath: string,
  isAllowedHost: (host: string) => boolean
): Promise<void> {
  let currentUrl = url
  for (let redirects = 0; redirects < 6; redirects += 1) {
    const parsed = new URL(currentUrl)
    if (parsed.protocol !== 'https:') {
      throw new Error(`Blocked non-HTTPS download URL: ${currentUrl}`)
    }
    if (!isAllowedHost(parsed.hostname.toLowerCase())) {
      throw new Error(`Host "${parsed.hostname}" is not in the verified binary download allowlist`)
    }

    const res = await fetch(currentUrl, {
      redirect: 'manual',
      headers: { 'User-Agent': 'KATHAL-OS-Installer/1.0' },
    })
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) throw new Error(`HTTP ${res.status} redirect missing Location header`)
      currentUrl = new URL(location, currentUrl).toString()
      continue
    }
    if (!res.ok) {
      throw new Error(`Download failed with HTTP ${res.status} ${res.statusText}`)
    }
    const arrayBuf = await res.arrayBuffer()
    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    fs.writeFileSync(destPath, Buffer.from(arrayBuf))
    return
  }
  throw new Error('Too many redirects while downloading release binary')
}

export async function extractArchiveCrossPlatform(
  archiveKind: 'zip' | 'tar.gz' | 'bz2' | 'raw',
  archivePath: string,
  binDir: string,
  targetRawBin: string
): Promise<void> {
  if (archiveKind === 'tar.gz') {
    const tarBin = findExecutableOnPath('tar') || 'tar'
    await execFileAsync(tarBin, ['-xzf', archivePath, '-C', binDir], {
      timeout: 60_000,
      windowsHide: true,
    })
    fs.rmSync(archivePath, { force: true })
    return
  }

  if (archiveKind === 'zip') {
    if (process.platform === 'win32') {
      await execFileAsync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Expand-Archive -LiteralPath $env:KATHAL_ARCHIVE -DestinationPath $env:KATHAL_DEST -Force',
        ],
        {
          timeout: 60_000,
          windowsHide: true,
          env: {
            ...process.env,
            KATHAL_ARCHIVE: archivePath,
            KATHAL_DEST: binDir,
          },
        }
      )
    } else {
      const unzipBin = findExecutableOnPath('unzip')
      if (unzipBin) {
        await execFileAsync(unzipBin, ['-o', archivePath, '-d', binDir], { timeout: 60_000 })
      } else {
        const tarBin = findExecutableOnPath('tar')
        if (!tarBin) throw new Error('Neither unzip nor tar is installed to extract .zip archive')
        await execFileAsync(tarBin, ['-xf', archivePath, '-C', binDir], { timeout: 60_000 })
      }
    }
    fs.rmSync(archivePath, { force: true })
    return
  }

  if (archiveKind === 'bz2') {
    const bzip2Bin = findExecutableOnPath('bzip2')
    if (!bzip2Bin) {
      throw new Error('bzip2 is required to extract .bz2 archives on this host')
    }
    await execFileAsync(bzip2Bin, ['-df', archivePath], { timeout: 60_000, windowsHide: true })
    const extractedRaw = archivePath.replace(/\.bz2$/, '')
    if (fs.existsSync(extractedRaw)) {
      fs.renameSync(extractedRaw, targetRawBin)
    }
  }
}
