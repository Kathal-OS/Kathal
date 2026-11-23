# KATHAL OS — Phase 1.5 Release Notes

Phase 1.5 evolves KATHAL OS from a single-admin, flat-JSON Phase 1 prototype into a multi-user, RBAC-governed, SQLite-backed control plane ready for team collaboration and multi-server expansion while preserving 100% of existing host runtime features and Phase 0/1 API compatibility.

---

## Highlights & Architectural Changes

### 1. Embedded SQLite Persistence (`src/database/`)
- Added `DatabaseManager` using Node.js 22 `node:sqlite` stored at `KATHAL_DATA_DIR/kathal.db` with WAL mode, `PRAGMA foreign_keys = ON`, transactional migrations (`schema_migrations`), integrity checks, and online hot backups (`src/routes/databaseAdminRoutes.ts`).
- Defined normalized schema (`001_initial_schema`) spanning users, roles, permissions, sessions, API tokens, password resets, servers, server groups/history, applications, deployments, containers, databases, domains, certificates, secrets, backups, workflows, plugins, notifications, audit events, Git repos/logs, compose projects, networks, volumes, registries, and settings.
- Implemented idempotent `migrateLegacyJsonToSqlite()` importing Phase 1 `auth-state.json`, `platform-state.json`, and `audit-log.json` after pre-validation and pre-migration DB snapshot while retaining original JSON files safely.

### 2. Multi-User Authentication & Revocable Sessions (`src/auth/`, `src/security/password.ts`, `src/middleware/authMiddleware.ts`)
- Upgraded password hashing to memory-hard OpenSSL `crypto.scrypt` (`$scrypt$v=1$N=32768,r=8,p=1$...`) with seamless login verification and automatic rehash for legacy `bcryptjs` accounts.
- Replaced stateless 72h JWTs with revocable SHA-256-hashed sessions supporting both `HttpOnly` cookie (`kathal_session`) and `Bearer ks_...` tokens, sliding idle expiry (`KATHAL_SESSION_IDLE_HOURS`), hard max expiry (`KATHAL_SESSION_MAX_HOURS`), and CSRF Origin/`X-Requested-With` enforcement on cookie mutations.
- Added user lifecycle endpoints (`POST /api/v1/auth/logout`, `/change-password`, `/auth/sessions`, `/auth/password-reset/request|confirm`, `/users/*`), administrator-gated self-registration (`KATHAL_ALLOW_SELF_REGISTRATION`, default `false`), and automatic WebSocket closure (`4001`) when a session is revoked.

### 3. Five-Role, 26-Permission RBAC (`src/auth/rbac.ts`, `src/routes/userRoutes.ts`)
- Added default system roles (`Owner`, `Administrator`, `Operator`, `Developer`, `Viewer`) backed by 26 granular backend permissions enforced via `requirePermission(...)`.
- Protected privilege boundaries against self-role escalation, non-Owner assignment of `Owner`, and removal/deactivation of the final active `Owner`.

### 4. Vault v2 Hardening (`src/security/vault.ts`, `src/routes/vaultRoutes.ts`)
- Upgraded secrets to `enc:v2:<kid>:<iv>:<tag>:<cipher>` binding key IDs as GCM AAD (with full `enc:v1:` backward decryption).
- Prevented silent `.vault-key` regeneration when encrypted records exist without a matching key (`VaultLockedError` + `GET /api/v1/vault/recovery`).
- Added Owner-only transactional key rotation (`POST /api/v1/vault/rotate`) and per-secret reveal/rotate APIs.

### 5. Modular Security Domains & Fleet Hardening
- Extracted modular services and routers across `src/config/`, `src/database/`, `src/repositories/`, `src/security/`, `src/auth/`, `src/audit/`, `src/fleet/`, `src/middleware/`, `src/websocket/`, and `src/routes/` (reducing `server.ts` from `3,789` to `3,551` lines while keeping existing app/runtime routes intact).
- Hardened `TerminalGateway` with `Origin` validation, `terminal.access` permission check, per-user active socket cap (`5`), user-bound terminal ownership, and immediate teardown on session logout/revocation.
- Enhanced `FleetService` with DNS-resolving SSRF checks (`resolveAndValidateTargetIp`, `KATHAL_FLEET_ALLOW_PRIVATE_NETWORKS`), per-node `agentToken` issuance/rotation, `POST /api/v1/fleet/agent/heartbeat`, and persistent `server_status_history`.
- Added SQLite-backed `AuditService` with `X-Request-Id` correlation IDs, recursive secret redaction, `audit.read` RBAC gate, and paginated/filterable queries (`GET /api/v1/audit?page=1&...`).

### 6. Theme-Aware & Permission-Aware Console (`web/src/`)
- Added Light/Dark theme toggle across Login, Sidebar, TopBar, and pages while maintaining KATHAL's jackfruit forest palette.
- Restored `HttpOnly` cookie sessions automatically on mount (`GET /api/v1/auth/session`).
- Added **Users & Roles** (`/users`), **Security & Vault** (`/security`), **Audit Logs** (`/audit`), **Access Denied** (`/access-denied`), and Fleet Status History / Agent Enrollment modals.

---

## Upgrade & Behavioral Notes
- **Self-Registration Default**: Unauthenticated account registration (`POST /api/v1/auth/register`) is **disabled (`403`)** unless `KATHAL_ALLOW_SELF_REGISTRATION=true` is set explicitly.
- **Session Tokens**: Because Phase 1.5 replaces stateless JWTs with database-backed sessions, active users sign in once after upgrading so a revocable session record is created in `kathal.db`.
- **Verification**: All **23 / 23 tests** across `tests/core.test.ts` (12) and `tests/phase1_5.test.ts` (11), TypeScript checks (`npm run lint`), and production Vite build (`npm run build`) pass cleanly.
