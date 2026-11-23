export type AppSourceType = 'git' | 'dockerfile' | 'compose' | 'template' | 'native' | 'static'
export type AppBuildType = 'auto' | 'dockerfile' | 'compose' | 'node' | 'python' | 'static' | 'binary'
export type EnvironmentScopeName = 'development' | 'staging' | 'production'
export type GitProviderName = 'github' | 'gitlab' | 'git'

export type DeploymentStatus =
  | 'queued'
  | 'validating'
  | 'preparing'
  | 'cloning'
  | 'building'
  | 'deploying'
  | 'starting'
  | 'health_check'
  | 'succeeded'
  | 'failed'
  | 'cancelling'
  | 'cancelled'
  | 'rolling_back'

export type HealthState = 'healthy' | 'degraded' | 'unhealthy' | 'starting' | 'stopped' | 'unknown'

export interface HealthCheckConfig {
  enabled: boolean
  type: 'http' | 'tcp' | 'docker'
  path: string
  port?: number
  intervalSeconds: number
  timeoutSeconds: number
  failureThreshold: number
  recoveryThreshold: number
  autoRestart: boolean
  maxRestarts: number
  restartWindowSeconds: number
}

export interface ApplicationRecord {
  id: string
  name: string
  slug: string
  description: string
  serverId: string | null
  ownerUserId: string | null
  runtime: string
  image: string
  port: number
  status: string
  sourceType: AppSourceType
  buildType: AppBuildType
  branch: string
  dockerfilePath: string
  buildContext: string
  startCommand: string
  workingDir: string
  envScope: EnvironmentScopeName
  healthCheck: HealthCheckConfig
  activeDeploymentId: string | null
  archivedAt: string | null
  config: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface ApplicationSourceRecord {
  id: string
  applicationId: string
  provider: GitProviderName
  repoUrl: string
  branch: string
  hasToken: boolean
  hasWebhookSecret: boolean
  lastCommitSha: string | null
  lastCommitMessage: string | null
  lastDeliveryId: string | null
  createdAt: string
  updatedAt: string
}

export interface EnvironmentVariableItem {
  id: string
  applicationId: string | null
  environment: EnvironmentScopeName | 'global'
  key: string
  value: string
  hasValue: boolean
  isSecret: boolean
  description: string
  keyVersion: string
  createdAt: string
  updatedAt: string
}

export interface DeploymentRecord {
  id: string
  applicationId: string
  serverId: string | null
  triggeredBy: string | null
  triggerType: 'manual' | 'webhook' | 'rollback' | 'api'
  jobId: string | null
  rollbackOfId: string | null
  commitSha: string | null
  commitMessage: string | null
  branch: string | null
  environment: EnvironmentScopeName
  buildType: AppBuildType
  status: DeploymentStatus
  stage: DeploymentStatus
  artifactPath: string | null
  imageRef: string | null
  runtimeTargetId: string | null
  port: number | null
  errorDetail: string | null
  durationMs: number | null
  logs: string
  startedAt: string
  finishedAt: string | null
}

export interface JobRecord {
  id: string
  type: string
  targetType: string
  targetId: string
  dedupeKey: string | null
  status: DeploymentStatus
  payload: Record<string, unknown>
  result: Record<string, unknown> | null
  errorMessage: string | null
  attempt: number
  maxAttempts: number
  leaseOwner: string | null
  leaseExpiresAt: string | null
  cancelRequested: boolean
  createdBy: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  updatedAt: string
}

export type ProxyAdapterMode = 'builtin' | 'nginx' | 'caddy'
export type AcmeMode = 'http-01' | 'dns-01' | 'self-signed' | 'custom'
export type AcmeDirectoryMode = 'staging' | 'production'
export type CertificateStatus = 'pending' | 'valid' | 'self-signed' | 'expired' | 'failed' | 'unverified'

export interface DomainRouteRecord {
  id: string
  domain: string
  target: string
  port: number
  ssl: boolean
  enabled: boolean
  applicationId: string | null
  proxyAdapter: ProxyAdapterMode
  forceHttps: boolean
  validated: boolean
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export interface CertificateRecord {
  id: string
  domainId: string | null
  commonName: string
  sanDomains: string[]
  issuer: string
  acmeMode: AcmeMode
  acmeDirectory: AcmeDirectoryMode
  status: CertificateStatus
  autoRenew: boolean
  lastError: string | null
  verifiedAt: string | null
  expiresAt: string | null
  createdAt: string
  updatedAt: string
}

export type DatabaseEngineType = 'postgres' | 'mysql' | 'mariadb' | 'redis' | 'mongodb'
export type DatabaseRuntimeStatus = 'provisioning' | 'verifying' | 'running' | 'stopped' | 'error' | 'unavailable'

export interface DatabaseVerificationReport {
  runtimeMode: 'docker' | 'native' | 'mock' | 'unavailable'
  runtimeRunning: boolean
  runtimeHealthy: boolean
  tcpReachable: boolean
  authVerified: boolean
  databaseVerified: boolean
  verifiedAt: string
  detail: string
}

export interface ManagedDatabaseInstance {
  id: string
  name: string
  engine: DatabaseEngineType
  version: string
  host: string
  port: number
  username: string
  databaseName: string
  runtimeMode: 'docker' | 'native' | 'mock' | 'unavailable'
  containerOrPid: string | null
  internalOnly: boolean
  status: DatabaseRuntimeStatus
  hasPassword: boolean
  passwordMasked: string
  verification: DatabaseVerificationReport | null
  lastError: string | null
  ownerUserId: string | null
  serverId: string | null
  createdAt: string
  updatedAt: string
}
