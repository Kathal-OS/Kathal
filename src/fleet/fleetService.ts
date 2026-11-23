import crypto from 'node:crypto'
import dns from 'node:dns'
import net from 'node:net'
import os from 'node:os'
import type { DatabaseSync } from 'node:sqlite'
import { getRuntimeConfig } from '../config/runtimeConfig.ts'
import { getPlatformLabel } from '../platform.ts'
import { safeEqualStrings, sha256Hex } from '../security/password.ts'

export interface FleetServerView {
  id: string
  name: string
  host: string
  port: number
  authMethod: 'local-agent' | 'ssh-key' | 'agent-token'
  role: 'control-plane' | 'worker'
  group: string
  tags: string[]
  status: 'online' | 'pending' | 'unreachable'
  isLocal: boolean
  os: string
  arch: string
  ownerUserId: string | null
  agentId: string | null
  hasAgentToken: boolean
  agentVersion: string | null
  lastHeartbeatAt: string | null
  lastCheckedAt: string | null
  latencyMs: number | null
  createdAt: string
}

export interface ServerStatusHistoryEntry {
  id: string
  serverId: string
  status: string
  latencyMs: number | null
  cpuPercent: number | null
  memoryPercent: number | null
  diskPercent: number | null
  detail: string | null
  checkedAt: string
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
  'metadata.goog',
  '169.254.169.254',
])

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number)
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
}

function inCidr4(ip: string, base: string, maskBits: number): boolean {
  const mask = maskBits === 0 ? 0 : (~0 << (32 - maskBits)) >>> 0
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask)
}

export function classifyIpAddress(
  rawIp: string,
  allowPrivateNetworks: boolean
): { allowed: boolean; reason?: string } {
  let ip = rawIp.trim().toLowerCase()
  // Normalize IPv4-mapped IPv6 (e.g. ::ffff:169.254.169.254)
  if (ip.startsWith('::ffff:')) {
    ip = ip.slice(7)
  }

  const ver = net.isIP(ip)
  if (ver === 4) {
    if (inCidr4(ip, '169.254.0.0', 16)) {
      return { allowed: false, reason: 'Link-local and cloud metadata addresses (169.254.0.0/16) are blocked.' }
    }
    if (inCidr4(ip, '127.0.0.0', 8)) {
      return { allowed: false, reason: 'Loopback IP addresses (127.0.0.0/8) cannot be registered as remote servers.' }
    }
    if (inCidr4(ip, '0.0.0.0', 8)) {
      return { allowed: false, reason: 'Unspecified addresses (0.0.0.0/8) are blocked.' }
    }
    if (inCidr4(ip, '224.0.0.0', 4) || inCidr4(ip, '240.0.0.0', 4)) {
      return { allowed: false, reason: 'Multicast and reserved IP ranges are blocked.' }
    }
    if (
      !allowPrivateNetworks &&
      (inCidr4(ip, '10.0.0.0', 8) || inCidr4(ip, '172.16.0.0', 12) || inCidr4(ip, '192.168.0.0', 16))
    ) {
      return { allowed: false, reason: 'Private RFC1918 addresses are blocked by current fleet policy.' }
    }
    return { allowed: true }
  }

  if (ver === 6) {
    const bare = ip.split('%')[0]
    if (bare === '::' || bare === '::1') {
      return { allowed: false, reason: 'IPv6 loopback/unspecified addresses are blocked.' }
    }
    if (bare.startsWith('fe80:') || bare.startsWith('fe9') || bare.startsWith('fea') || bare.startsWith('feb')) {
      return { allowed: false, reason: 'IPv6 link-local addresses (fe80::/10) are blocked.' }
    }
    if (bare.startsWith('ff')) {
      return { allowed: false, reason: 'IPv6 multicast addresses are blocked.' }
    }
    if (!allowPrivateNetworks && (bare.startsWith('fc') || bare.startsWith('fd'))) {
      return { allowed: false, reason: 'IPv6 unique local addresses are blocked by current fleet policy.' }
    }
    return { allowed: true }
  }

  return { allowed: false, reason: 'Invalid IP address format.' }
}

export function isValidRemoteHostSyntax(rawHost: string): { ok: boolean; error?: string } {
  const host = rawHost.trim().toLowerCase()
  if (!host || host.length > 253) {
    return { ok: false, error: 'Valid hostname or IP address is required.' }
  }
  if (BLOCKED_HOSTNAMES.has(host)) {
    return { ok: false, error: 'Target hostname is disallowed by fleet security policy.' }
  }
  if (
    host === 'metadata.google.internal' ||
    host === 'metadata.goog' ||
    host.endsWith('.internal') ||
    host.includes('localhost')
  ) {
    return { ok: false, error: 'Target hostname is disallowed by fleet security policy.' }
  }
  if (net.isIP(host)) {
    const cfg = getRuntimeConfig()
    const check = classifyIpAddress(host, cfg.fleetAllowPrivateNetworks)
    if (!check.allowed) return { ok: false, error: check.reason }
    return { ok: true }
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)) {
    return { ok: false, error: 'Malformed hostname format.' }
  }
  return { ok: true }
}

export async function resolveAndValidateTargetIp(
  host: string,
  allowPrivateOverride?: boolean
): Promise<{ ok: boolean; resolvedIp?: string; error?: string }> {
  const allowPrivate =
    allowPrivateOverride !== undefined
      ? allowPrivateOverride
      : getRuntimeConfig().fleetAllowPrivateNetworks

  if (net.isIP(host)) {
    const check = classifyIpAddress(host, allowPrivate)
    return check.allowed ? { ok: true, resolvedIp: host } : { ok: false, error: check.reason }
  }

  const syntax = isValidRemoteHostSyntax(host)
  if (!syntax.ok) return { ok: false, error: syntax.error }

  let records: Array<{ address: string; family: number }>
  try {
    records = await dns.promises.lookup(host, { all: true })
  } catch (err) {
    return { ok: false, error: `DNS lookup failed for "${host}": ${(err as Error).message}` }
  }

  if (!records || records.length === 0) {
    return { ok: false, error: `Hostname "${host}" resolved to no IP addresses.` }
  }

  for (const rec of records) {
    const check = classifyIpAddress(rec.address, allowPrivate)
    if (!check.allowed) {
      return {
        ok: false,
        error: `DNS resolution blocked (${rec.address}): ${check.reason}`,
      }
    }
  }

  return { ok: true, resolvedIp: records[0].address }
}

function probeTcpSocket(
  targetIp: string,
  port: number,
  timeoutMs = 2200
): Promise<{ reachable: boolean; latencyMs: number; error?: string }> {
  return new Promise((resolve) => {
    const started = Date.now()
    const socket = net.createConnection({ host: targetIp, port })
    let settled = false
    const finish = (reachable: boolean, error?: string) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({ reachable, latencyMs: Date.now() - started, error })
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false, 'connection timed out'))
    socket.once('error', (err) => finish(false, err.message))
  })
}

export class FleetService {
  private db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  ensureLocalPrimaryNode(ownerUserId?: string | null): void {
    const existing = this.db
      .prepare('SELECT id FROM servers WHERE id = ? OR is_local = 1')
      .get('local-primary') as { id: string } | undefined
    const cfg = getRuntimeConfig()
    const now = new Date().toISOString()

    if (!existing) {
      this.db
        .prepare(`INSERT OR IGNORE INTO server_groups (id, name, description, created_at) VALUES ('grp-default', 'default', 'Default server group', ?)`)
        .run(now)
      this.db
        .prepare(
          `INSERT INTO servers (
            id, name, host, port, auth_method, role, group_id, group_name, tags_json,
            status, is_local, os, arch, owner_user_id, agent_id, agent_version,
            last_checked_at, latency_ms, created_at, updated_at
          ) VALUES ('local-primary', ?, '127.0.0.1', ?, 'local-agent', 'control-plane', 'grp-default', 'default', ?,
                    'online', 1, ?, ?, ?, 'agent-local-primary', ?, ?, 0, ?, ?)`
        )
        .run(
          os.hostname() || 'KATHAL Primary Node',
          cfg.port || 3000,
          JSON.stringify(['local', process.platform, os.arch()]),
          `${getPlatformLabel()} (${os.platform()})`,
          os.arch(),
          ownerUserId || null,
          cfg.version,
          now,
          now,
          now
        )
    } else if (ownerUserId) {
      this.db
        .prepare('UPDATE servers SET owner_user_id = COALESCE(owner_user_id, ?), updated_at = ? WHERE id = ?')
        .run(ownerUserId, now, existing.id)
    }
  }

  private mapServerRow(r: Record<string, unknown>): FleetServerView {
    return {
      id: String(r.id),
      name: String(r.name),
      host: String(r.host),
      port: Number(r.port),
      authMethod: (r.auth_method as FleetServerView['authMethod']) || 'ssh-key',
      role: (r.role as FleetServerView['role']) || 'worker',
      group: String(r.group_name || 'default'),
      tags: JSON.parse(String(r.tags_json || '[]')) as string[],
      status: (r.status as FleetServerView['status']) || 'pending',
      isLocal: Boolean(r.is_local),
      os: String(r.os || ''),
      arch: String(r.arch || ''),
      ownerUserId: r.owner_user_id ? String(r.owner_user_id) : null,
      agentId: r.agent_id ? String(r.agent_id) : null,
      hasAgentToken: Boolean(r.agent_token_hash),
      agentVersion: r.agent_version ? String(r.agent_version) : null,
      lastHeartbeatAt: r.last_heartbeat_at ? String(r.last_heartbeat_at) : null,
      lastCheckedAt: r.last_checked_at ? String(r.last_checked_at) : null,
      latencyMs: r.latency_ms !== null && r.latency_ms !== undefined ? Number(r.latency_ms) : null,
      createdAt: String(r.created_at),
    }
  }

  listServers(): FleetServerView[] {
    const rows = this.db
      .prepare('SELECT * FROM servers ORDER BY is_local DESC, created_at ASC')
      .all() as Array<Record<string, unknown>>
    return rows.map((r) => this.mapServerRow(r))
  }

  getServer(id: string): FleetServerView | null {
    const row = this.db.prepare('SELECT * FROM servers WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? this.mapServerRow(row) : null
  }

  listGroups(): Array<{ id: string; name: string; description: string; createdAt: string }> {
    const rows = this.db.prepare('SELECT id, name, description, created_at FROM server_groups ORDER BY name ASC').all() as Array<{
      id: string
      name: string
      description: string
      created_at: string
    }>
    return rows.map((r) => ({ id: r.id, name: r.name, description: r.description, createdAt: r.created_at }))
  }

  registerServer(
    input: {
      name: string
      host: string
      port?: number
      authMethod?: string
      group?: string
      tags?: string[]
      os?: string
      arch?: string
    },
    ownerUserId: string
  ): { server: FleetServerView; agentToken?: string } {
    const name = input.name.trim()
    const host = input.host.trim().toLowerCase()
    const port = input.port !== undefined ? Number(input.port) : 22
    const authMethod = input.authMethod === 'agent-token' ? 'agent-token' : 'ssh-key'
    const groupName = (input.group || 'production').trim() || 'production'
    const tags = Array.isArray(input.tags)
      ? input.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 10)
      : []

    if (!name) {
      throw Object.assign(new Error('Valid server name is required'), { status: 400 })
    }
    const syntax = isValidRemoteHostSyntax(host)
    if (!syntax.ok) {
      throw Object.assign(new Error(syntax.error || 'Valid server hostname/IP is required'), { status: 400 })
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw Object.assign(new Error('Port must be an integer between 1 and 65535'), { status: 400 })
    }

    const now = new Date().toISOString()
    const id = `srv-${crypto.randomBytes(6).toString('hex')}`
    const groupId = `grp-${groupName.toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'default'}`
    const agentId = `agt-${crypto.randomBytes(6).toString('hex')}`

    let rawAgentToken: string | undefined
    let agentTokenHash: string | null = null
    let agentTokenRotatedAt: string | null = null
    if (authMethod === 'agent-token') {
      rawAgentToken = `kat_${crypto.randomBytes(24).toString('hex')}`
      agentTokenHash = sha256Hex(rawAgentToken)
      agentTokenRotatedAt = now
    }

    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare('INSERT OR IGNORE INTO server_groups (id, name, description, created_at) VALUES (?, ?, ?, ?)')
        .run(groupId, groupName, '', now)
      this.db
        .prepare(
          `INSERT INTO servers (
            id, name, host, port, auth_method, role, group_id, group_name, tags_json,
            status, is_local, os, arch, owner_user_id, agent_id, agent_token_hash,
            agent_token_rotated_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'worker', ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          name,
          host,
          port,
          authMethod,
          groupId,
          groupName,
          JSON.stringify(tags),
          input.os || 'Linux (pending verification)',
          input.arch || 'unknown',
          ownerUserId,
          agentId,
          agentTokenHash,
          agentTokenRotatedAt,
          now,
          now
        )
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }

    return { server: this.getServer(id)!, agentToken: rawAgentToken }
  }

  async probeServer(
    id: string,
    allowPrivateOverride?: boolean
  ): Promise<{ server: FleetServerView; reachable: boolean; latencyMs: number; error?: string }> {
    const server = this.getServer(id)
    if (!server) {
      throw Object.assign(new Error('server not found'), { status: 404 })
    }
    const now = new Date().toISOString()

    if (server.isLocal) {
      this.db
        .prepare("UPDATE servers SET status = 'online', last_checked_at = ?, latency_ms = 0, updated_at = ? WHERE id = ?")
        .run(now, now, id)
      this.recordHistory(id, 'online', 0, null, null, null, 'Local control-plane healthy')
      return { server: this.getServer(id)!, reachable: true, latencyMs: 0 }
    }

    const dnsCheck = await resolveAndValidateTargetIp(server.host, allowPrivateOverride)
    if (!dnsCheck.ok || !dnsCheck.resolvedIp) {
      this.db
        .prepare("UPDATE servers SET status = 'unreachable', last_checked_at = ?, latency_ms = NULL, updated_at = ? WHERE id = ?")
        .run(now, now, id)
      this.recordHistory(id, 'unreachable', null, null, null, null, dnsCheck.error || 'Target rejected')
      throw Object.assign(new Error(dnsCheck.error || 'Target host rejected by SSRF policy'), { status: 400 })
    }

    const probe = await probeTcpSocket(dnsCheck.resolvedIp, server.port)
    const nextStatus = probe.reachable ? 'online' : 'unreachable'
    this.db
      .prepare('UPDATE servers SET status = ?, last_checked_at = ?, latency_ms = ?, updated_at = ? WHERE id = ?')
      .run(nextStatus, now, probe.reachable ? probe.latencyMs : null, now, id)
    this.recordHistory(
      id,
      nextStatus,
      probe.reachable ? probe.latencyMs : null,
      null,
      null,
      null,
      probe.error || `TCP probe to ${dnsCheck.resolvedIp}:${server.port}`
    )

    return {
      server: this.getServer(id)!,
      reachable: probe.reachable,
      latencyMs: probe.latencyMs,
      error: probe.error,
    }
  }

  rotateAgentToken(serverId: string): { agentId: string; agentToken: string; rotatedAt: string } {
    const server = this.getServer(serverId)
    if (!server) throw Object.assign(new Error('server not found'), { status: 404 })
    if (server.isLocal) {
      throw Object.assign(new Error('Control-plane local node does not use remote agent tokens'), { status: 400 })
    }
    const rawToken = `kat_${crypto.randomBytes(24).toString('hex')}`
    const tokenHash = sha256Hex(rawToken)
    const now = new Date().toISOString()
    const agentId = server.agentId || `agt-${crypto.randomBytes(6).toString('hex')}`

    this.db
      .prepare(
        `UPDATE servers SET auth_method = 'agent-token', agent_id = ?, agent_token_hash = ?, agent_token_rotated_at = ?, updated_at = ? WHERE id = ?`
      )
      .run(agentId, tokenHash, now, now, serverId)

    return { agentId, agentToken: rawToken, rotatedAt: now }
  }

  recordAgentHeartbeat(
    agentId: string,
    rawToken: string,
    payload: {
      agentVersion?: string
      os?: string
      arch?: string
      cpuPercent?: number
      memoryPercent?: number
      diskPercent?: number
    }
  ): FleetServerView {
    const row = this.db
      .prepare('SELECT id, agent_token_hash, is_local FROM servers WHERE agent_id = ?')
      .get(agentId) as { id: string; agent_token_hash: string | null; is_local: number } | undefined

    if (!row || row.is_local || !row.agent_token_hash) {
      throw Object.assign(new Error('Invalid agent credentials'), { status: 401 })
    }
    if (!safeEqualStrings(sha256Hex(rawToken), row.agent_token_hash)) {
      throw Object.assign(new Error('Invalid agent credentials'), { status: 401 })
    }

    const now = new Date().toISOString()
    this.db
      .prepare(
        `UPDATE servers
         SET status = 'online',
             agent_version = COALESCE(?, agent_version),
             os = COALESCE(?, os),
             arch = COALESCE(?, arch),
             last_heartbeat_at = ?,
             last_checked_at = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(
        payload.agentVersion || null,
        payload.os || null,
        payload.arch || null,
        now,
        now,
        now,
        row.id
      )

    this.recordHistory(
      row.id,
      'online',
      0,
      payload.cpuPercent ?? null,
      payload.memoryPercent ?? null,
      payload.diskPercent ?? null,
      `Agent heartbeat (${payload.agentVersion || 'unknown'})`
    )

    return this.getServer(row.id)!
  }

  private recordHistory(
    serverId: string,
    status: string,
    latencyMs: number | null,
    cpuPercent: number | null,
    memoryPercent: number | null,
    diskPercent: number | null,
    detail: string | null
  ): void {
    this.db
      .prepare(
        `INSERT INTO server_status_history (
          id, server_id, status, latency_ms, cpu_percent, memory_percent, disk_percent, detail, checked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        `sh-${crypto.randomBytes(6).toString('hex')}`,
        serverId,
        status,
        latencyMs,
        cpuPercent,
        memoryPercent,
        diskPercent,
        detail,
        new Date().toISOString()
      )
  }

  getServerHistory(serverId: string, limit = 50): ServerStatusHistoryEntry[] {
    const server = this.getServer(serverId)
    if (!server) throw Object.assign(new Error('server not found'), { status: 404 })
    const rows = this.db
      .prepare(
        `SELECT id, server_id, status, latency_ms, cpu_percent, memory_percent, disk_percent, detail, checked_at
         FROM server_status_history
         WHERE server_id = ?
         ORDER BY checked_at DESC
         LIMIT ?`
      )
      .all(serverId, Math.min(200, Math.max(1, limit))) as Array<{
      id: string
      server_id: string
      status: string
      latency_ms: number | null
      cpu_percent: number | null
      memory_percent: number | null
      disk_percent: number | null
      detail: string | null
      checked_at: string
    }>

    return rows.map((r) => ({
      id: r.id,
      serverId: r.server_id,
      status: r.status,
      latencyMs: r.latency_ms,
      cpuPercent: r.cpu_percent,
      memoryPercent: r.memory_percent,
      diskPercent: r.disk_percent,
      detail: r.detail,
      checkedAt: r.checked_at,
    }))
  }

  deleteServer(id: string): FleetServerView {
    const server = this.getServer(id)
    if (!server) throw Object.assign(new Error('server not found'), { status: 404 })
    if (server.isLocal) {
      throw Object.assign(new Error('Cannot remove primary control-plane node'), { status: 400 })
    }
    this.db.prepare('DELETE FROM servers WHERE id = ?').run(id)
    return server
  }
}
