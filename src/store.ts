import os from 'node:os'
import fs from 'node:fs'
import crypto from 'node:crypto'

export interface ContainerRecord {
  id: string
  name: string
  image: string
  state: 'running' | 'exited' | 'paused'
  status: string
  ports: Array<{ hostPort: number; containerPort: number; protocol?: string }>
  created: number
}

export interface ImageRecord {
  id: string
  repoTags: string[]
  size: number
  created: number
}

export interface ProxyRoute {
  id: string
  domain: string
  target: string
  port: number
  ssl: boolean
  enabled: boolean
}

export interface ManagedDatabase {
  id: string
  name: string
  type: 'postgres' | 'mysql' | 'mongodb' | 'redis'
  port: number
  user: string
  password: string
  status: 'running' | 'stopped'
}

export interface BackupRecord {
  id: string
  name: string
  created_at: string
  size: string
}

export interface GitRepo {
  id: string
  name: string
  url: string
  branch: string
  deploy_cmd: string
  status: 'idle' | 'success' | 'failed'
  last_deploy?: string
}

export interface GitDeployLog {
  timestamp: string
  commit?: string
  output?: string
  error?: string
}

export interface ComposeProject {
  name: string
  workingDir: string
  status: 'running' | 'stopped' | 'created'
  services: string[]
  config: string
  updatedAt: string
}

export interface EnvVar {
  key: string
  value: string
  description: string
  secret: boolean
}

export interface NetworkRecord {
  id: string
  name: string
  driver: string
  scope: string
  internal: boolean
  attachable: boolean
  ingress: boolean
  containers: string[]
}

export interface VolumeRecord {
  name: string
  driver: string
  mountpoint: string
  scope: string
}

export interface AppRecord {
  id: string
  name: string
  image: string
  port: number
  status: string
  createdAt: string
}

export interface LogLine {
  timestamp: string
  stream: 'stdout' | 'stderr'
  content: string
}

export interface VirtualFileNode {
  isDir: boolean
  content: string
  updatedAt: string
}

export interface MonitoringSample {
  timestamp: string
  cpu: { percent: number; cores: number }
  memory: { total: number; used: number; available: number; percent: number }
  disk: { total: number; used: number; free: number; percent: number }
  network: { bytesRecv: number; bytesSent: number; packetsRecv: number; packetsSent: number }
  containers: Array<{
    id: string
    name: string
    cpuPercent: number
    memoryUsage: number
    memoryLimit: number
    netIO: { rxBytes: number; txBytes: number }
    blockIO: { readBytes: number; writeBytes: number }
    pids: number
  }>
}

const nowSec = Math.floor(Date.now() / 1000)

export class MemoryStore {
  containers: ContainerRecord[] = [
    {
      id: 'a1b2c3d4e5f6',
      name: 'kathal-proxy',
      image: 'nginx:alpine',
      state: 'running',
      status: 'Up 3 days',
      ports: [{ hostPort: 80, containerPort: 80 }, { hostPort: 443, containerPort: 443 }],
      created: nowSec - 86400 * 3,
    },
    {
      id: 'b2c3d4e5f6a1',
      name: 'kathal-postgres',
      image: 'postgres:16-alpine',
      state: 'running',
      status: 'Up 5 days',
      ports: [{ hostPort: 5432, containerPort: 5432 }],
      created: nowSec - 86400 * 5,
    },
    {
      id: 'c3d4e5f6a1b2',
      name: 'kathal-redis',
      image: 'redis:7-alpine',
      state: 'running',
      status: 'Up 5 days',
      ports: [{ hostPort: 6379, containerPort: 6379 }],
      created: nowSec - 86400 * 5,
    },
    {
      id: 'd4e5f6a1b2c3',
      name: 'uptime-kuma',
      image: 'louislam/uptime-kuma:latest',
      state: 'exited',
      status: 'Exited (0) 2 hours ago',
      ports: [{ hostPort: 3001, containerPort: 3001 }],
      created: nowSec - 86400 * 2,
    },
  ]

  images: ImageRecord[] = [
    { id: 'sha256:9f8e7d6c5b4a', repoTags: ['nginx:alpine'], size: 43253760, created: nowSec - 86400 * 7 },
    { id: 'sha256:8e7d6c5b4a39', repoTags: ['postgres:16-alpine'], size: 249561088, created: nowSec - 86400 * 10 },
    { id: 'sha256:7d6c5b4a3928', repoTags: ['redis:7-alpine'], size: 35651584, created: nowSec - 86400 * 14 },
    { id: 'sha256:6c5b4a392817', repoTags: ['louislam/uptime-kuma:latest'], size: 412090368, created: nowSec - 86400 * 4 },
  ]

  proxyRoutes: ProxyRoute[] = [
    {
      id: 'proxy-1',
      domain: 'dashboard.kathal.local',
      target: 'http://localhost:3000',
      port: 80,
      ssl: true,
      enabled: true,
    },
    {
      id: 'proxy-2',
      domain: 'status.kathal.local',
      target: 'http://localhost:3001',
      port: 80,
      ssl: false,
      enabled: false,
    },
  ]

  databases: ManagedDatabase[] = [
    {
      id: 'db-1',
      name: 'kathal-main',
      type: 'postgres',
      port: 5432,
      user: 'kathal',
      password: 'kathal-db-password',
      status: 'running',
    },
    {
      id: 'db-2',
      name: 'session-cache',
      type: 'redis',
      port: 6379,
      user: 'default',
      password: 'redis-password',
      status: 'running',
    },
  ]

  backups: BackupRecord[] = [
    {
      id: 'bkp-initial',
      name: 'initial-snapshot',
      created_at: new Date(Date.now() - 86400 * 1000).toISOString(),
      size: '4.2 MB',
    },
  ]

  gitRepos: GitRepo[] = [
    {
      id: 'repo-1',
      name: 'kathal-sample-app',
      url: 'https://github.com/Kathal-OS/sample-app.git',
      branch: 'main',
      deploy_cmd: 'docker compose up -d --build',
      status: 'success',
      last_deploy: new Date(Date.now() - 3600 * 1000).toISOString(),
    },
  ]

  gitHistory = new Map<string, GitDeployLog[]>([
    [
      'repo-1',
      [
        {
          timestamp: new Date(Date.now() - 3600 * 1000).toISOString(),
          commit: '7f4a21c',
          output: 'Pulled origin/main\nBuilt image kathal-sample-app:latest\nStarted container kathal-sample-app',
        },
      ],
    ],
  ])

  composeProjects: ComposeProject[] = [
    {
      name: 'web-stack',
      workingDir: '/data/compose/web-stack',
      status: 'running',
      services: ['nginx', 'redis'],
      config: `version: '3.8'\nservices:\n  nginx:\n    image: nginx:alpine\n    ports:\n      - "80:80"\n  redis:\n    image: redis:7-alpine\n    ports:\n      - "6379:6379"`,
      updatedAt: new Date(Date.now() - 7200 * 1000).toISOString(),
    },
  ]

  envVars: EnvVar[] = [
    {
      key: 'KATHAL_ENV',
      value: 'production',
      description: 'Default deployment environment',
      secret: false,
    },
    {
      key: 'POSTGRES_PASSWORD',
      value: 'super-secret-value',
      description: 'Shared database password',
      secret: true,
    },
  ]

  networks: NetworkRecord[] = [
    {
      id: 'net-bridge',
      name: 'bridge',
      driver: 'bridge',
      scope: 'local',
      internal: false,
      attachable: false,
      ingress: false,
      containers: ['a1b2c3d4e5f6', 'b2c3d4e5f6a1'],
    },
    {
      id: 'net-kathal',
      name: 'kathal-internal',
      driver: 'bridge',
      scope: 'local',
      internal: true,
      attachable: true,
      ingress: false,
      containers: ['b2c3d4e5f6a1', 'c3d4e5f6a1b2'],
    },
  ]

  volumes: VolumeRecord[] = [
    {
      name: 'pgdata',
      driver: 'local',
      mountpoint: '/var/lib/docker/volumes/pgdata/_data',
      scope: 'local',
    },
    {
      name: 'redisdata',
      driver: 'local',
      mountpoint: '/var/lib/docker/volumes/redisdata/_data',
      scope: 'local',
    },
  ]

  apps = new Map<string, AppRecord>()

  files = new Map<string, VirtualFileNode>([
    ['/', { isDir: true, content: '', updatedAt: new Date().toISOString() }],
    ['/data', { isDir: true, content: '', updatedAt: new Date().toISOString() }],
    ['/etc', { isDir: true, content: '', updatedAt: new Date().toISOString() }],
    ['/etc/kathal', { isDir: true, content: '', updatedAt: new Date().toISOString() }],
    ['/var', { isDir: true, content: '', updatedAt: new Date().toISOString() }],
    ['/var/log', { isDir: true, content: '', updatedAt: new Date().toISOString() }],
    [
      '/etc/kathal/config.json',
      {
        isDir: false,
        content: JSON.stringify({ port: 3000, logLevel: 'info', dbPath: '/data/kathal.db' }, null, 2),
        updatedAt: new Date().toISOString(),
      },
    ],
    [
      '/data/docker-compose.yml',
      {
        isDir: false,
        content: "version: '3.8'\nservices:\n  web:\n    image: nginx:alpine\n    ports:\n      - '80:80'\n",
        updatedAt: new Date().toISOString(),
      },
    ],
    [
      '/var/log/kathal.log',
      {
        isDir: false,
        content: `[${new Date().toISOString()}] INFO kathal: dashboard initialized\n[${new Date().toISOString()}] INFO kathal: metrics collector started\n`,
        updatedAt: new Date().toISOString(),
      },
    ],
  ])

  monitoringHistory: MonitoringSample[] = []
  private lastCpuTotal = 0
  private lastCpuIdle = 0

  constructor() {
    // Seed a small initial history so Sparkline charts render smoothly right away.
    for (let i = 10; i >= 1; i--) {
      const sample = this.collectMonitoringSample(Date.now() - i * 2000)
      this.monitoringHistory.push(sample)
    }
  }

  private sampleCpuPercent(): number {
    const cpus = os.cpus()
    let idle = 0
    let total = 0
    for (const cpu of cpus) {
      idle += cpu.times.idle
      total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq
    }
    if (this.lastCpuTotal === 0) {
      this.lastCpuTotal = total
      this.lastCpuIdle = idle
      const load = os.loadavg()[0] || 0.25
      return Math.min(95, Math.max(2, Number(((load / Math.max(1, cpus.length)) * 100 + Math.random() * 2).toFixed(1))))
    }
    const diffTotal = total - this.lastCpuTotal
    const diffIdle = idle - this.lastCpuIdle
    this.lastCpuTotal = total
    this.lastCpuIdle = idle
    if (diffTotal <= 0) {
      return Number((4 + Math.random() * 4).toFixed(1))
    }
    const pct = ((diffTotal - diffIdle) / diffTotal) * 100
    return Number(Math.min(100, Math.max(0.5, pct)).toFixed(1))
  }

  private getDiskStats(): { total: number; used: number; free: number; percent: number } {
    try {
      const stats = fs.statfsSync('/')
      const total = stats.blocks * stats.bsize
      const free = stats.bavail * stats.bsize
      const used = Math.max(0, total - free)
      const percent = total > 0 ? Number(((used / total) * 100).toFixed(1)) : 0
      return { total, used, free, percent }
    } catch {
      const total = 100 * 1024 * 1024 * 1024
      const used = 34 * 1024 * 1024 * 1024
      return { total, used, free: total - used, percent: 34.0 }
    }
  }

  collectSystemMetrics() {
    const totalMem = os.totalmem()
    const freeMem = os.freemem()
    const usedMem = Math.max(0, totalMem - freeMem)
    const memPercent = totalMem > 0 ? Number(((usedMem / totalMem) * 100).toFixed(1)) : 0
    const cpuPercent = this.sampleCpuPercent()
    const disk = this.getDiskStats()
    const [load1, load5, load15] = os.loadavg()
    const uptime = Math.floor(os.uptime())

    return {
      cpu: cpuPercent,
      cpuCores: os.cpus().length || 1,
      memory: {
        total: totalMem,
        used: usedMem,
        available: freeMem,
        percent: memPercent,
      },
      disk: {
        ...disk,
        path: '/',
      },
      network: {
        bytesSent: 18432000 + Math.floor(process.uptime() * 4096),
        bytesRecv: 42950000 + Math.floor(process.uptime() * 8192),
        packetsSent: 18240,
        packetsRecv: 31900,
      },
      load: {
        load1: Number((load1 || 0).toFixed(2)),
        load5: Number((load5 || 0).toFixed(2)),
        load15: Number((load15 || 0).toFixed(2)),
      },
      uptime,
      goVersion: `Node ${process.version}`,
      platform: os.platform(),
    }
  }

  collectMonitoringSample(tsMs = Date.now()): MonitoringSample {
    const sys = this.collectSystemMetrics()
    const runningContainers = this.containers.filter((c) => c.state === 'running')

    return {
      timestamp: new Date(tsMs).toISOString(),
      cpu: { percent: sys.cpu, cores: sys.cpuCores },
      memory: sys.memory,
      disk: { total: sys.disk.total, used: sys.disk.used, free: sys.disk.free, percent: sys.disk.percent },
      network: sys.network,
      containers: runningContainers.map((c, idx) => ({
        id: c.id,
        name: c.name,
        cpuPercent: Number((0.4 + idx * 0.7 + Math.random() * 0.8).toFixed(1)),
        memoryUsage: (48 + idx * 64) * 1024 * 1024,
        memoryLimit: 1024 * 1024 * 1024,
        netIO: { rxBytes: 1200000 + idx * 450000, txBytes: 840000 + idx * 220000 },
        blockIO: { readBytes: 5120000 + idx * 1024000, writeBytes: 1280000 + idx * 512000 },
        pids: 6 + idx * 4,
      })),
    }
  }

  pushMonitoringSample() {
    const sample = this.collectMonitoringSample()
    this.monitoringHistory.push(sample)
    if (this.monitoringHistory.length > 60) {
      this.monitoringHistory = this.monitoringHistory.slice(-60)
    }
    return sample
  }

  getContainerLogs(id: string, tail = 100, filter = ''): LogLine[] {
    const container = this.containers.find((c) => c.id === id)
    const name = container?.name || id
    const baseTime = Date.now() - 60000
    const lines: LogLine[] = [
      { timestamp: new Date(baseTime).toISOString(), stream: 'stdout', content: `[${name}] starting container entrypoint` },
      { timestamp: new Date(baseTime + 5000).toISOString(), stream: 'stdout', content: `[${name}] listening on configured port` },
      { timestamp: new Date(baseTime + 15000).toISOString(), stream: 'stdout', content: `[${name}] healthcheck passed (200 OK)` },
      { timestamp: new Date(baseTime + 30000).toISOString(), stream: 'stderr', content: `[${name}] notice: telemetry buffer flushed` },
      { timestamp: new Date(baseTime + 45000).toISOString(), stream: 'stdout', content: `[${name}] worker heartbeat healthy` },
    ]
    const filtered = filter
      ? lines.filter((l) => l.content.toLowerCase().includes(filter.toLowerCase()))
      : lines
    return filtered.slice(-tail)
  }

  normalizePath(p: string): string {
    if (!p || p === '/') return '/'
    const parts = p.split('/').filter(Boolean)
    const resolved: string[] = []
    for (const part of parts) {
      if (part === '.') continue
      if (part === '..') resolved.pop()
      else resolved.push(part)
    }
    return '/' + resolved.join('/')
  }

  listDir(rawPath: string): Array<{ name: string; is_dir: boolean; size: number }> {
    const dir = this.normalizePath(rawPath)
    const prefix = dir === '/' ? '/' : dir + '/'
    const seen = new Set<string>()
    const entries: Array<{ name: string; is_dir: boolean; size: number }> = []

    for (const [key, node] of this.files.entries()) {
      if (key === dir || !key.startsWith(prefix)) continue
      const rest = key.slice(prefix.length)
      if (!rest || rest.includes('/')) continue
      if (!seen.has(rest)) {
        seen.add(rest)
        entries.push({
          name: rest,
          is_dir: node.isDir,
          size: node.isDir ? 0 : Buffer.byteLength(node.content, 'utf8'),
        })
      }
    }

    return entries.sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }

  ensureParentDirs(filePath: string) {
    const parts = this.normalizePath(filePath).split('/').filter(Boolean)
    let cur = ''
    for (let i = 0; i < parts.length - 1; i++) {
      cur += '/' + parts[i]
      if (!this.files.has(cur)) {
        this.files.set(cur, { isDir: true, content: '', updatedAt: new Date().toISOString() })
      }
    }
  }

  newId(prefix: string): string {
    return `${prefix}-${crypto.randomBytes(4).toString('hex')}`
  }
}
