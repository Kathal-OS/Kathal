import crypto from 'node:crypto'
import { getDefaultAppsRoot, getDataDir } from '../platform.ts'

let fallbackJwtSecret: string | null = null

export interface RuntimeConfig {
  port: number
  version: string
  dataDir: string
  appsDir: string
  adminEmail: string
  configuredAdminPassword: string
  jwtSecret: string
  vaultKeyEnv: string
  allowSelfRegistration: boolean
  sessionIdleMs: number
  sessionAbsoluteMs: number
  fleetAllowPrivateNetworks: boolean
  isProduction: boolean
  cookieSecure: boolean
}

export function getJwtSecret(): string {
  const envSecret = (process.env.KATHAL_JWT_SECRET || '').trim()
  if (envSecret) return envSecret
  if (!fallbackJwtSecret) {
    fallbackJwtSecret = crypto.randomBytes(32).toString('hex')
  }
  return fallbackJwtSecret
}

export function getRuntimeConfig(): RuntimeConfig {
  const port =
    process.env.PORT !== undefined && process.env.PORT !== '' ? Number(process.env.PORT) : 3000
  const sessionIdleHours = Number(process.env.KATHAL_SESSION_IDLE_HOURS || 12)
  const sessionAbsHours = Number(process.env.KATHAL_SESSION_MAX_HOURS || 72)

  return {
    port: Number.isFinite(port) ? port : 3000,
    version: (process.env.KATHAL_VERSION || '0.1.0').trim() || '0.1.0',
    dataDir: getDataDir(),
    appsDir: getDefaultAppsRoot(),
    adminEmail: (process.env.KATHAL_ADMIN_EMAIL || 'admin@kathal.local').trim().toLowerCase(),
    configuredAdminPassword: (process.env.KATHAL_ADMIN_PASSWORD || '').trim(),
    jwtSecret: getJwtSecret(),
    vaultKeyEnv: (process.env.KATHAL_VAULT_KEY || '').trim(),
    allowSelfRegistration: process.env.KATHAL_ALLOW_SELF_REGISTRATION === 'true',
    sessionIdleMs: Math.max(60_000, (Number.isFinite(sessionIdleHours) ? sessionIdleHours : 12) * 3600_000),
    sessionAbsoluteMs: Math.max(300_000, (Number.isFinite(sessionAbsHours) ? sessionAbsHours : 72) * 3600_000),
    fleetAllowPrivateNetworks: process.env.KATHAL_FLEET_ALLOW_PRIVATE_NETWORKS !== 'false',
    isProduction: process.env.NODE_ENV === 'production',
    cookieSecure: process.env.KATHAL_COOKIE_SECURE === 'true',
  }
}
