import net from 'node:net'
import path from 'node:path'

const RESERVED_ENV_KEYS = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'NODE_OPTIONS',
  'PYTHONPATH',
  'PATH',
  'HOME',
])

const PRIVATE_OR_LOCAL_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.goog',
])

export function slugifyAppName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

export function isValidSlugOrAppName(raw: string): boolean {
  return /^[a-z0-9][a-z0-9-_]{1,62}$/i.test(raw.trim())
}

export function isValidEnvKey(key: string): { ok: boolean; error?: string } {
  const trimmed = key.trim()
  if (!trimmed) return { ok: false, error: 'Environment variable key is required' }
  if (trimmed.length > 128) return { ok: false, error: 'Environment variable key exceeds 128 characters' }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    return {
      ok: false,
      error: 'Key must match ^[A-Za-z_][A-Za-z0-9_]*$ (alphanumeric and underscores only)',
    }
  }
  if (RESERVED_ENV_KEYS.has(trimmed.toUpperCase())) {
    return {
      ok: false,
      error: `Environment key "${trimmed}" is reserved for host process isolation`,
    }
  }
  return { ok: true }
}

export function isValidPort(port: unknown): boolean {
  const n = Number(port)
  return Number.isInteger(n) && n >= 1 && n <= 65535
}

export function isValidUnprivilegedPort(port: unknown): boolean {
  const n = Number(port)
  return Number.isInteger(n) && n >= 1024 && n <= 65535
}

export function isValidDomain(raw: string): boolean {
  const domain = raw.trim().toLowerCase()
  if (!domain || domain.length > 253) return false
  if (domain.includes('..') || domain.startsWith('.') || domain.endsWith('.')) return false
  // Allow *.example.com wildcard or standard hostname labels (must include a dot unless explicitly local)
  const labels = domain.split('.')
  if (labels.length < 2) return false
  return labels.every((lbl, idx) => {
    if (idx === 0 && lbl === '*') return true
    return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(lbl)
  })
}

export function isPrivateOrMetadataIp(host: string): boolean {
  const clean = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!clean) return true
  if (PRIVATE_OR_LOCAL_HOSTS.has(clean)) return true
  const mapped = clean.startsWith('::ffff:') ? clean.slice(7) : clean
  const ipVer = net.isIP(mapped)
  if (ipVer === 4) {
    const parts = mapped.split('.').map(Number)
    const [a, b] = parts
    if (a === 127 || a === 10 || a === 0) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    return false
  }
  if (ipVer === 6) {
    if (mapped === '::1' || mapped === '::') return true
    if (mapped.startsWith('fe80:') || mapped.startsWith('fc') || mapped.startsWith('fd')) return true
    return false
  }
  return false
}

export function validateGitRepositoryUrl(
  rawUrl: string,
  options: { allowLocalPath?: boolean; allowPrivateHosts?: boolean } = {}
): { ok: boolean; sanitizedUrl: string; error?: string; isLocalPath?: boolean } {
  const trimmed = rawUrl.trim()
  if (!trimmed) return { ok: false, sanitizedUrl: '', error: 'Repository URL is required' }
  if (/[\r\n\0]/.test(trimmed)) {
    return { ok: false, sanitizedUrl: '', error: 'Repository URL contains invalid control characters' }
  }

  // Controlled local bare repo path support (explicit opt-in for local host / integration testing)
  if (trimmed.startsWith('file://') || path.isAbsolute(trimmed)) {
    if (!options.allowLocalPath) {
      return {
        ok: false,
        sanitizedUrl: '',
        error: 'Local filesystem Git paths are disabled unless explicitly allowed',
      }
    }
    const localPath = trimmed.startsWith('file://') ? decodeURIComponent(new URL(trimmed).pathname) : trimmed
    return { ok: true, sanitizedUrl: path.resolve(localPath), isLocalPath: true }
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, sanitizedUrl: '', error: 'Invalid Git repository URL format' }
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, sanitizedUrl: '', error: 'Only https:// (or explicit http://) Git URLs are supported' }
  }
  if (parsed.protocol === 'http:' && !options.allowPrivateHosts) {
    return { ok: false, sanitizedUrl: '', error: 'Git repository URL must use https://' }
  }

  if (parsed.username || parsed.password) {
    // Strip embedded credentials from persisted URL; tokens must live in encrypted Vault source credentials
    parsed.username = ''
    parsed.password = ''
  }

  if (!options.allowPrivateHosts && isPrivateOrMetadataIp(parsed.hostname)) {
    return {
      ok: false,
      sanitizedUrl: '',
      error: `Blocked private or metadata Git host "${parsed.hostname}"`,
    }
  }

  return { ok: true, sanitizedUrl: parsed.toString() }
}

export function isValidGitBranchOrRef(raw: string): boolean {
  const s = raw.trim()
  if (!s || s.length > 128) return false
  if (s.startsWith('-') || s.includes('..') || s.includes('@{') || /[\s~^:?*[\\\0]/.test(s)) return false
  return /^[a-zA-Z0-9._/-]+$/.test(s)
}

export function isValidDockerImageRef(raw: string): boolean {
  const s = raw.trim()
  if (!s || s.length > 255) return false
  return /^[a-zA-Z0-9][a-zA-Z0-9._/:-]*(@sha256:[a-fA-F0-9]{64})?$/.test(s)
}

export function assertPathWithinBase(baseDir: string, targetPath: string): string {
  const resolvedBase = path.resolve(baseDir)
  const resolvedTarget = path.resolve(resolvedBase, targetPath)
  if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(resolvedBase + path.sep)) {
    throw new Error(`Path traversal rejected: "${targetPath}" escapes base directory`)
  }
  return resolvedTarget
}

export function redactSecretsInText(input: string, extraSecrets: string[] = []): string {
  let out = input
  for (const s of extraSecrets) {
    if (s && s.length >= 4) {
      out = out.split(s).join('[REDACTED]')
    }
  }
  out = out.replace(/(https?:\/\/)([^:@/\s]+):([^@/\s]+)@/gi, '$1[REDACTED]:[REDACTED]@')
  out = out.replace(/\b(ghp_|gho_|glpat-|kat_|xoxb-|sk-[a-zA-Z0-9]{10,})[a-zA-Z0-9_-]*/g, '$1[REDACTED]')
  out = out.replace(/((?:password|token|secret|api[_-]?key)\s*[:=]\s*)(['"]?)[^\s'"]+\2/gi, '$1[REDACTED]')
  return out
}
