import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { getDataDir } from '../../platform.ts'
import type { ProxyAdapterMode } from '../../types/phase2.ts'
import { isValidDomain } from '../../validation/validators.ts'

const execFileAsync = promisify(execFile)

export interface ProxyAdapterSiteInput {
  domain: string
  target: string
  ssl: boolean
  forceHttps: boolean
  certPemPath?: string
  keyPemPath?: string
  acmeWebroot?: string
}

export interface ProxyValidationResult {
  adapter: ProxyAdapterMode
  binaryAvailable: boolean
  validated: boolean
  configPath: string | null
  error: string | null
  generatedConfig: string
}

export class ProxyAdapter {
  private baseDir: string

  constructor(baseDir?: string) {
    this.baseDir = baseDir || path.join(getDataDir(), 'proxy')
  }

  async detectAvailableAdapters(): Promise<{
    builtin: true
    nginx: { available: boolean; path: string | null }
    caddy: { available: boolean; path: string | null }
  }> {
    const checkBin = async (candidates: string[]): Promise<{ available: boolean; path: string | null }> => {
      for (const bin of candidates) {
        try {
          await execFileAsync(bin, ['-v'], { shell: false, timeout: 3_000 })
          return { available: true, path: bin }
        } catch (err) {
          const e = err as { stderr?: string; stdout?: string; code?: string | number }
          // nginx -v writes to stderr and exits 0, or if found returns non-ENOENT
          if (e && e.code !== 'ENOENT' && (e.stderr || e.stdout)) {
            return { available: true, path: bin }
          }
        }
      }
      return { available: false, path: null }
    }

    const [nginx, caddy] = await Promise.all([
      checkBin(['nginx', '/usr/sbin/nginx', '/sbin/nginx']),
      checkBin(['caddy', '/usr/bin/caddy', '/usr/local/bin/caddy']),
    ])
    return { builtin: true, nginx, caddy }
  }

  renderNginxSiteConfig(site: ProxyAdapterSiteInput): string {
    if (!isValidDomain(site.domain)) {
      throw new Error(`Invalid domain "${site.domain}"`)
    }
    const safeDomain = site.domain.trim().toLowerCase()
    const webroot = site.acmeWebroot || path.join(this.baseDir, 'acme-webroot')
    const lines: string[] = [
      `# Managed by KATHAL OS ProxyAdapter`,
      `server {`,
      `    listen 80;`,
      `    server_name ${safeDomain};`,
      `    location ^~ /.well-known/acme-challenge/ {`,
      `        root ${webroot};`,
      `        default_type text/plain;`,
      `    }`,
    ]
    if (site.ssl && site.forceHttps && site.certPemPath && site.keyPemPath) {
      lines.push(
        `    location / { return 301 https://$host$request_uri; }`,
        `}`,
        `server {`,
        `    listen 443 ssl;`,
        `    server_name ${safeDomain};`,
        `    ssl_certificate ${site.certPemPath};`,
        `    ssl_certificate_key ${site.keyPemPath};`,
        `    ssl_protocols TLSv1.2 TLSv1.3;`,
        `    location / {`,
        `        proxy_pass ${site.target};`,
        `        proxy_http_version 1.1;`,
        `        proxy_set_header Host $host;`,
        `        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`,
        `        proxy_set_header X-Forwarded-Proto $scheme;`,
        `        proxy_set_header Upgrade $http_upgrade;`,
        `        proxy_set_header Connection "upgrade";`,
        `    }`,
        `}`
      )
    } else {
      lines.push(
        `    location / {`,
        `        proxy_pass ${site.target};`,
        `        proxy_http_version 1.1;`,
        `        proxy_set_header Host $host;`,
        `        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`,
        `        proxy_set_header X-Forwarded-Proto $scheme;`,
        `        proxy_set_header Upgrade $http_upgrade;`,
        `        proxy_set_header Connection "upgrade";`,
        `    }`,
        `}`
      )
    }
    return lines.join('\n') + '\n'
  }

  renderCaddyfile(sites: ProxyAdapterSiteInput[]): string {
    const blocks: string[] = ['# Managed by KATHAL OS ProxyAdapter']
    for (const s of sites) {
      if (!isValidDomain(s.domain)) continue
      const addr = s.ssl ? s.domain.toLowerCase() : `http://${s.domain.toLowerCase()}`
      blocks.push(`${addr} {`)
      if (s.ssl && s.certPemPath && s.keyPemPath) {
        blocks.push(`    tls ${s.certPemPath} ${s.keyPemPath}`)
      }
      blocks.push(`    reverse_proxy ${s.target}`)
      blocks.push(`}`)
    }
    return blocks.join('\n') + '\n'
  }

  /**
   * Generates, atomically writes, and validates proxy config for nginx or caddy.
   * Rolls back to the previous config file if validation fails.
   */
  async syncAndValidate(
    adapter: ProxyAdapterMode,
    sites: ProxyAdapterSiteInput[]
  ): Promise<ProxyValidationResult> {
    if (adapter === 'builtin') {
      return {
        adapter: 'builtin',
        binaryAvailable: true,
        validated: true,
        configPath: null,
        error: null,
        generatedConfig: '# Active in KATHAL Built-in Reverse Proxy Router',
      }
    }

    const bins = await this.detectAvailableAdapters()
    if (adapter === 'nginx') {
      const nginxDir = path.join(this.baseDir, 'nginx')
      fs.mkdirSync(nginxDir, { recursive: true })
      const sitesConf = sites.map((s) => this.renderNginxSiteConfig(s)).join('\n')
      // Build a self-contained validation config wrapping events + http block so `nginx -t -c` works cleanly
      const mainConfPath = path.join(nginxDir, 'kathal-test.conf')
      const sitesPath = path.join(nginxDir, 'sites.conf')
      const prevContent = fs.existsSync(sitesPath) ? fs.readFileSync(sitesPath, 'utf8') : null

      const pidPath = path.join(nginxDir, 'nginx-test.pid')
      const errLogPath = path.join(nginxDir, 'nginx-test-err.log')
      const wrapper = [
        `pid ${pidPath};`,
        `error_log ${errLogPath} warn;`,
        `events { worker_connections 256; }`,
        `http {`,
        `    access_log off;`,
        `    client_body_temp_path ${path.join(nginxDir, 'tmp_body')};`,
        `    proxy_temp_path ${path.join(nginxDir, 'tmp_proxy')};`,
        `    fastcgi_temp_path ${path.join(nginxDir, 'tmp_fcgi')};`,
        `    uwsgi_temp_path ${path.join(nginxDir, 'tmp_uwsgi')};`,
        `    scgi_temp_path ${path.join(nginxDir, 'tmp_scgi')};`,
        `    include ${sitesPath};`,
        `}`,
      ].join('\n') + '\n'

      fs.writeFileSync(sitesPath, sitesConf, 'utf8')
      fs.writeFileSync(mainConfPath, wrapper, 'utf8')

      if (!bins.nginx.available || !bins.nginx.path) {
        return {
          adapter: 'nginx',
          binaryAvailable: false,
          validated: false,
          configPath: sitesPath,
          error: 'nginx binary not installed on host; configuration written but syntax check skipped',
          generatedConfig: sitesConf,
        }
      }

      try {
        await execFileAsync(bins.nginx.path, ['-t', '-c', mainConfPath], {
          shell: false,
          timeout: 8_000,
        })
        return {
          adapter: 'nginx',
          binaryAvailable: true,
          validated: true,
          configPath: sitesPath,
          error: null,
          generatedConfig: sitesConf,
        }
      } catch (err) {
        // Atomic rollback to prior known-good config
        if (prevContent !== null) {
          fs.writeFileSync(sitesPath, prevContent, 'utf8')
        }
        return {
          adapter: 'nginx',
          binaryAvailable: true,
          validated: false,
          configPath: sitesPath,
          error: (err as Error).message || 'nginx -t validation failed (rolled back)',
          generatedConfig: sitesConf,
        }
      }
    }

    // Caddy
    const caddyDir = path.join(this.baseDir, 'caddy')
    fs.mkdirSync(caddyDir, { recursive: true })
    const caddyPath = path.join(caddyDir, 'Caddyfile')
    const prev = fs.existsSync(caddyPath) ? fs.readFileSync(caddyPath, 'utf8') : null
    const content = this.renderCaddyfile(sites)
    fs.writeFileSync(caddyPath, content, 'utf8')

    if (!bins.caddy.available || !bins.caddy.path) {
      return {
        adapter: 'caddy',
        binaryAvailable: false,
        validated: false,
        configPath: caddyPath,
        error: 'caddy binary not installed on host; Caddyfile generated without runtime validation',
        generatedConfig: content,
      }
    }

    try {
      await execFileAsync(bins.caddy.path, ['validate', '--config', caddyPath, '--adapter', 'caddyfile'], {
        shell: false,
        timeout: 8_000,
      })
      return {
        adapter: 'caddy',
        binaryAvailable: true,
        validated: true,
        configPath: caddyPath,
        error: null,
        generatedConfig: content,
      }
    } catch (err) {
      if (prev !== null) fs.writeFileSync(caddyPath, prev, 'utf8')
      return {
        adapter: 'caddy',
        binaryAvailable: true,
        validated: false,
        configPath: caddyPath,
        error: (err as Error).message || 'caddy validate failed (rolled back)',
        generatedConfig: content,
      }
    }
  }
}
