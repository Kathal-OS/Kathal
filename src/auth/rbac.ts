import type { DatabaseSync } from 'node:sqlite'

export interface PermissionDef {
  id: string
  name: string
  category: string
  description: string
}

export interface RoleDef {
  id: string
  name: 'Owner' | 'Administrator' | 'Operator' | 'Developer' | 'Viewer'
  description: string
  rank: number
  permissions: string[]
}

export const PERMISSIONS: PermissionDef[] = [
  { id: 'perm-dashboard-read', name: 'dashboard.read', category: 'Dashboard', description: 'View host overview and system metrics' },
  { id: 'perm-servers-read', name: 'servers.read', category: 'Fleet', description: 'View registered fleet servers and status history' },
  { id: 'perm-servers-create', name: 'servers.create', category: 'Fleet', description: 'Register new fleet servers' },
  { id: 'perm-servers-update', name: 'servers.update', category: 'Fleet', description: 'Probe servers and rotate agent tokens' },
  { id: 'perm-servers-delete', name: 'servers.delete', category: 'Fleet', description: 'Remove registered servers from inventory' },
  { id: 'perm-applications-read', name: 'applications.read', category: 'Applications', description: 'View installed apps, templates, and git repos' },
  { id: 'perm-applications-create', name: 'applications.create', category: 'Applications', description: 'Install new applications and add git repos' },
  { id: 'perm-applications-deploy', name: 'applications.deploy', category: 'Applications', description: 'Deploy and trigger builds/webhooks' },
  { id: 'perm-applications-restart', name: 'applications.restart', category: 'Applications', description: 'Start, stop, and restart applications and services' },
  { id: 'perm-applications-delete', name: 'applications.delete', category: 'Applications', description: 'Uninstall applications and delete deployments' },
  { id: 'perm-containers-read', name: 'containers.read', category: 'Workloads', description: 'Inspect running workloads, images, networks, and logs' },
  { id: 'perm-containers-manage', name: 'containers.manage', category: 'Workloads', description: 'Manage workloads, compose stacks, volumes, and networks' },
  { id: 'perm-databases-read', name: 'databases.read', category: 'Databases', description: 'View managed databases and status' },
  { id: 'perm-databases-manage', name: 'databases.manage', category: 'Databases', description: 'Create, start/stop, delete, and read DB connection strings' },
  { id: 'perm-secrets-read', name: 'secrets.read', category: 'Security', description: 'List environment keys and masked credentials' },
  { id: 'perm-secrets-reveal', name: 'secrets.reveal', category: 'Security', description: 'Reveal, create, update, rotate, and delete sensitive secrets' },
  { id: 'perm-users-read', name: 'users.read', category: 'Identity', description: 'View users, roles, and active sessions' },
  { id: 'perm-users-manage', name: 'users.manage', category: 'Identity', description: 'Create/deactivate users, assign roles, and revoke sessions' },
  { id: 'perm-settings-read', name: 'settings.read', category: 'Settings', description: 'Read platform, proxy, and system database status' },
  { id: 'perm-settings-manage', name: 'settings.manage', category: 'Settings', description: 'Modify platform settings, proxy domains, and database ops' },
  { id: 'perm-audit-read', name: 'audit.read', category: 'Security', description: 'Query persistent security and operational audit logs' },
  { id: 'perm-backups-create', name: 'backups.create', category: 'Backups', description: 'Create and export backup archives' },
  { id: 'perm-backups-restore', name: 'backups.restore', category: 'Backups', description: 'Import or restore backup snapshots' },
  { id: 'perm-plugins-manage', name: 'plugins.manage', category: 'Ecosystem', description: 'Manage plugins and container registries' },
  { id: 'perm-workflows-manage', name: 'workflows.manage', category: 'Automation', description: 'Manage automation workflows and files' },
  { id: 'perm-terminal-access', name: 'terminal.access', category: 'Operations', description: 'Open authenticated interactive node terminal sessions' },
  // Phase 2 Granular Permissions
  { id: 'perm-apps-read', name: 'apps.read', category: 'Applications', description: 'Read managed applications, sources, and health status' },
  { id: 'perm-apps-create', name: 'apps.create', category: 'Applications', description: 'Create managed applications and configure Git sources' },
  { id: 'perm-apps-update', name: 'apps.update', category: 'Applications', description: 'Modify application configuration, health checks, and restart policies' },
  { id: 'perm-apps-delete', name: 'apps.delete', category: 'Applications', description: 'Archive or delete managed applications' },
  { id: 'perm-apps-deploy', name: 'apps.deploy', category: 'Applications', description: 'Trigger builds and deployments for managed applications' },
  { id: 'perm-deployments-read', name: 'deployments.read', category: 'Deployments', description: 'View deployment history, stage status, and build logs' },
  { id: 'perm-deployments-create', name: 'deployments.create', category: 'Deployments', description: 'Trigger new deployments and webhooks' },
  { id: 'perm-deployments-cancel', name: 'deployments.cancel', category: 'Deployments', description: 'Cancel active or queued deployments' },
  { id: 'perm-deployments-rollback', name: 'deployments.rollback', category: 'Deployments', description: 'Rollback applications to prior verified deployment snapshots' },
  { id: 'perm-compose-read', name: 'compose.read', category: 'Workloads', description: 'Inspect compose projects and validate YAML stacks' },
  { id: 'perm-compose-manage', name: 'compose.manage', category: 'Workloads', description: 'Create, start, stop, restart, and remove compose stacks' },
  { id: 'perm-domains-read', name: 'domains.read', category: 'Networking', description: 'View reverse proxy domains and routing rules' },
  { id: 'perm-domains-manage', name: 'domains.manage', category: 'Networking', description: 'Configure reverse proxy domains, adapters, and TLS flags' },
  { id: 'perm-certificates-read', name: 'certificates.read', category: 'Networking', description: 'View TLS certificates and ACME challenge states' },
  { id: 'perm-certificates-manage', name: 'certificates.manage', category: 'Networking', description: 'Issue, verify, renew, and revoke TLS certificates' },
  { id: 'perm-databases-create', name: 'databases.create', category: 'Databases', description: 'Provision managed PostgreSQL, MySQL, and Redis instances' },
  { id: 'perm-databases-delete', name: 'databases.delete', category: 'Databases', description: 'Deprovision and delete managed database instances' },
  { id: 'perm-environments-read', name: 'environments.read', category: 'Security', description: 'List scoped development/staging/production environment keys' },
  { id: 'perm-environments-manage', name: 'environments.manage', category: 'Security', description: 'Create, update, import, and delete environment variables' },
  { id: 'perm-environments-reveal', name: 'environments.reveal', category: 'Security', description: 'Reveal encrypted environment secret values' },
  { id: 'perm-jobs-read', name: 'jobs.read', category: 'Operations', description: 'View background job queue, leases, and attempt history' },
  { id: 'perm-jobs-manage', name: 'jobs.manage', category: 'Operations', description: 'Retry or cancel background jobs' },
]

const ALL_PERMISSION_NAMES = PERMISSIONS.map((p) => p.name)

export const SYSTEM_ROLES: RoleDef[] = [
  {
    id: 'role-owner',
    name: 'Owner',
    description: 'Full platform ownership including vault key rotation, owner assignment, and system recovery.',
    rank: 100,
    permissions: ALL_PERMISSION_NAMES,
  },
  {
    id: 'role-admin',
    name: 'Administrator',
    description: 'Manages servers, applications, users, settings, and daily infrastructure operations.',
    rank: 80,
    permissions: ALL_PERMISSION_NAMES,
  },
  {
    id: 'role-operator',
    name: 'Operator',
    description: 'Deploys applications, manages running services/containers/databases, probes fleet, and accesses terminal.',
    rank: 60,
    permissions: [
      'dashboard.read',
      'servers.read',
      'servers.update',
      'applications.read',
      'applications.deploy',
      'applications.restart',
      'apps.read',
      'apps.update',
      'apps.deploy',
      'deployments.read',
      'deployments.create',
      'deployments.cancel',
      'deployments.rollback',
      'containers.read',
      'containers.manage',
      'compose.read',
      'compose.manage',
      'domains.read',
      'domains.manage',
      'certificates.read',
      'certificates.manage',
      'databases.read',
      'databases.manage',
      'databases.create',
      'secrets.read',
      'environments.read',
      'settings.read',
      'jobs.read',
      'jobs.manage',
      'backups.create',
      'terminal.access',
    ],
  },
  {
    id: 'role-developer',
    name: 'Developer',
    description: 'Deploys and restarts permitted applications, reads logs/metrics, and manages environment keys.',
    rank: 40,
    permissions: [
      'dashboard.read',
      'servers.read',
      'applications.read',
      'applications.create',
      'applications.deploy',
      'applications.restart',
      'apps.read',
      'apps.create',
      'apps.update',
      'apps.deploy',
      'deployments.read',
      'deployments.create',
      'deployments.cancel',
      'deployments.rollback',
      'containers.read',
      'compose.read',
      'domains.read',
      'certificates.read',
      'databases.read',
      'secrets.read',
      'environments.read',
      'environments.manage',
      'jobs.read',
      'settings.read',
    ],
  },
  {
    id: 'role-viewer',
    name: 'Viewer',
    description: 'Read-only visibility across dashboard metrics, fleet status, applications, and logs.',
    rank: 10,
    permissions: [
      'dashboard.read',
      'servers.read',
      'applications.read',
      'apps.read',
      'deployments.read',
      'containers.read',
      'compose.read',
      'domains.read',
      'certificates.read',
      'databases.read',
      'secrets.read',
      'environments.read',
      'jobs.read',
      'settings.read',
    ],
  },
]

export class RbacService {
  private db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  seedDefaults(): void {
    const now = new Date().toISOString()
    const permIdByName = new Map<string, string>()

    const insertPerm = this.db.prepare(
      `INSERT OR IGNORE INTO permissions (id, name, category, description) VALUES (?, ?, ?, ?)`
    )
    for (const p of PERMISSIONS) {
      insertPerm.run(p.id, p.name, p.category, p.description)
      permIdByName.set(p.name, p.id)
    }

    const insertRole = this.db.prepare(
      `INSERT OR IGNORE INTO roles (id, name, description, is_system, rank, created_at) VALUES (?, ?, ?, 1, ?, ?)`
    )
    const insertRolePerm = this.db.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)`
    )

    for (const role of SYSTEM_ROLES) {
      insertRole.run(role.id, role.name, role.description, role.rank, now)
      for (const permName of role.permissions) {
        const permId = permIdByName.get(permName)
        if (permId) insertRolePerm.run(role.id, permId)
      }
    }
  }

  listRoles(): Array<{
    id: string
    name: string
    description: string
    isSystem: boolean
    rank: number
    permissions: string[]
    userCount: number
  }> {
    const roles = this.db
      .prepare('SELECT id, name, description, is_system, rank FROM roles ORDER BY rank DESC, name ASC')
      .all() as Array<{ id: string; name: string; description: string; is_system: number; rank: number }>

    return roles.map((r) => {
      const perms = this.db
        .prepare(
          `SELECT p.name FROM permissions p
           JOIN role_permissions rp ON rp.permission_id = p.id
           WHERE rp.role_id = ?
           ORDER BY p.name ASC`
        )
        .all(r.id) as Array<{ name: string }>
      const cnt = this.db
        .prepare('SELECT COUNT(*) as cnt FROM user_roles WHERE role_id = ?')
        .get(r.id) as { cnt: number }
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        isSystem: Boolean(r.is_system),
        rank: r.rank,
        permissions: perms.map((p) => p.name),
        userCount: cnt.cnt,
      }
    })
  }

  listPermissions(): PermissionDef[] {
    return this.db
      .prepare('SELECT id, name, category, description FROM permissions ORDER BY category ASC, name ASC')
      .all() as unknown as PermissionDef[]
  }

  getUserRoles(userId: string): Array<{ id: string; name: string; rank: number }> {
    return this.db
      .prepare(
        `SELECT r.id, r.name, r.rank
         FROM roles r
         JOIN user_roles ur ON ur.role_id = r.id
         WHERE ur.user_id = ?
         ORDER BY r.rank DESC`
      )
      .all(userId) as Array<{ id: string; name: string; rank: number }>
  }

  getUserPermissions(userId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT p.name
         FROM permissions p
         JOIN role_permissions rp ON rp.permission_id = p.id
         JOIN user_roles ur ON ur.role_id = rp.role_id
         WHERE ur.user_id = ?
         ORDER BY p.name ASC`
      )
      .all(userId) as Array<{ name: string }>
    return rows.map((r) => r.name)
  }

  countActiveOwners(excludeUserId?: string): number {
    if (excludeUserId) {
      const row = this.db
        .prepare(
          `SELECT COUNT(DISTINCT u.id) as cnt
           FROM users u
           JOIN user_roles ur ON ur.user_id = u.id
           WHERE ur.role_id = 'role-owner' AND u.is_active = 1 AND u.id != ?`
        )
        .get(excludeUserId) as { cnt: number }
      return row.cnt
    }
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT u.id) as cnt
         FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         WHERE ur.role_id = 'role-owner' AND u.is_active = 1`
      )
      .get() as { cnt: number }
    return row.cnt
  }

  resolveRoleIds(roleInputs: string[]): string[] {
    const resolved: string[] = []
    for (const raw of roleInputs) {
      const val = raw.trim()
      if (!val) continue
      const row = this.db
        .prepare('SELECT id FROM roles WHERE id = ? OR LOWER(name) = LOWER(?)')
        .get(val, val) as { id: string } | undefined
      if (row && !resolved.includes(row.id)) {
        resolved.push(row.id)
      }
    }
    return resolved
  }

  assignRoles(targetUserId: string, roleInputs: string[], actorUserId: string): void {
    const roleIds = this.resolveRoleIds(roleInputs)
    if (roleIds.length === 0) {
      throw new Error('At least one valid role must be assigned.')
    }

    const currentRoles = this.getUserRoles(targetUserId)
    const currentlyOwner = currentRoles.some((r) => r.id === 'role-owner')
    const willBeOwner = roleIds.includes('role-owner')

    // Prevent removing the final active Owner
    if (currentlyOwner && !willBeOwner && this.countActiveOwners(targetUserId) === 0) {
      throw new Error('Cannot remove Owner role from the final active platform Owner.')
    }

    // Only an Owner may grant or revoke the Owner role
    const actorRoles = this.getUserRoles(actorUserId)
    const actorIsOwner = actorRoles.some((r) => r.id === 'role-owner')
    if (!actorIsOwner && (willBeOwner || currentlyOwner)) {
      throw new Error('Only an existing Owner can assign or modify the Owner role.')
    }

    const now = new Date().toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(targetUserId)
      const insert = this.db.prepare(
        'INSERT INTO user_roles (user_id, role_id, assigned_by, assigned_at) VALUES (?, ?, ?, ?)'
      )
      for (const rid of roleIds) {
        insert.run(targetUserId, rid, actorUserId, now)
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }
}
