import crypto from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import type { AuthContext, AuthService, PublicUser } from '../auth/authService.ts'
import type { AuditService } from '../audit/auditService.ts'
import { getRuntimeConfig } from '../config/runtimeConfig.ts'

export const SESSION_COOKIE_NAME = 'kathal_session'

export interface AuthedRequest extends Request {
  requestId?: string
  rawBody?: Buffer
  auth?: AuthContext
  user?: PublicUser & { role?: string }
}

const PUBLIC_API_PATHS = new Set([
  '/login',
  '/auth/login',
  '/health',
  '/auth/status',
  '/auth/setup',
  '/auth/register',
  '/auth/password-reset/confirm',
  '/fleet/agent/heartbeat',
])

export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    const k = part.slice(0, idx).trim()
    const v = part.slice(idx + 1).trim()
    try {
      out[k] = decodeURIComponent(v)
    } catch {
      out[k] = v
    }
  }
  return out
}

export function isRequestHttps(req: Request): boolean {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').toLowerCase()
  return proto === 'https'
}

export function buildSessionCookieHeader(req: Request, token: string, maxAgeSeconds: number): string {
  const cfg = getRuntimeConfig()
  const isHttps = isRequestHttps(req) || cfg.cookieSecure
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ]
  if (isHttps) {
    parts.push('Secure', 'SameSite=None', 'Partitioned')
  } else {
    parts.push('SameSite=Lax')
  }
  return parts.join('; ')
}

export function buildClearSessionCookieHeader(req: Request): string {
  return buildSessionCookieHeader(req, '', 0)
}

export function requestContextMiddleware(req: AuthedRequest, res: Response, next: NextFunction): void {
  const incomingId = String(req.headers['x-request-id'] || '').trim()
  req.requestId = incomingId && /^[a-zA-Z0-9._-]{4,64}$/.test(incomingId)
    ? incomingId
    : `req-${crypto.randomBytes(6).toString('hex')}`
  res.setHeader('X-Request-Id', req.requestId)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  res.setHeader('X-DNS-Prefetch-Control', 'off')
  next()
}

function verifyCookieCsrf(req: Request): boolean {
  const method = req.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true

  if (req.headers['x-requested-with']) return true

  const expectedHost = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0]
    .trim()
    .toLowerCase()
  const origin = String(req.headers.origin || '').trim()
  if (origin) {
    try {
      const originHost = new URL(origin).host.toLowerCase()
      return Boolean(expectedHost && originHost === expectedHost)
    } catch {
      return false
    }
  }
  const referer = String(req.headers.referer || '').trim()
  if (referer) {
    try {
      const refHost = new URL(referer).host.toLowerCase()
      return Boolean(expectedHost && refHost === expectedHost)
    } catch {
      return false
    }
  }
  return false
}

export function createAuthMiddleware(authService: AuthService) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    if (PUBLIC_API_PATHS.has(req.path)) {
      next()
      return
    }

    const isWebhookPath = req.path === '/git/webhook' || req.path.startsWith('/webhooks/git/')
    const authHeader = String(req.headers.authorization || '')
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''

    if (bearerToken) {
      const ctx = authService.verifySessionToken(bearerToken, 'bearer')
      if (!ctx) {
        res.status(401).json({ error: 'invalid token' })
        return
      }
      req.auth = ctx
      req.user = { ...ctx.user, role: ctx.user.roles[0] || 'Viewer' }
      next()
      return
    }

    const cookies = parseCookieHeader(req.headers.cookie)
    const cookieToken = cookies[SESSION_COOKIE_NAME] || ''
    if (cookieToken) {
      const ctx = authService.verifySessionToken(cookieToken, 'cookie')
      if (!ctx) {
        res.status(401).json({ error: 'invalid token' })
        return
      }
      if (!verifyCookieCsrf(req)) {
        res.status(403).json({ error: 'CSRF origin check failed for cookie-authenticated request' })
        return
      }
      req.auth = ctx
      req.user = { ...ctx.user, role: ctx.user.roles[0] || 'Viewer' }
      next()
      return
    }

    if (isWebhookPath) {
      // Delegated strictly to HMAC / webhookSecret signature verification in handler
      next()
      return
    }

    res.status(401).json({ error: 'unauthorized' })
  }
}

export function requirePermission(permission: string, audit?: AuditService) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    const auth = req.auth
    if (!auth) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }
    if (!auth.user.permissions.includes(permission)) {
      audit?.record({
        userId: auth.user.id,
        actor: auth.user.email,
        action: 'rbac.denied',
        resourceType: 'permission',
        resourceId: permission,
        outcome: 'denied',
        ip: req.ip || req.socket?.remoteAddress || '127.0.0.1',
        correlationId: req.requestId || '',
        detail: `${req.method} ${req.originalUrl}`,
      })
      res.status(403).json({
        error: `Forbidden: missing required permission "${permission}"`,
        requiredPermission: permission,
      })
      return
    }
    next()
  }
}

export function createSimpleRateLimiter(maxRequests: number, windowMs: number) {
  const buckets = new Map<string, { count: number; resetAt: number }>()
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip || req.socket?.remoteAddress || 'unknown'
    const now = Date.now()
    const current = buckets.get(key)
    if (!current || current.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs })
      next()
      return
    }
    current.count += 1
    if (current.count > maxRequests) {
      res.status(429).json({ error: 'Rate limit exceeded. Please wait and try again.' })
      return
    }
    next()
  }
}
