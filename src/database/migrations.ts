import type { DatabaseSync } from 'node:sqlite'
import crypto from 'node:crypto'

export interface MigrationDef {
  version: number
  name: string
  up: (db: DatabaseSync) => void
  down: (db: DatabaseSync) => void
}

const MIGRATION_001_SQL = `
  CREATE TABLE IF NOT EXISTS vault_keys (
    kid TEXT PRIMARY KEY,
    algorithm TEXT NOT NULL DEFAULT 'aes-256-gcm',
    source TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active','retired')),
    created_at TEXT NOT NULL,
    rotated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    last_login_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);

  CREATE TABLE IF NOT EXISTS roles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    is_system INTEGER NOT NULL DEFAULT 1,
    rank INTEGER NOT NULL DEFAULT 10,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS permissions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS role_permissions (
    role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
  );
  CREATE INDEX IF NOT EXISTS idx_role_permissions_perm ON role_permissions(permission_id);

  CREATE TABLE IF NOT EXISTS user_roles (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    assigned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    assigned_at TEXT NOT NULL,
    PRIMARY KEY (user_id, role_id)
  );
  CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(role_id);

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    auth_method TEXT NOT NULL DEFAULT 'cookie_or_bearer',
    ip_address TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    idle_expires_at TEXT NOT NULL,
    absolute_expires_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
  CREATE INDEX IF NOT EXISTS idx_sessions_revoked ON sessions(revoked_at);

  CREATE TABLE IF NOT EXISTS api_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_prefix TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    scopes_json TEXT NOT NULL DEFAULT '[]',
    expires_at TEXT,
    last_used_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);

  CREATE TABLE IF NOT EXISTS password_resets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS server_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22,
    auth_method TEXT NOT NULL DEFAULT 'ssh-key',
    role TEXT NOT NULL DEFAULT 'worker',
    group_id TEXT REFERENCES server_groups(id) ON DELETE SET NULL,
    group_name TEXT NOT NULL DEFAULT 'default',
    tags_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending',
    is_local INTEGER NOT NULL DEFAULT 0,
    os TEXT NOT NULL DEFAULT '',
    arch TEXT NOT NULL DEFAULT '',
    owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    agent_id TEXT UNIQUE,
    agent_token_hash TEXT,
    agent_token_rotated_at TEXT,
    agent_version TEXT,
    last_heartbeat_at TEXT,
    last_checked_at TEXT,
    latency_ms INTEGER,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_servers_owner ON servers(owner_user_id);
  CREATE INDEX IF NOT EXISTS idx_servers_status ON servers(status);

  CREATE TABLE IF NOT EXISTS server_status_history (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    latency_ms INTEGER,
    cpu_percent REAL,
    memory_percent REAL,
    disk_percent REAL,
    detail TEXT,
    checked_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_server_history_server_time ON server_status_history(server_id, checked_at DESC);

  CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    server_id TEXT REFERENCES servers(id) ON DELETE CASCADE,
    owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    runtime TEXT NOT NULL DEFAULT 'node',
    image TEXT NOT NULL DEFAULT '',
    port INTEGER NOT NULL DEFAULT 3000,
    status TEXT NOT NULL DEFAULT 'stopped',
    config_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_apps_server ON applications(server_id);
  CREATE INDEX IF NOT EXISTS idx_apps_owner ON applications(owner_user_id);

  CREATE TABLE IF NOT EXISTS deployments (
    id TEXT PRIMARY KEY,
    application_id TEXT REFERENCES applications(id) ON DELETE CASCADE,
    server_id TEXT REFERENCES servers(id) ON DELETE SET NULL,
    triggered_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    commit_sha TEXT,
    status TEXT NOT NULL,
    logs TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_deployments_app ON deployments(application_id);

  CREATE TABLE IF NOT EXISTS containers (
    id TEXT PRIMARY KEY,
    application_id TEXT REFERENCES applications(id) ON DELETE SET NULL,
    server_id TEXT REFERENCES servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    image TEXT NOT NULL,
    state TEXT NOT NULL,
    status_text TEXT NOT NULL DEFAULT '',
    ports_json TEXT NOT NULL DEFAULT '[]',
    volumes_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS databases (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    port INTEGER NOT NULL,
    username TEXT NOT NULL,
    password_enc TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'running',
    server_id TEXT REFERENCES servers(id) ON DELETE SET NULL,
    owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS domains (
    id TEXT PRIMARY KEY,
    domain TEXT NOT NULL UNIQUE,
    target TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 80,
    ssl INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    application_id TEXT REFERENCES applications(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS certificates (
    id TEXT PRIMARY KEY,
    domain_id TEXT REFERENCES domains(id) ON DELETE CASCADE,
    common_name TEXT NOT NULL,
    issuer TEXT NOT NULL DEFAULT 'self-signed',
    status TEXT NOT NULL DEFAULT 'pending',
    expires_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS secrets (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL DEFAULT 'global',
    application_id TEXT REFERENCES applications(id) ON DELETE CASCADE,
    key_name TEXT NOT NULL,
    value_enc TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    is_secret INTEGER NOT NULL DEFAULT 1,
    key_version TEXT NOT NULL DEFAULT 'vk-v1',
    rotated_at TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(scope, key_name)
  );
  CREATE INDEX IF NOT EXISTS idx_secrets_key ON secrets(key_name);

  CREATE TABLE IF NOT EXISTS backups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    size_label TEXT NOT NULL DEFAULT '0 KB',
    kind TEXT NOT NULL DEFAULT 'snapshot',
    file_path TEXT,
    checksum TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    trigger_event TEXT NOT NULL,
    actions_json TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1,
    owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS plugins (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    version TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    permissions_json TEXT NOT NULL DEFAULT '[]',
    config_json TEXT NOT NULL DEFAULT '{}',
    installed_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    level TEXT NOT NULL DEFAULT 'info',
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    read_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);

  CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    actor_email TEXT NOT NULL DEFAULT 'system',
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL DEFAULT 'system',
    resource_id TEXT NOT NULL DEFAULT '',
    outcome TEXT NOT NULL CHECK(outcome IN ('success','denied','error')),
    source_ip TEXT NOT NULL DEFAULT '',
    correlation_id TEXT NOT NULL DEFAULT '',
    detail TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_events(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_events(action);
  CREATE INDEX IF NOT EXISTS idx_audit_outcome ON audit_events(outcome);
  CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_events(user_id);
  CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_events(resource_type, resource_id);

  CREATE TABLE IF NOT EXISTS system_settings (
    id TEXT PRIMARY KEY DEFAULT 'default',
    server_name TEXT NOT NULL,
    server_domain TEXT NOT NULL,
    wildcard_domain TEXT NOT NULL,
    lets_encrypt_email TEXT NOT NULL,
    auto_ssl INTEGER NOT NULL DEFAULT 1,
    force_https INTEGER NOT NULL DEFAULT 1,
    auto_deploy_webhook INTEGER NOT NULL DEFAULT 1,
    prune_stopped_after_deploy INTEGER NOT NULL DEFAULT 0,
    default_deploy_strategy TEXT NOT NULL DEFAULT 'rolling',
    webhook_secret_enc TEXT NOT NULL DEFAULT '',
    cpu_alert_threshold INTEGER NOT NULL DEFAULT 85,
    memory_alert_threshold INTEGER NOT NULL DEFAULT 85,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS git_repos (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    branch TEXT NOT NULL DEFAULT 'main',
    deploy_cmd TEXT NOT NULL DEFAULT '',
    domain TEXT,
    port INTEGER,
    container_id TEXT,
    status TEXT NOT NULL DEFAULT 'idle',
    last_deploy TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS git_deploy_logs (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES git_repos(id) ON DELETE CASCADE,
    timestamp TEXT NOT NULL,
    commit_sha TEXT,
    output TEXT,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_git_logs_repo ON git_deploy_logs(repo_id);

  CREATE TABLE IF NOT EXISTS compose_projects (
    name TEXT PRIMARY KEY,
    working_dir TEXT NOT NULL,
    file_path TEXT,
    status TEXT NOT NULL DEFAULT 'created',
    services_json TEXT NOT NULL DEFAULT '[]',
    config TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS networks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    driver TEXT NOT NULL DEFAULT 'host',
    scope TEXT NOT NULL DEFAULT 'local',
    internal INTEGER NOT NULL DEFAULT 0,
    attachable INTEGER NOT NULL DEFAULT 0,
    ingress INTEGER NOT NULL DEFAULT 0,
    containers_json TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS volumes (
    name TEXT PRIMARY KEY,
    driver TEXT NOT NULL DEFAULT 'local',
    mountpoint TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'local',
    size_bytes INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS registries (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    registry_url TEXT NOT NULL,
    username TEXT NOT NULL,
    password_enc TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'connected',
    created_at TEXT NOT NULL,
    last_used_at TEXT
  );

  CREATE TABLE IF NOT EXISTS migration_runs (
    id TEXT PRIMARY KEY,
    source_name TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    records_imported INTEGER NOT NULL DEFAULT 0,
    details_json TEXT NOT NULL DEFAULT '{}',
    completed_at TEXT NOT NULL
  );
`

const MIGRATION_001_DOWN_SQL = `
  DROP TABLE IF EXISTS migration_runs;
  DROP TABLE IF EXISTS registries;
  DROP TABLE IF EXISTS volumes;
  DROP TABLE IF EXISTS networks;
  DROP TABLE IF EXISTS compose_projects;
  DROP TABLE IF EXISTS git_deploy_logs;
  DROP TABLE IF EXISTS git_repos;
  DROP TABLE IF EXISTS system_settings;
  DROP TABLE IF EXISTS audit_events;
  DROP TABLE IF EXISTS notifications;
  DROP TABLE IF EXISTS plugins;
  DROP TABLE IF EXISTS workflows;
  DROP TABLE IF EXISTS backups;
  DROP TABLE IF EXISTS secrets;
  DROP TABLE IF EXISTS certificates;
  DROP TABLE IF EXISTS domains;
  DROP TABLE IF EXISTS databases;
  DROP TABLE IF EXISTS containers;
  DROP TABLE IF EXISTS deployments;
  DROP TABLE IF EXISTS applications;
  DROP TABLE IF EXISTS server_status_history;
  DROP TABLE IF EXISTS servers;
  DROP TABLE IF EXISTS server_groups;
  DROP TABLE IF EXISTS password_resets;
  DROP TABLE IF EXISTS api_tokens;
  DROP TABLE IF EXISTS sessions;
  DROP TABLE IF EXISTS user_roles;
  DROP TABLE IF EXISTS role_permissions;
  DROP TABLE IF EXISTS permissions;
  DROP TABLE IF EXISTS roles;
  DROP TABLE IF EXISTS users;
  DROP TABLE IF EXISTS vault_keys;
`

const MIGRATION_002_SQL = `
  ALTER TABLE applications ADD COLUMN slug TEXT;
  ALTER TABLE applications ADD COLUMN description TEXT NOT NULL DEFAULT '';
  ALTER TABLE applications ADD COLUMN source_type TEXT NOT NULL DEFAULT 'native';
  ALTER TABLE applications ADD COLUMN build_type TEXT NOT NULL DEFAULT 'auto';
  ALTER TABLE applications ADD COLUMN branch TEXT NOT NULL DEFAULT 'main';
  ALTER TABLE applications ADD COLUMN dockerfile_path TEXT NOT NULL DEFAULT 'Dockerfile';
  ALTER TABLE applications ADD COLUMN build_context TEXT NOT NULL DEFAULT '.';
  ALTER TABLE applications ADD COLUMN start_command TEXT NOT NULL DEFAULT '';
  ALTER TABLE applications ADD COLUMN working_dir TEXT NOT NULL DEFAULT '';
  ALTER TABLE applications ADD COLUMN env_scope TEXT NOT NULL DEFAULT 'production';
  ALTER TABLE applications ADD COLUMN health_check_json TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE applications ADD COLUMN restart_policy_json TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE applications ADD COLUMN active_deployment_id TEXT;
  ALTER TABLE applications ADD COLUMN archived_at TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_slug ON applications(slug) WHERE slug IS NOT NULL;

  CREATE TABLE IF NOT EXISTS application_sources (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL UNIQUE REFERENCES applications(id) ON DELETE CASCADE,
    provider TEXT NOT NULL DEFAULT 'git',
    repo_url TEXT NOT NULL,
    branch TEXT NOT NULL DEFAULT 'main',
    token_enc TEXT NOT NULL DEFAULT '',
    deploy_key_enc TEXT NOT NULL DEFAULT '',
    webhook_secret_enc TEXT NOT NULL DEFAULT '',
    last_commit_sha TEXT,
    last_commit_message TEXT,
    last_delivery_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS application_environments (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    environment TEXT NOT NULL CHECK(environment IN ('development','staging','production')),
    key_name TEXT NOT NULL,
    value_enc TEXT NOT NULL DEFAULT '',
    is_secret INTEGER NOT NULL DEFAULT 1,
    description TEXT NOT NULL DEFAULT '',
    key_version TEXT NOT NULL DEFAULT 'vk-v1',
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(application_id, environment, key_name)
  );
  CREATE INDEX IF NOT EXISTS idx_app_env_app_scope ON application_environments(application_id, environment);

  ALTER TABLE deployments ADD COLUMN trigger_type TEXT NOT NULL DEFAULT 'manual';
  ALTER TABLE deployments ADD COLUMN job_id TEXT;
  ALTER TABLE deployments ADD COLUMN rollback_of_id TEXT;
  ALTER TABLE deployments ADD COLUMN commit_message TEXT;
  ALTER TABLE deployments ADD COLUMN branch TEXT;
  ALTER TABLE deployments ADD COLUMN environment TEXT NOT NULL DEFAULT 'production';
  ALTER TABLE deployments ADD COLUMN build_type TEXT NOT NULL DEFAULT 'auto';
  ALTER TABLE deployments ADD COLUMN stage TEXT NOT NULL DEFAULT 'queued';
  ALTER TABLE deployments ADD COLUMN artifact_path TEXT;
  ALTER TABLE deployments ADD COLUMN image_ref TEXT;
  ALTER TABLE deployments ADD COLUMN runtime_target_id TEXT;
  ALTER TABLE deployments ADD COLUMN port INTEGER;
  ALTER TABLE deployments ADD COLUMN error_detail TEXT;
  ALTER TABLE deployments ADD COLUMN duration_ms INTEGER;
  CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status);
  CREATE INDEX IF NOT EXISTS idx_deployments_started ON deployments(started_at DESC);

  CREATE TABLE IF NOT EXISTS deployment_logs (
    id TEXT PRIMARY KEY,
    deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    stage TEXT NOT NULL DEFAULT 'deploying',
    stream TEXT NOT NULL DEFAULT 'info',
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_deployment_logs_dep ON deployment_logs(deployment_id, seq ASC);

  CREATE TABLE IF NOT EXISTS deployment_events (
    id TEXT PRIMARY KEY,
    deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
    stage TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_deployment_events_dep ON deployment_events(deployment_id, created_at ASC);

  CREATE TABLE IF NOT EXISTS deployment_snapshots (
    id TEXT PRIMARY KEY,
    deployment_id TEXT NOT NULL UNIQUE REFERENCES deployments(id) ON DELETE CASCADE,
    application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    commit_sha TEXT,
    environment TEXT NOT NULL DEFAULT 'production',
    config_json TEXT NOT NULL DEFAULT '{}',
    env_snapshot_enc TEXT NOT NULL DEFAULT '',
    artifact_path TEXT,
    image_ref TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_deployment_snapshots_app ON deployment_snapshots(application_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS background_jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    dedupe_key TEXT,
    status TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    result_json TEXT,
    error_message TEXT,
    attempt INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 1,
    lease_owner TEXT,
    lease_expires_at TEXT,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON background_jobs(status, created_at ASC);
  CREATE INDEX IF NOT EXISTS idx_jobs_target ON background_jobs(target_type, target_id);
  CREATE INDEX IF NOT EXISTS idx_jobs_dedupe ON background_jobs(dedupe_key, status);

  CREATE TABLE IF NOT EXISTS job_attempts (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES background_jobs(id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL,
    status TEXT NOT NULL,
    error_message TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_job_attempts_job ON job_attempts(job_id, attempt ASC);

  CREATE TABLE IF NOT EXISTS health_checks (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL UNIQUE REFERENCES applications(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 1,
    check_type TEXT NOT NULL DEFAULT 'http',
    path TEXT NOT NULL DEFAULT '/',
    port INTEGER,
    interval_seconds INTEGER NOT NULL DEFAULT 30,
    timeout_seconds INTEGER NOT NULL DEFAULT 5,
    failure_threshold INTEGER NOT NULL DEFAULT 3,
    recovery_threshold INTEGER NOT NULL DEFAULT 2,
    auto_restart INTEGER NOT NULL DEFAULT 1,
    max_restarts INTEGER NOT NULL DEFAULT 3,
    restart_window_seconds INTEGER NOT NULL DEFAULT 300,
    current_state TEXT NOT NULL DEFAULT 'unknown',
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    consecutive_successes INTEGER NOT NULL DEFAULT 0,
    restart_count INTEGER NOT NULL DEFAULT 0,
    restart_window_started_at TEXT,
    last_checked_at TEXT,
    last_error TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS health_check_results (
    id TEXT PRIMARY KEY,
    health_check_id TEXT NOT NULL REFERENCES health_checks(id) ON DELETE CASCADE,
    application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    state TEXT NOT NULL,
    latency_ms INTEGER,
    status_code INTEGER,
    detail TEXT,
    checked_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_hc_results_app_time ON health_check_results(application_id, checked_at DESC);

  ALTER TABLE domains ADD COLUMN proxy_adapter TEXT NOT NULL DEFAULT 'builtin';
  ALTER TABLE domains ADD COLUMN force_https INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE domains ADD COLUMN validated INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE domains ADD COLUMN last_error TEXT;

  ALTER TABLE certificates ADD COLUMN san_domains_json TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE certificates ADD COLUMN acme_mode TEXT NOT NULL DEFAULT 'self-signed';
  ALTER TABLE certificates ADD COLUMN acme_directory TEXT NOT NULL DEFAULT 'staging';
  ALTER TABLE certificates ADD COLUMN challenge_token TEXT;
  ALTER TABLE certificates ADD COLUMN challenge_auth TEXT;
  ALTER TABLE certificates ADD COLUMN key_enc TEXT NOT NULL DEFAULT '';
  ALTER TABLE certificates ADD COLUMN cert_pem TEXT NOT NULL DEFAULT '';
  ALTER TABLE certificates ADD COLUMN chain_pem TEXT NOT NULL DEFAULT '';
  ALTER TABLE certificates ADD COLUMN auto_renew INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE certificates ADD COLUMN last_error TEXT;
  ALTER TABLE certificates ADD COLUMN verified_at TEXT;
  ALTER TABLE certificates ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
  CREATE INDEX IF NOT EXISTS idx_certs_challenge_token ON certificates(challenge_token);

  CREATE TABLE IF NOT EXISTS database_instances (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    engine TEXT NOT NULL CHECK(engine IN ('postgres','mysql','mariadb','redis','mongodb')),
    version TEXT NOT NULL DEFAULT 'latest',
    host TEXT NOT NULL DEFAULT '127.0.0.1',
    port INTEGER NOT NULL,
    username TEXT NOT NULL,
    password_enc TEXT NOT NULL DEFAULT '',
    database_name TEXT NOT NULL,
    runtime_mode TEXT NOT NULL DEFAULT 'unavailable',
    container_or_pid TEXT,
    internal_only INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'unavailable',
    verification_json TEXT NOT NULL DEFAULT '{}',
    last_error TEXT,
    owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    server_id TEXT REFERENCES servers(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_db_instances_status ON database_instances(status);

  CREATE TABLE IF NOT EXISTS webhook_deliveries (
    delivery_id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    event_type TEXT NOT NULL DEFAULT 'push',
    received_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_time ON webhook_deliveries(received_at DESC);
`

const MIGRATION_002_DOWN_SQL = `
  DROP TABLE IF EXISTS webhook_deliveries;
  DROP TABLE IF EXISTS database_instances;
  DROP INDEX IF EXISTS idx_certs_challenge_token;
  ALTER TABLE certificates DROP COLUMN updated_at;
  ALTER TABLE certificates DROP COLUMN verified_at;
  ALTER TABLE certificates DROP COLUMN last_error;
  ALTER TABLE certificates DROP COLUMN auto_renew;
  ALTER TABLE certificates DROP COLUMN chain_pem;
  ALTER TABLE certificates DROP COLUMN cert_pem;
  ALTER TABLE certificates DROP COLUMN key_enc;
  ALTER TABLE certificates DROP COLUMN challenge_auth;
  ALTER TABLE certificates DROP COLUMN challenge_token;
  ALTER TABLE certificates DROP COLUMN acme_directory;
  ALTER TABLE certificates DROP COLUMN acme_mode;
  ALTER TABLE certificates DROP COLUMN san_domains_json;

  ALTER TABLE domains DROP COLUMN last_error;
  ALTER TABLE domains DROP COLUMN validated;
  ALTER TABLE domains DROP COLUMN force_https;
  ALTER TABLE domains DROP COLUMN proxy_adapter;

  DROP TABLE IF EXISTS health_check_results;
  DROP TABLE IF EXISTS health_checks;
  DROP TABLE IF EXISTS job_attempts;
  DROP TABLE IF EXISTS background_jobs;
  DROP TABLE IF EXISTS deployment_snapshots;
  DROP TABLE IF EXISTS deployment_events;
  DROP TABLE IF EXISTS deployment_logs;
  DROP INDEX IF EXISTS idx_deployments_started;
  DROP INDEX IF EXISTS idx_deployments_status;
  ALTER TABLE deployments DROP COLUMN duration_ms;
  ALTER TABLE deployments DROP COLUMN error_detail;
  ALTER TABLE deployments DROP COLUMN port;
  ALTER TABLE deployments DROP COLUMN runtime_target_id;
  ALTER TABLE deployments DROP COLUMN image_ref;
  ALTER TABLE deployments DROP COLUMN artifact_path;
  ALTER TABLE deployments DROP COLUMN stage;
  ALTER TABLE deployments DROP COLUMN build_type;
  ALTER TABLE deployments DROP COLUMN environment;
  ALTER TABLE deployments DROP COLUMN branch;
  ALTER TABLE deployments DROP COLUMN commit_message;
  ALTER TABLE deployments DROP COLUMN rollback_of_id;
  ALTER TABLE deployments DROP COLUMN job_id;
  ALTER TABLE deployments DROP COLUMN trigger_type;

  DROP TABLE IF EXISTS application_environments;
  DROP TABLE IF EXISTS application_sources;
  DROP INDEX IF EXISTS idx_apps_slug;
  ALTER TABLE applications DROP COLUMN archived_at;
  ALTER TABLE applications DROP COLUMN active_deployment_id;
  ALTER TABLE applications DROP COLUMN restart_policy_json;
  ALTER TABLE applications DROP COLUMN health_check_json;
  ALTER TABLE applications DROP COLUMN env_scope;
  ALTER TABLE applications DROP COLUMN working_dir;
  ALTER TABLE applications DROP COLUMN start_command;
  ALTER TABLE applications DROP COLUMN build_context;
  ALTER TABLE applications DROP COLUMN dockerfile_path;
  ALTER TABLE applications DROP COLUMN branch;
  ALTER TABLE applications DROP COLUMN build_type;
  ALTER TABLE applications DROP COLUMN source_type;
  ALTER TABLE applications DROP COLUMN description;
  ALTER TABLE applications DROP COLUMN slug;
`

export const MIGRATIONS: MigrationDef[] = [
  {
    version: 1,
    name: '001_initial_schema',
    up: (db) => {
      db.exec(MIGRATION_001_SQL)
    },
    down: (db) => {
      db.exec(MIGRATION_001_DOWN_SQL)
    },
  },
  {
    version: 2,
    name: '002_phase2_infrastructure',
    up: (db) => {
      db.exec(MIGRATION_002_SQL)
    },
    down: (db) => {
      db.exec(MIGRATION_002_DOWN_SQL)
    },
  },
]

export function migrationChecksum(m: MigrationDef): string {
  return crypto
    .createHash('sha256')
    .update(`${m.version}:${m.name}:${m.up.toString()}`, 'utf8')
    .digest('hex')
    .slice(0, 16)
}
