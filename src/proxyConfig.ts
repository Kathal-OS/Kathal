import fs from 'node:fs'
import path from 'node:path'
import type { ProxyRoute, PlatformSettings } from './store.ts'
import { isValidDomainName, validateLocalProxyTarget } from './localRuntime.ts'
import { getDataDir } from './platform.ts'

export interface PersistedProxyRoute extends ProxyRoute {
  targetHost?: string
  localPort?: number
}

export interface PersistedProxyConfig {
  version: number
  updatedAt: string
  settings: {
    serverDomain: string
    wildcardDomain: string
    letsEncryptEmail: string
    autoSsl: boolean
    forceHttps: boolean
  }
  routes: PersistedProxyRoute[]
}

const DEFAULT_CONFIG_PATH = path.resolve(
  process.env.KATHAL_PROXY_CONFIG_FILE || path.join(getDataDir(), 'reverse-proxy.json')
)

export class ProxyConfigManager {
  readonly filePath: string
  private lastMtimeMs = 0
  private cachedRoutes: PersistedProxyRoute[] = []

  constructor(filePath = DEFAULT_CONFIG_PATH) {
    this.filePath = path.resolve(filePath)
  }

  private ensureDir() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
  }

  loadFromDisk(): PersistedProxyConfig | null {
    try {
      if (!fs.existsSync(this.filePath)) return null
      const stat = fs.statSync(this.filePath)
      const raw = fs.readFileSync(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<PersistedProxyConfig>
      const routes: PersistedProxyRoute[] = []

      if (Array.isArray(parsed.routes)) {
        for (const r of parsed.routes) {
          const domain = String(r?.domain || '').trim().toLowerCase()
          if (!domain || !isValidDomainName(domain)) continue
          let target = String(r?.target || '').trim()
          if (!target && r?.localPort) {
            const host = r.targetHost === 'localhost' ? 'localhost' : '127.0.0.1'
            target = `http://${host}:${Number(r.localPort)}`
          }
          const check = validateLocalProxyTarget(target)
          if (!check.ok) continue
          const host = check.url.hostname.toLowerCase()
          const localPort = Number(check.url.port)
          routes.push({
            id: String(r?.id || `proxy-${domain.replace(/[^a-z0-9]/g, '')}`),
            domain,
            target: `http://${host}:${localPort}`,
            targetHost: host,
            localPort,
            port: Number(r?.port) || (r?.ssl ? 443 : 80),
            ssl: Boolean(r?.ssl),
            enabled: r?.enabled !== undefined ? Boolean(r.enabled) : true,
          })
        }
      }

      this.cachedRoutes = routes
      this.lastMtimeMs = stat.mtimeMs

      return {
        version: Number(parsed.version) || 1,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : stat.mtime.toISOString(),
        settings: {
          serverDomain: String(parsed.settings?.serverDomain || 'kathal.local'),
          wildcardDomain: String(parsed.settings?.wildcardDomain || 'apps.kathal.local'),
          letsEncryptEmail: String(parsed.settings?.letsEncryptEmail || 'admin@kathal.local'),
          autoSsl: parsed.settings?.autoSsl !== undefined ? Boolean(parsed.settings.autoSsl) : true,
          forceHttps: parsed.settings?.forceHttps !== undefined ? Boolean(parsed.settings.forceHttps) : true,
        },
        routes,
      }
    } catch {
      return null
    }
  }

  saveToDisk(routes: ProxyRoute[], settings: PlatformSettings): PersistedProxyConfig {
    this.ensureDir()
    const normalizedRoutes: PersistedProxyRoute[] = routes.map((r) => {
      let targetHost = '127.0.0.1'
      let localPort = 8080
      try {
        const u = new URL(r.target)
        targetHost = u.hostname.toLowerCase() === 'localhost' ? 'localhost' : '127.0.0.1'
        localPort = Number(u.port) || localPort
      } catch {
        // keep defaults
      }
      return {
        id: r.id,
        domain: r.domain.trim().toLowerCase(),
        target: r.target,
        targetHost,
        localPort,
        port: r.port,
        ssl: Boolean(r.ssl),
        enabled: Boolean(r.enabled),
      }
    })

    const payload: PersistedProxyConfig = {
      version: 1,
      updatedAt: new Date().toISOString(),
      settings: {
        serverDomain: settings.serverDomain,
        wildcardDomain: settings.wildcardDomain,
        letsEncryptEmail: settings.letsEncryptEmail,
        autoSsl: settings.autoSsl,
        forceHttps: settings.forceHttps,
      },
      routes: normalizedRoutes,
    }

    const tmpPath = `${this.filePath}.tmp`
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + '\n', 'utf8')
    fs.renameSync(tmpPath, this.filePath)

    try {
      this.lastMtimeMs = fs.statSync(this.filePath).mtimeMs
    } catch {
      this.lastMtimeMs = Date.now()
    }
    this.cachedRoutes = normalizedRoutes
    return payload
  }

  /**
   * Returns active reverse proxy routes backed by the JSON config file on disk,
   * automatically hot-reloading if the JSON file changed externally.
   */
  getRoutesForInternalProxy(fallbackRoutes: ProxyRoute[]): ProxyRoute[] {
    try {
      if (fs.existsSync(this.filePath)) {
        const stat = fs.statSync(this.filePath)
        if (stat.mtimeMs !== this.lastMtimeMs) {
          const loaded = this.loadFromDisk()
          if (loaded) return loaded.routes
        }
        if (this.cachedRoutes.length > 0 || fallbackRoutes.length === 0) {
          return this.cachedRoutes
        }
      }
    } catch {
      // fall through to in-memory routes
    }
    return fallbackRoutes
  }

  readRawJson(routes: ProxyRoute[], settings: PlatformSettings): string {
    if (fs.existsSync(this.filePath)) {
      try {
        return fs.readFileSync(this.filePath, 'utf8')
      } catch {
        // fall through
      }
    }
    const saved = this.saveToDisk(routes, settings)
    return JSON.stringify(saved, null, 2)
  }
}
