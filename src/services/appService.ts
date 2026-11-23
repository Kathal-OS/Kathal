import crypto from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { VaultManager } from '../security/vault.ts'
import type {
  AppBuildType,
  AppSourceType,
  ApplicationRecord,
  ApplicationSourceRecord,
  EnvironmentScopeName,
  GitProviderName,
  HealthCheckConfig,
} from '../types/phase2.ts'
import {
  isValidGitBranchOrRef,
  isValidPort,
  isValidSlugOrAppName,
  slugifyAppName,
  validateGitRepositoryUrl,
} from '../validation/validators.ts'

const DEFAULT_HC: HealthCheckConfig = {
  enabled: true,
  type: 'http',
  path: '/',
  intervalSeconds: 30,
  timeoutSeconds: 5,
  failureThreshold: 3,
  recoveryThreshold: 2,
  autoRestart: true,
  maxRestarts: 3,
  restartWindowSeconds: 300,
}

export class ApplicationService {
  private db: DatabaseSync
  private vault: VaultManager

  constructor(db: DatabaseSync, vault: VaultManager) {
    this.db = db
    this.vault = vault
  }

  listApplications(options: { includeArchived?: boolean; q?: string } = {}): ApplicationRecord[] {
    const clauses: string[] = []
    const params: string[] = []
    if (!options.includeArchived) {
      clauses.push('archived_at IS NULL')
    }
    if (options.q?.trim()) {
      clauses.push('(LOWER(name) LIKE ? OR LOWER(description) LIKE ? OR LOWER(slug) LIKE ?)')
      const like = `%${options.q.trim().toLowerCase()}%`
      params.push(like, like, like)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db
      .prepare(`SELECT * FROM applications ${where} ORDER BY created_at DESC`)
      .all(...params) as Array<Record<string, unknown>>
    return rows.map((r) => this.mapAppRow(r))
  }

  getApplication(idOrSlug: string): ApplicationRecord | null {
    const key = idOrSlug.trim()
    const row = this.db
      .prepare('SELECT * FROM applications WHERE id = ? OR slug = ?')
      .get(key, key.toLowerCase()) as Record<string, unknown> | undefined
    return row ? this.mapAppRow(row) : null
  }

  getSource(applicationId: string): ApplicationSourceRecord | null {
    const row = this.db
      .prepare('SELECT * FROM application_sources WHERE application_id = ?')
      .get(applicationId) as Record<string, unknown> | undefined
    return row ? this.mapSourceRow(row) : null
  }

  getDecryptedSourceSecrets(applicationId: string): { token: string; deployKey: string; webhookSecret: string } {
    const row = this.db
      .prepare('SELECT token_enc, deploy_key_enc, webhook_secret_enc FROM application_sources WHERE application_id = ?')
      .get(applicationId) as { token_enc: string; deploy_key_enc: string; webhook_secret_enc: string } | undefined
    if (!row) return { token: '', deployKey: '', webhookSecret: '' }
    return {
      token: row.token_enc ? this.vault.decryptSecret(row.token_enc) : '',
      deployKey: row.deploy_key_enc ? this.vault.decryptSecret(row.deploy_key_enc) : '',
      webhookSecret: row.webhook_secret_enc ? this.vault.decryptSecret(row.webhook_secret_enc) : '',
    }
  }

  createApplication(input: {
    name: string
    slug?: string
    description?: string
    serverId?: string | null
    ownerUserId?: string | null
    runtime?: string
    image?: string
    port?: number
    sourceType?: AppSourceType
    buildType?: AppBuildType
    branch?: string
    dockerfilePath?: string
    buildContext?: string
    startCommand?: string
    workingDir?: string
    envScope?: EnvironmentScopeName
    healthCheck?: Partial<HealthCheckConfig>
    gitSource?: {
      provider?: GitProviderName
      repoUrl: string
      branch?: string
      token?: string
      webhookSecret?: string
      allowLocalPath?: boolean
      allowPrivateHosts?: boolean
    }
  }): { app: ApplicationRecord; source: ApplicationSourceRecord | null; webhookSecretPlain?: string } {
    const name = input.name.trim()
    if (!name || name.length > 80) throw new Error('Application name is required (1-80 characters)')

    const slug = slugifyAppName(input.slug || name)
    if (!isValidSlugOrAppName(slug)) {
      throw new Error('Application slug must contain at least 2 alphanumeric or hyphen characters')
    }
    const existingSlug = this.db.prepare('SELECT id FROM applications WHERE slug = ?').get(slug)
    if (existingSlug) {
      throw new Error(`Application with slug "${slug}" already exists`)
    }

    const port = input.port ?? 3000
    if (!isValidPort(port)) throw new Error('Port must be between 1 and 65535')

    const branch = (input.branch || input.gitSource?.branch || 'main').trim()
    if (!isValidGitBranchOrRef(branch)) throw new Error('Invalid branch name')

    const hc: HealthCheckConfig = {
      ...DEFAULT_HC,
      ...(input.healthCheck || {}),
    }

    const id = `app-${crypto.randomBytes(6).toString('hex')}`
    const now = new Date().toISOString()

    let webhookSecretPlain: string | undefined
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare(
          `INSERT INTO applications (
            id, name, slug, description, server_id, owner_user_id, runtime, image, port, status,
            source_type, build_type, branch, dockerfile_path, build_context, start_command, working_dir,
            env_scope, health_check_json, restart_policy_json, config_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`
        )
        .run(
          id,
          name,
          slug,
          (input.description || '').trim(),
          input.serverId || null,
          input.ownerUserId || null,
          input.runtime || 'node',
          input.image || '',
          port,
          input.sourceType || (input.gitSource ? 'git' : 'native'),
          input.buildType || 'auto',
          branch,
          input.dockerfilePath || 'Dockerfile',
          input.buildContext || '.',
          input.startCommand || '',
          input.workingDir || '',
          input.envScope || 'production',
          JSON.stringify(hc),
          JSON.stringify({ autoRestart: hc.autoRestart, maxRestarts: hc.maxRestarts }),
          now,
          now
        )

      if (input.gitSource?.repoUrl) {
        const urlCheck = validateGitRepositoryUrl(input.gitSource.repoUrl, {
          allowLocalPath: input.gitSource.allowLocalPath,
          allowPrivateHosts: input.gitSource.allowPrivateHosts,
        })
        if (!urlCheck.ok) {
          throw new Error(urlCheck.error || 'Invalid Git repository URL')
        }
        webhookSecretPlain = input.gitSource.webhookSecret?.trim() || crypto.randomBytes(20).toString('hex')
        const tokEnc = input.gitSource.token?.trim()
          ? this.vault.encryptSecret(input.gitSource.token.trim())
          : ''
        const whEnc = this.vault.encryptSecret(webhookSecretPlain)
        this.db
          .prepare(
            `INSERT INTO application_sources (
              id, application_id, provider, repo_url, branch, token_enc, webhook_secret_enc, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            `src-${crypto.randomBytes(6).toString('hex')}`,
            id,
            input.gitSource.provider || 'git',
            urlCheck.sanitizedUrl,
            branch,
            tokEnc,
            whEnc,
            now,
            now
          )
      }

      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }

    return {
      app: this.getApplication(id)!,
      source: this.getSource(id),
      webhookSecretPlain,
    }
  }

  updateApplication(
    id: string,
    patch: Partial<{
      name: string
      description: string
      runtime: string
      port: number
      buildType: AppBuildType
      branch: string
      dockerfilePath: string
      buildContext: string
      startCommand: string
      envScope: EnvironmentScopeName
      healthCheck: Partial<HealthCheckConfig>
      status: string
      activeDeploymentId: string | null
      archived: boolean
    }>
  ): ApplicationRecord | null {
    const existing = this.getApplication(id)
    if (!existing) return null

    if (patch.port !== undefined && !isValidPort(patch.port)) {
      throw new Error('Port must be between 1 and 65535')
    }
    if (patch.branch !== undefined && !isValidGitBranchOrRef(patch.branch)) {
      throw new Error('Invalid branch name')
    }

    const now = new Date().toISOString()
    const nextHc = patch.healthCheck ? { ...existing.healthCheck, ...patch.healthCheck } : existing.healthCheck
    const archivedAt = patch.archived === true ? now : patch.archived === false ? null : existing.archivedAt

    this.db
      .prepare(
        `UPDATE applications
         SET name = ?, description = ?, runtime = ?, port = ?, build_type = ?, branch = ?,
             dockerfile_path = ?, build_context = ?, start_command = ?, env_scope = ?,
             health_check_json = ?, status = ?, active_deployment_id = ?, archived_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        patch.name?.trim() || existing.name,
        patch.description !== undefined ? patch.description.trim() : existing.description,
        patch.runtime || existing.runtime,
        patch.port ?? existing.port,
        patch.buildType || existing.buildType,
        patch.branch?.trim() || existing.branch,
        patch.dockerfilePath || existing.dockerfilePath,
        patch.buildContext || existing.buildContext,
        patch.startCommand !== undefined ? patch.startCommand : existing.startCommand,
        patch.envScope || existing.envScope,
        JSON.stringify(nextHc),
        patch.status || existing.status,
        patch.activeDeploymentId !== undefined ? patch.activeDeploymentId : existing.activeDeploymentId,
        archivedAt,
        now,
        existing.id
      )

    return this.getApplication(existing.id)
  }

  upsertGitSource(
    applicationId: string,
    input: {
      provider?: GitProviderName
      repoUrl: string
      branch?: string
      token?: string
      webhookSecret?: string
      allowLocalPath?: boolean
      allowPrivateHosts?: boolean
    }
  ): ApplicationSourceRecord {
    const urlCheck = validateGitRepositoryUrl(input.repoUrl, {
      allowLocalPath: input.allowLocalPath,
      allowPrivateHosts: input.allowPrivateHosts,
    })
    if (!urlCheck.ok) throw new Error(urlCheck.error || 'Invalid Git repository URL')

    const branch = (input.branch || 'main').trim()
    if (!isValidGitBranchOrRef(branch)) throw new Error('Invalid Git branch name')

    const existing = this.db
      .prepare('SELECT id, token_enc, webhook_secret_enc FROM application_sources WHERE application_id = ?')
      .get(applicationId) as { id: string; token_enc: string; webhook_secret_enc: string } | undefined

    const now = new Date().toISOString()
    const tokEnc = input.token !== undefined
      ? input.token.trim()
        ? this.vault.encryptSecret(input.token.trim())
        : ''
      : existing?.token_enc || ''
    const whEnc = input.webhookSecret?.trim()
      ? this.vault.encryptSecret(input.webhookSecret.trim())
      : existing?.webhook_secret_enc || this.vault.encryptSecret(crypto.randomBytes(20).toString('hex'))

    if (existing) {
      this.db
        .prepare(
          `UPDATE application_sources
           SET provider = ?, repo_url = ?, branch = ?, token_enc = ?, webhook_secret_enc = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(input.provider || 'git', urlCheck.sanitizedUrl, branch, tokEnc, whEnc, now, existing.id)
    } else {
      this.db
        .prepare(
          `INSERT INTO application_sources (
            id, application_id, provider, repo_url, branch, token_enc, webhook_secret_enc, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          `src-${crypto.randomBytes(6).toString('hex')}`,
          applicationId,
          input.provider || 'git',
          urlCheck.sanitizedUrl,
          branch,
          tokEnc,
          whEnc,
          now,
          now
        )
    }

    return this.getSource(applicationId)!
  }

  deleteApplication(id: string): boolean {
    const info = this.db.prepare('DELETE FROM applications WHERE id = ?').run(id)
    return info.changes > 0
  }

  private mapAppRow(row: Record<string, unknown>): ApplicationRecord {
    const hcParsed = JSON.parse(String(row.health_check_json || '{}')) as Partial<HealthCheckConfig>
    return {
      id: String(row.id),
      name: String(row.name),
      slug: String(row.slug || slugifyAppName(String(row.name))),
      description: String(row.description || ''),
      serverId: row.server_id ? String(row.server_id) : null,
      ownerUserId: row.owner_user_id ? String(row.owner_user_id) : null,
      runtime: String(row.runtime || 'node'),
      image: String(row.image || ''),
      port: Number(row.port || 3000),
      status: String(row.status || 'stopped'),
      sourceType: String(row.source_type || 'native') as AppSourceType,
      buildType: String(row.build_type || 'auto') as AppBuildType,
      branch: String(row.branch || 'main'),
      dockerfilePath: String(row.dockerfile_path || 'Dockerfile'),
      buildContext: String(row.build_context || '.'),
      startCommand: String(row.start_command || ''),
      workingDir: String(row.working_dir || ''),
      envScope: String(row.env_scope || 'production') as EnvironmentScopeName,
      healthCheck: { ...DEFAULT_HC, ...hcParsed },
      activeDeploymentId: row.active_deployment_id ? String(row.active_deployment_id) : null,
      archivedAt: row.archived_at ? String(row.archived_at) : null,
      config: JSON.parse(String(row.config_json || '{}')) as Record<string, unknown>,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }

  private mapSourceRow(row: Record<string, unknown>): ApplicationSourceRecord {
    return {
      id: String(row.id),
      applicationId: String(row.application_id),
      provider: String(row.provider || 'git') as GitProviderName,
      repoUrl: String(row.repo_url),
      branch: String(row.branch || 'main'),
      hasToken: Boolean(row.token_enc),
      hasWebhookSecret: Boolean(row.webhook_secret_enc),
      lastCommitSha: row.last_commit_sha ? String(row.last_commit_sha) : null,
      lastCommitMessage: row.last_commit_message ? String(row.last_commit_message) : null,
      lastDeliveryId: row.last_delivery_id ? String(row.last_delivery_id) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }
}
