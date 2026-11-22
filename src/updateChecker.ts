import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')

const DEFAULT_GITHUB_REPO = 'kathal-os/kathal'
const REPO_SLUG_REGEX = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const CACHE_TTL_MS = 15 * 60 * 1000
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 6000

export type VersionSource = '.env' | 'process.env' | 'package.json' | 'default'
export type GithubCheckStatus = 'ok' | 'not_found' | 'rate_limited' | 'offline' | 'error'

export interface UpdateCheckResult {
  currentVersion: string
  versionSource: VersionSource
  latestVersion: string | null
  updateAvailable: boolean
  status: 'update-available' | 'up-to-date' | 'unavailable'
  githubStatus: GithubCheckStatus
  repository: string
  releaseName: string | null
  releaseUrl: string | null
  publishedAt: string | null
  releaseNotes: string | null
  prerelease: boolean
  channel: 'stable' | 'prerelease'
  checkedAt: string
  cached: boolean
  runtime: string
  appsChecked: number
  message: string
}

interface ParsedSemver {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

function parseDotEnvContent(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eqIdx = line.indexOf('=')
    if (eqIdx <= 0) continue
    const key = line.slice(0, eqIdx).trim()
    let val = line.slice(eqIdx + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1)
    }
    if (key) result[key] = val
  }
  return result
}

function readLocalDotEnv(): Record<string, string> {
  const candidates = Array.from(
    new Set([path.resolve(process.cwd(), '.env'), path.resolve(PROJECT_ROOT, '.env')])
  )
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return parseDotEnvContent(fs.readFileSync(candidate, 'utf8'))
      }
    } catch {
      // ignore unreadable .env
    }
  }
  return {}
}

function readPackageJsonMeta(): { version: string | null; repository: string | null } {
  const candidates = Array.from(
    new Set([path.resolve(process.cwd(), 'package.json'), path.resolve(PROJECT_ROOT, 'package.json')])
  )
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as {
        version?: string
        repository?: string | { url?: string }
      }
      const version = typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version.trim() : null
      let repository: string | null = null
      const repoRaw =
        typeof parsed.repository === 'string'
          ? parsed.repository
          : typeof parsed.repository?.url === 'string'
          ? parsed.repository.url
          : ''
      const ghMatch = /github\.com[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/i.exec(repoRaw.trim())
      if (ghMatch && REPO_SLUG_REGEX.test(ghMatch[1])) {
        repository = ghMatch[1]
      }
      return { version, repository }
    } catch {
      // ignore invalid package.json
    }
  }
  return { version: null, repository: null }
}

export function normalizeVersion(raw: string): string {
  return String(raw || '')
    .trim()
    .replace(/^v/i, '')
}

export function parseSemver(raw: string): ParsedSemver | null {
  const cleaned = normalizeVersion(raw)
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(cleaned)
  if (!match) return null
  return {
    major: Number(match[1]) || 0,
    minor: Number(match[2]) || 0,
    patch: Number(match[3]) || 0,
    prerelease: match[4] ? match[4].split('.').filter(Boolean) : [],
  }
}

/**
 * Returns 1 if a > b, -1 if a < b, 0 if equal.
 */
export function compareSemver(aRaw: string, bRaw: string): number {
  const a = parseSemver(aRaw)
  const b = parseSemver(bRaw)
  if (!a || !b) {
    const na = normalizeVersion(aRaw)
    const nb = normalizeVersion(bRaw)
    if (na === nb) return 0
    return na.localeCompare(nb, undefined, { numeric: true })
  }

  if (a.major !== b.major) return a.major > b.major ? 1 : -1
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1

  // Stable version (no prerelease) is higher than prerelease
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1

  const len = Math.max(a.prerelease.length, b.prerelease.length)
  for (let i = 0; i < len; i++) {
    const pa = a.prerelease[i]
    const pb = b.prerelease[i]
    if (pa === undefined) return -1
    if (pb === undefined) return 1
    if (pa === pb) continue
    const na = /^\d+$/.test(pa) ? Number(pa) : null
    const nb = /^\d+$/.test(pb) ? Number(pb) : null
    if (na !== null && nb !== null) return na > nb ? 1 : -1
    if (na !== null) return -1
    if (nb !== null) return 1
    return pa > pb ? 1 : -1
  }
  return 0
}

export function resolveCurrentEnvVersion(): {
  version: string
  source: VersionSource
  repository: string
} {
  const dotEnv = readLocalDotEnv()
  const pkg = readPackageJsonMeta()

  let version = '0.1.0'
  let source: VersionSource = 'default'

  if (dotEnv.KATHAL_VERSION && dotEnv.KATHAL_VERSION.trim()) {
    version = normalizeVersion(dotEnv.KATHAL_VERSION)
    source = '.env'
  } else if (process.env.KATHAL_VERSION && process.env.KATHAL_VERSION.trim()) {
    version = normalizeVersion(process.env.KATHAL_VERSION)
    source = 'process.env'
  } else if (pkg.version) {
    version = normalizeVersion(pkg.version)
    source = 'package.json'
  }

  const rawRepo = (
    dotEnv.KATHAL_GITHUB_REPO ||
    process.env.KATHAL_GITHUB_REPO ||
    pkg.repository ||
    DEFAULT_GITHUB_REPO
  ).trim()
  const repository = REPO_SLUG_REGEX.test(rawRepo) ? rawRepo : DEFAULT_GITHUB_REPO

  return { version, source, repository }
}

function sanitizeGithubReleaseUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null
  try {
    const parsed = new URL(rawUrl.trim())
    if (parsed.protocol !== 'https:') return null
    if (parsed.hostname.toLowerCase() !== 'github.com') return null
    return parsed.toString()
  } catch {
    return null
  }
}

function sanitizeReleaseNotes(rawBody: unknown): string | null {
  if (typeof rawBody !== 'string' || !rawBody.trim()) return null
  const compact = rawBody
    .replace(/\r\n/g, '\n')
    .replace(/[#*`>]/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim()
  return compact.length > 360 ? `${compact.slice(0, 357)}...` : compact
}

interface GithubReleasePayload {
  tag_name?: string
  name?: string
  html_url?: string
  published_at?: string
  body?: string
  prerelease?: boolean
  draft?: boolean
}

function fetchGithubJson(
  apiPath: string,
  userAgent: string
): Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        hostname: 'api.github.com',
        port: 443,
        path: apiPath,
        method: 'GET',
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': userAgent,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        let total = 0
        res.on('data', (chunk: Buffer) => {
          total += chunk.length
          if (total <= 1024 * 1024) {
            chunks.push(chunk)
          }
        })
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let body: unknown = null
          try {
            body = text ? JSON.parse(text) : null
          } catch {
            body = null
          }
          resolve({ statusCode: res.statusCode || 0, headers: res.headers, body })
        })
      }
    )

    req.on('timeout', () => {
      req.destroy(new Error('GitHub Releases API request timed out'))
    })
    req.on('error', (err) => reject(err))
  })
}

export class UpdateChecker {
  private cached: { expiresAt: number; result: UpdateCheckResult } | null = null
  private inFlight: Promise<UpdateCheckResult> | null = null
  private autoTimer: ReturnType<typeof setInterval> | null = null

  getCachedResult(): UpdateCheckResult | null {
    return this.cached ? this.cached.result : null
  }

  startAutoCheck(intervalMs = AUTO_CHECK_INTERVAL_MS) {
    if (this.autoTimer) return
    const safeInterval = Math.max(60_000, intervalMs)
    this.autoTimer = setInterval(() => {
      this.checkForUpdates({ force: true }).catch(() => {
        // Ignore periodic offline check errors
      })
    }, safeInterval)
    this.autoTimer.unref()
  }

  stopAutoCheck() {
    if (this.autoTimer) {
      clearInterval(this.autoTimer)
      this.autoTimer = null
    }
  }

  async checkForUpdates(options?: {
    force?: boolean
    appsChecked?: number
    repo?: string
  }): Promise<UpdateCheckResult> {
    const envMeta = resolveCurrentEnvVersion()
    const requestedRepo =
      typeof options?.repo === 'string' && REPO_SLUG_REGEX.test(options.repo.trim())
        ? options.repo.trim()
        : envMeta.repository
    const appsChecked = options?.appsChecked ?? 0

    if (
      !options?.force &&
      this.cached &&
      Date.now() < this.cached.expiresAt &&
      this.cached.result.currentVersion === envMeta.version &&
      this.cached.result.repository === requestedRepo
    ) {
      return {
        ...this.cached.result,
        appsChecked,
        cached: true,
      }
    }

    if (this.inFlight && !options?.force) {
      return this.inFlight
    }

    const job = this.performGithubCheck(envMeta.version, envMeta.source, requestedRepo, appsChecked)
    this.inFlight = job
    try {
      const result = await job
      this.cached = {
        expiresAt: Date.now() + CACHE_TTL_MS,
        result,
      }
      return result
    } finally {
      if (this.inFlight === job) {
        this.inFlight = null
      }
    }
  }

  private async performGithubCheck(
    currentVersion: string,
    versionSource: VersionSource,
    repository: string,
    appsChecked: number
  ): Promise<UpdateCheckResult> {
    const checkedAt = new Date().toISOString()
    const ua = `KATHAL-OS/${currentVersion}`
    const baseResult: Omit<
      UpdateCheckResult,
      | 'latestVersion'
      | 'updateAvailable'
      | 'status'
      | 'githubStatus'
      | 'releaseName'
      | 'releaseUrl'
      | 'publishedAt'
      | 'releaseNotes'
      | 'prerelease'
      | 'channel'
      | 'message'
    > = {
      currentVersion,
      versionSource,
      repository,
      checkedAt,
      cached: false,
      runtime: `Node ${process.version}`,
      appsChecked,
    }

    try {
      const latestResp = await fetchGithubJson(`/repos/${repository}/releases/latest`, ua)
      let release: GithubReleasePayload | null = null
      let finalStatusCode = latestResp.statusCode

      if (latestResp.statusCode === 200 && latestResp.body && typeof latestResp.body === 'object') {
        release = latestResp.body as GithubReleasePayload
      } else if (latestResp.statusCode === 404) {
        // Fallback to list releases (in case only prereleases exist or repo has no releases yet)
        const listResp = await fetchGithubJson(`/repos/${repository}/releases?per_page=1`, ua)
        finalStatusCode = listResp.statusCode
        if (listResp.statusCode === 200 && Array.isArray(listResp.body) && listResp.body.length > 0) {
          const candidate = listResp.body[0] as GithubReleasePayload
          if (candidate && !candidate.draft) {
            release = candidate
          }
        }
      }

      if (release && release.tag_name) {
        const latestVersion = normalizeVersion(release.tag_name)
        const updateAvailable = compareSemver(latestVersion, currentVersion) > 0
        const releaseUrl = sanitizeGithubReleaseUrl(release.html_url)
        const prerelease = Boolean(release.prerelease)
        return {
          ...baseResult,
          latestVersion,
          updateAvailable,
          status: updateAvailable ? 'update-available' : 'up-to-date',
          githubStatus: 'ok',
          releaseName: typeof release.name === 'string' && release.name.trim() ? release.name.trim() : `v${latestVersion}`,
          releaseUrl,
          publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
          releaseNotes: sanitizeReleaseNotes(release.body),
          prerelease,
          channel: prerelease ? 'prerelease' : 'stable',
          message: updateAvailable
            ? `New version v${latestVersion} is available on GitHub (running v${currentVersion} from ${versionSource}).`
            : `KATHAL OS v${currentVersion} (${versionSource}) matches the latest GitHub release (v${latestVersion}).`,
        }
      }

      if (finalStatusCode === 403 || finalStatusCode === 429) {
        return {
          ...baseResult,
          latestVersion: null,
          updateAvailable: false,
          status: 'unavailable',
          githubStatus: 'rate_limited',
          releaseName: null,
          releaseUrl: null,
          publishedAt: null,
          releaseNotes: null,
          prerelease: false,
          channel: 'stable',
          message: `GitHub Releases API rate limit reached for ${repository}. Running v${currentVersion} (${versionSource}).`,
        }
      }

      if (finalStatusCode === 404) {
        return {
          ...baseResult,
          latestVersion: null,
          updateAvailable: false,
          status: 'unavailable',
          githubStatus: 'not_found',
          releaseName: null,
          releaseUrl: null,
          publishedAt: null,
          releaseNotes: null,
          prerelease: false,
          channel: 'stable',
          message: `No published GitHub releases found for ${repository}. Running local v${currentVersion} (${versionSource}).`,
        }
      }

      return {
        ...baseResult,
        latestVersion: null,
        updateAvailable: false,
        status: 'unavailable',
        githubStatus: 'error',
        releaseName: null,
        releaseUrl: null,
        publishedAt: null,
        releaseNotes: null,
        prerelease: false,
        channel: 'stable',
        message: `GitHub Releases API returned HTTP ${finalStatusCode} for ${repository}. Running v${currentVersion}.`,
      }
    } catch (err) {
      return {
        ...baseResult,
        latestVersion: null,
        updateAvailable: false,
        status: 'unavailable',
        githubStatus: 'offline',
        releaseName: null,
        releaseUrl: null,
        publishedAt: null,
        releaseNotes: null,
        prerelease: false,
        channel: 'stable',
        message: `Could not reach GitHub Releases API (${(err as Error).message}). Running v${currentVersion} (${versionSource}).`,
      }
    }
  }
}
