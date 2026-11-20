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
  volumes?: string[]
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
  domain?: string
  port?: number
  container_id?: string
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
  filePath?: string
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
  sizeBytes: number
  createdAt: string
}

export interface RegistryCredential {
  id: string
  name: string
  registryUrl: string
  username: string
  password: string
  email?: string
  status: 'connected' | 'unverified'
  createdAt: string
  lastUsedAt?: string
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

export interface PlatformSettings {
  serverName: string
  serverDomain: string
  wildcardDomain: string
  letsEncryptEmail: string
  autoSsl: boolean
  forceHttps: boolean
  autoDeployWebhook: boolean
  pruneStoppedAfterDeploy: boolean
  defaultDeployStrategy: 'rolling' | 'recreate'
  webhookSecret: string
  cpuAlertThreshold: number
  memoryAlertThreshold: number
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
      volumes: ['pgdata:/var/lib/postgresql/data'],
      created: nowSec - 86400 * 5,
    },
    {
      id: 'c3d4e5f6a1b2',
      name: 'kathal-redis',
      image: 'redis:7-alpine',
      state: 'running',
      status: 'Up 5 days',
      ports: [{ hostPort: 6379, containerPort: 6379 }],
      volumes: ['redisdata:/data'],
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
    {
      id: 'e5f6a1b2c3d4',
      name: 'grafana-preview',
      image: 'grafana/grafana:latest',
      state: 'paused',
      status: 'Up 1 day (Paused)',
      ports: [{ hostPort: 3002, containerPort: 3000 }],
      created: nowSec - 86400,
    },
  ]

  images: ImageRecord[] = [
    { id: 'sha256:9f8e7d6c5b4a', repoTags: ['nginx:alpine'], size: 43253760, created: nowSec - 86400 * 7 },
    { id: 'sha256:8e7d6c5b4a39', repoTags: ['postgres:16-alpine'], size: 249561088, created: nowSec - 86400 * 10 },
    { id: 'sha256:7d6c5b4a3928', repoTags: ['redis:7-alpine'], size: 35651584, created: nowSec - 86400 * 14 },
    { id: 'sha256:6c5b4a392817', repoTags: ['louislam/uptime-kuma:latest'], size: 412090368, created: nowSec - 86400 * 4 },
    { id: 'sha256:5b4a39281706', repoTags: ['grafana/grafana:latest'], size: 398458880, created: nowSec - 86400 * 3 },
    { id: 'sha256:4a39281706f5', repoTags: ['node:20-alpine'], size: 134217728, created: nowSec - 86400 * 9 },
    { id: 'sha256:39281706f5e4', repoTags: ['alpine:3.19'], size: 7864320, created: nowSec - 86400 * 18 },
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
      filePath: '/data/compose/web-stack/docker-compose.yml',
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
      sizeBytes: 512 * 1024 * 1024,
      createdAt: new Date(Date.now() - 86400 * 10 * 1000).toISOString(),
    },
    {
      name: 'redisdata',
      driver: 'local',
      mountpoint: '/var/lib/docker/volumes/redisdata/_data',
      scope: 'local',
      sizeBytes: 64 * 1024 * 1024,
      createdAt: new Date(Date.now() - 86400 * 10 * 1000).toISOString(),
    },
    {
      name: 'old_app_cache',
      driver: 'local',
      mountpoint: '/var/lib/docker/volumes/old_app_cache/_data',
      scope: 'local',
      sizeBytes: 184 * 1024 * 1024,
      createdAt: new Date(Date.now() - 86400 * 18 * 1000).toISOString(),
    },
    {
      name: 'legacy_uploads',
      driver: 'local',
      mountpoint: '/var/lib/docker/volumes/legacy_uploads/_data',
      scope: 'local',
      sizeBytes: 42 * 1024 * 1024,
      createdAt: new Date(Date.now() - 86400 * 24 * 1000).toISOString(),
    },
  ]

  registries: RegistryCredential[] = [
    {
      id: 'reg-ghcr',
      name: 'GitHub Container Registry',
      registryUrl: 'ghcr.io',
      username: 'kathal-deploy',
      password: 'ghp_sampletoken1234567890',
      email: 'admin@kathal.local',
      status: 'connected',
      createdAt: new Date(Date.now() - 86400 * 6 * 1000).toISOString(),
    },
  ]

  apps = new Map<string, AppRecord>()

  containerLogs = new Map<string, LogLine[]>()

  settings: PlatformSettings = {
    serverName: 'KATHAL Primary Node',
    serverDomain: 'kathal.local',
    wildcardDomain: 'apps.kathal.local',
    letsEncryptEmail: 'admin@kathal.local',
    autoSsl: true,
    forceHttps: true,
    autoDeployWebhook: true,
    pruneStoppedAfterDeploy: false,
    defaultDeployStrategy: 'rolling',
    webhookSecret: crypto.randomBytes(16).toString('hex'),
    cpuAlertThreshold: 85,
    memoryAlertThreshold: 85,
  }

  files = new Map<string, VirtualFileNode>([
    ['/', { isDir: true, content: '', updatedAt: new Date().toISOString() }],
    ['/data', { isDir: true, content: '', updatedAt: new Date().toISOString() }],
    ['/data/stacks', { isDir: true, content: '', updatedAt: new Date().toISOString() }],
    ['/data/stacks/monitoring', { isDir: true, content: '', updatedAt: new Date().toISOString() }],
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
      '/data/stacks/monitoring/docker-compose.yml',
      {
        isDir: false,
        content:
          "version: '3.8'\nservices:\n  prometheus:\n    image: prom/prometheus:latest\n    ports:\n      - '9090:9090'\n  grafana:\n    image: grafana/grafana:latest\n    ports:\n      - '3002:3000'\n",
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
    const custom = this.containerLogs.get(id) || []
    const baseTime = Date.now() - 60000
    const defaults: LogLine[] = [
      { timestamp: new Date(baseTime).toISOString(), stream: 'stdout', content: `[${name}] starting container entrypoint` },
      { timestamp: new Date(baseTime + 5000).toISOString(), stream: 'stdout', content: `[${name}] listening on configured port` },
      { timestamp: new Date(baseTime + 15000).toISOString(), stream: 'stdout', content: `[${name}] healthcheck passed (200 OK)` },
      { timestamp: new Date(baseTime + 30000).toISOString(), stream: 'stderr', content: `[${name}] notice: telemetry buffer flushed` },
      { timestamp: new Date(baseTime + 45000).toISOString(), stream: 'stdout', content: `[${name}] worker heartbeat healthy` },
    ]
    const lines = custom.length > 0 ? custom : defaults
    const filtered = filter
      ? lines.filter((l) => l.content.toLowerCase().includes(filter.toLowerCase()))
      : lines
    return filtered.slice(-tail)
  }

  appendContainerLog(id: string, content: string, stream: 'stdout' | 'stderr' = 'stdout') {
    const list = this.containerLogs.get(id) || []
    list.push({ timestamp: new Date().toISOString(), stream, content })
    this.containerLogs.set(id, list.slice(-500))
  }

  ensureImage(imageTag: string): ImageRecord {
    const normalized = imageTag.includes(':') ? imageTag : `${imageTag}:latest`
    const existing = this.images.find((img) => img.repoTags.includes(normalized))
    if (existing) return existing
    const img: ImageRecord = {
      id: `sha256:${crypto.randomBytes(6).toString('hex')}`,
      repoTags: [normalized],
      size: (32 + Math.floor(Math.random() * 190)) * 1024 * 1024,
      created: Math.floor(Date.now() / 1000),
    }
    this.images.unshift(img)
    return img
  }

  allocateHostPort(preferredPort?: number): number {
    const used = new Set<number>()
    for (const c of this.containers) {
      for (const p of c.ports || []) {
        if (p.hostPort) used.add(p.hostPort)
      }
    }
    if (preferredPort && preferredPort > 0 && !used.has(preferredPort)) {
      return preferredPort
    }
    let candidate = preferredPort && preferredPort > 0 ? preferredPort : 8080
    while (used.has(candidate)) {
      candidate += 1
    }
    return candidate
  }

  deployService(opts: {
    name: string
    image: string
    hostPort?: number
    containerPort?: number
    domain?: string
    autoDomain?: boolean
    volumes?: string[]
    env?: string[]
    source?: string
  }) {
    const cleanName =
      opts.name
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, '-')
        .replace(/^-+|-+$/g, '') || `app-${crypto.randomBytes(2).toString('hex')}`
    const image = this.ensureImage(opts.image || 'nginx:alpine')
    const cPort = opts.containerPort || opts.hostPort || 80
    const hPort = this.allocateHostPort(opts.hostPort || cPort)

    let container = this.containers.find((c) => c.name === cleanName)
    const now = Math.floor(Date.now() / 1000)
    if (container) {
      container.image = image.repoTags[0]
      container.state = 'running'
      container.status = 'Up just now'
      container.ports = [{ hostPort: hPort, containerPort: cPort, protocol: 'tcp' }]
      if (opts.volumes?.length) container.volumes = opts.volumes
    } else {
      container = {
        id: crypto.randomBytes(6).toString('hex'),
        name: cleanName,
        image: image.repoTags[0],
        state: 'running',
        status: 'Up just now',
        ports: [{ hostPort: hPort, containerPort: cPort, protocol: 'tcp' }],
        volumes: opts.volumes?.length ? opts.volumes : undefined,
        created: now,
      }
      this.containers.unshift(container)
    }

    // Ensure requested volumes exist
    for (const volSpec of opts.volumes || []) {
      const volName = String(volSpec).split(':')[0]?.trim()
      if (volName && !volName.startsWith('/') && !this.volumes.some((v) => v.name === volName)) {
        this.volumes.push({
          name: volName,
          driver: 'local',
          mountpoint: `/var/lib/docker/volumes/${volName}/_data`,
          scope: 'local',
          sizeBytes: 12 * 1024 * 1024,
          createdAt: new Date().toISOString(),
        })
      }
    }

    // Optional auto-prune stopped containers if configured in operational settings
    let prunedCount = 0
    if (this.settings.pruneStoppedAfterDeploy) {
      const before = this.containers.length
      this.containers = this.containers.filter(
        (c) => c.id === container!.id || c.state === 'running' || c.state === 'paused'
      )
      prunedCount = before - this.containers.length
    }

    // Register AppRecord
    const appRecord: AppRecord = {
      id: cleanName,
      name: cleanName,
      image: image.repoTags[0],
      port: hPort,
      status: 'running',
      createdAt: new Date().toISOString(),
    }
    this.apps.set(cleanName, appRecord)

    // Optional Reverse Proxy route
    let proxyRoute: ProxyRoute | null = null
    const targetDomain = opts.domain?.trim()
      ? opts.domain.trim()
      : opts.autoDomain
      ? `${cleanName}.${this.settings.wildcardDomain || 'apps.kathal.local'}`
      : ''

    if (targetDomain) {
      const existingRoute = this.proxyRoutes.find((r) => r.domain === targetDomain)
      if (existingRoute) {
        existingRoute.target = `http://localhost:${hPort}`
        existingRoute.port = this.settings.autoSsl ? 443 : 80
        existingRoute.ssl = this.settings.autoSsl
        existingRoute.enabled = true
        proxyRoute = existingRoute
      } else {
        proxyRoute = {
          id: this.newId('proxy'),
          domain: targetDomain,
          target: `http://localhost:${hPort}`,
          port: this.settings.autoSsl ? 443 : 80,
          ssl: this.settings.autoSsl,
          enabled: true,
        }
        this.proxyRoutes.push(proxyRoute)
      }
    }

    // Record realistic deployment logs
    const envCount = (opts.env?.length || 0) + this.envVars.length
    const logs = [
      `[${cleanName}] Pull image ${image.repoTags[0]} (${Math.round(image.size / 1048576)} MB) — complete`,
      `[${cleanName}] Strategy: ${this.settings.defaultDeployStrategy} · Injected ${envCount} environment variable(s)`,
      `[${cleanName}] Bound port ${hPort}:${cPort}/tcp on bridge network`,
      proxyRoute
        ? `[${cleanName}] Reverse proxy active: ${proxyRoute.ssl ? 'https' : 'http'}://${proxyRoute.domain} -> ${proxyRoute.target}`
        : `[${cleanName}] Exposed directly on host port ${hPort}`,
      ...(prunedCount > 0 ? [`[${cleanName}] Auto-pruned ${prunedCount} stopped container(s)`] : []),
      `[${cleanName}] Healthcheck passed (200 OK) · Container ${container.id} running`,
    ]
    for (const line of logs) {
      this.appendContainerLog(container.id, line, 'stdout')
    }

    return { app: appRecord, container, image, proxyRoute, logs }
  }

  resetToDefaults() {
    const fresh = new MemoryStore()
    this.containers = fresh.containers
    this.images = fresh.images
    this.proxyRoutes = fresh.proxyRoutes
    this.databases = fresh.databases
    this.backups = fresh.backups
    this.gitRepos = fresh.gitRepos
    this.gitHistory = fresh.gitHistory
    this.composeProjects = fresh.composeProjects
    this.envVars = fresh.envVars
    this.networks = fresh.networks
    this.volumes = fresh.volumes
    this.registries = fresh.registries
    this.apps = fresh.apps
    this.containerLogs = fresh.containerLogs
    this.settings = fresh.settings
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
