import crypto from 'node:crypto'
import type http from 'node:http'
import type { WebSocket, WebSocketServer } from 'ws'
import type { AuthService } from '../auth/authService.ts'
import type { AuditService } from '../audit/auditService.ts'
import { safeEqualStrings } from '../security/password.ts'

interface TerminalSessionRecord {
  id: string
  userId: string
  authSessionId: string
  email: string
  cols: number
  rows: number
  cwd: string
  createdAt: string
}

interface TerminalTicketRecord {
  ticket: string
  sessionId: string
  userId: string
  authSessionId: string
  email: string
  expiresAt: number
}

const TERMINAL_TICKET_TTL_MS = 60_000
const MAX_WS_CONNECTIONS_PER_USER = 5

export class TerminalGateway {
  private sessions = new Map<string, TerminalSessionRecord>()
  private tickets = new Map<string, TerminalTicketRecord>()
  private activeSocketsByAuthSession = new Map<string, Set<WebSocket>>()
  private activeSocketsByUser = new Map<string, Set<WebSocket>>()
  private authService: AuthService
  private audit: AuditService
  private onAttachSession: (ws: WebSocket, sessionId: string, cwd: string, updateCwd: (next: string) => void) => void

  constructor(
    authService: AuthService,
    audit: AuditService,
    onAttachSession: (ws: WebSocket, sessionId: string, cwd: string, updateCwd: (next: string) => void) => void
  ) {
    this.authService = authService
    this.audit = audit
    this.onAttachSession = onAttachSession

    // Close open terminal sockets immediately when a user's session is revoked
    this.authService.onSessionsRevoked((revokedSessionIds) => {
      for (const sid of revokedSessionIds) {
        this.closeSocketsForAuthSession(sid, 'Authentication session revoked')
      }
    })
  }

  private pruneExpiredTickets(): void {
    const now = Date.now()
    for (const [k, item] of this.tickets.entries()) {
      if (item.expiresAt <= now) {
        this.tickets.delete(k)
      }
    }
  }

  createSession(params: {
    id?: string
    cols?: number
    rows?: number
    userId: string
    authSessionId: string
    email: string
    ip: string
    correlationId: string
  }): { id: string; cols: number; rows: number; cwd: string; wsTicket: string; ticketExpiresAt: number } {
    this.pruneExpiredTickets()
    const id = params.id || `term-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
    const cols = Number(params.cols) || 120
    const rows = Number(params.rows) || 30

    const existing = this.sessions.get(id)
    if (existing && existing.userId !== params.userId) {
      throw Object.assign(new Error('Terminal session belongs to another user.'), { status: 403 })
    }

    const session: TerminalSessionRecord = {
      id,
      userId: params.userId,
      authSessionId: params.authSessionId,
      email: params.email,
      cols,
      rows,
      cwd: '/data',
      createdAt: new Date().toISOString(),
    }
    this.sessions.set(id, session)

    const wsTicket = crypto.randomBytes(24).toString('hex')
    const ticketExpiresAt = Date.now() + TERMINAL_TICKET_TTL_MS
    this.tickets.set(wsTicket, {
      ticket: wsTicket,
      sessionId: id,
      userId: params.userId,
      authSessionId: params.authSessionId,
      email: params.email,
      expiresAt: ticketExpiresAt,
    })

    this.audit.record({
      userId: params.userId,
      actor: params.email,
      action: 'terminal.session_create',
      resourceType: 'terminal',
      resourceId: id,
      outcome: 'success',
      ip: params.ip,
      correlationId: params.correlationId,
    })

    return {
      id: session.id,
      cols: session.cols,
      rows: session.rows,
      cwd: session.cwd,
      wsTicket,
      ticketExpiresAt,
    }
  }

  deleteSession(sessionId: string, userId: string, canManageAll: boolean): boolean {
    const existing = this.sessions.get(sessionId)
    if (existing && existing.userId !== userId && !canManageAll) {
      throw Object.assign(new Error('Cannot close a terminal session owned by another user.'), { status: 403 })
    }
    const deleted = this.sessions.delete(sessionId)
    for (const [k, v] of this.tickets.entries()) {
      if (v.sessionId === sessionId) this.tickets.delete(k)
    }
    return deleted
  }

  closeSocketsForAuthSession(authSessionId: string, reason = 'Session closed'): void {
    const set = this.activeSocketsByAuthSession.get(authSessionId)
    if (!set) return
    for (const ws of Array.from(set)) {
      try {
        ws.close(4001, reason)
      } catch {
        // ignore close errors
      }
    }
    this.activeSocketsByAuthSession.delete(authSessionId)
  }

  private validateOrigin(request: http.IncomingMessage): boolean {
    const origin = String(request.headers.origin || '').trim()
    // Non-browser WS clients (Node `ws`, CLI, tests) omit Origin
    if (!origin) return true

    try {
      const originUrl = new URL(origin)
      const hostHeader = String(request.headers['x-forwarded-host'] || request.headers.host || '')
        .split(',')[0]
        .trim()
        .toLowerCase()
      if (hostHeader && originUrl.host.toLowerCase() === hostHeader) {
        return true
      }
      const allowedExtra = (process.env.KATHAL_ALLOWED_ORIGINS || '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
      if (allowedExtra.includes(origin.toLowerCase())) return true
      if (
        (originUrl.hostname === 'localhost' || originUrl.hostname === '127.0.0.1') &&
        hostHeader.startsWith(originUrl.hostname)
      ) {
        return true
      }
    } catch {
      return false
    }
    return false
  }

  handleUpgrade(request: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer, wss: WebSocketServer): void {
    const reqUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
    const match = /^\/api\/v1\/terminal\/ws\/([^/]+)$/.exec(reqUrl.pathname)
    if (!match) {
      socket.destroy()
      return
    }
    const sessionId = match[1]
    const ip = request.socket?.remoteAddress || '127.0.0.1'

    if (!this.validateOrigin(request)) {
      this.audit.record({
        actor: 'system',
        action: 'terminal.ws_connect',
        resourceType: 'terminal',
        resourceId: sessionId,
        outcome: 'denied',
        ip,
        detail: 'invalid_origin',
      })
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }

    this.pruneExpiredTickets()
    const rawTicket = reqUrl.searchParams.get('ticket') || ''
    const stored = rawTicket ? this.tickets.get(rawTicket) : undefined
    if (
      !stored ||
      stored.expiresAt <= Date.now() ||
      stored.sessionId !== sessionId ||
      !safeEqualStrings(rawTicket, stored.ticket)
    ) {
      this.audit.record({
        actor: 'system',
        action: 'terminal.ws_connect',
        resourceType: 'terminal',
        resourceId: sessionId,
        outcome: 'denied',
        ip,
        detail: 'invalid_or_reused_ticket',
      })
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    // Consume ticket atomically before checking further state so replays cannot probe state
    this.tickets.delete(rawTicket)

    // Verify auth session is still active & user still holds terminal.access permission
    const user = this.authService.getUserById(stored.userId)
    const activeSessions = this.authService.listUserSessions(stored.userId)
    const sessionStillValid = activeSessions.some((s) => s.id === stored.authSessionId)
    if (!user || !user.isActive || !sessionStillValid || !user.permissions.includes('terminal.access')) {
      this.audit.record({
        userId: stored.userId,
        actor: stored.email,
        action: 'terminal.ws_connect',
        resourceType: 'terminal',
        resourceId: sessionId,
        outcome: 'denied',
        ip,
        detail: 'session_revoked_or_unauthorized',
      })
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }

    // Enforce concurrent WebSocket limit per user
    const userSockets = this.activeSocketsByUser.get(stored.userId) || new Set<WebSocket>()
    if (userSockets.size >= MAX_WS_CONNECTIONS_PER_USER) {
      this.audit.record({
        userId: stored.userId,
        actor: stored.email,
        action: 'terminal.ws_connect',
        resourceType: 'terminal',
        resourceId: sessionId,
        outcome: 'denied',
        ip,
        detail: 'max_connections_exceeded',
      })
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n')
      socket.destroy()
      return
    }

    const termSess = this.sessions.get(sessionId)
    if (!termSess || termSess.userId !== stored.userId) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }

    this.audit.record({
      userId: stored.userId,
      actor: stored.email,
      action: 'terminal.ws_connect',
      resourceType: 'terminal',
      resourceId: sessionId,
      outcome: 'success',
      ip,
    })

    wss.handleUpgrade(request, socket, head, (ws) => {
      userSockets.add(ws)
      this.activeSocketsByUser.set(stored.userId, userSockets)

      const authSockets = this.activeSocketsByAuthSession.get(stored.authSessionId) || new Set<WebSocket>()
      authSockets.add(ws)
      this.activeSocketsByAuthSession.set(stored.authSessionId, authSockets)

      ws.once('close', () => {
        userSockets.delete(ws)
        authSockets.delete(ws)
        this.audit.record({
          userId: stored.userId,
          actor: stored.email,
          action: 'terminal.ws_disconnect',
          resourceType: 'terminal',
          resourceId: sessionId,
          outcome: 'success',
          ip,
        })
      })

      this.onAttachSession(ws, sessionId, termSess.cwd, (nextCwd) => {
        termSess.cwd = nextCwd
      })
    })
  }
}
