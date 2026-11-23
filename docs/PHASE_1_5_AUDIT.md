# KATHAL OS — Phase 1.5 Mandatory Initial Audit

**Audit Date**: 2026-11-23  
**Workspace Version**: `0.1.0` (`Node.js v22.23.2`, TypeScript `5.7.2`, React `18.3.1`, Vite `8.3.8` root / `5.3.1` web workspace)  
**Baseline Verified Before Changes**:
- `npm run build`: Passed (`vite build` + `tsc --noEmit`)
- `npm run lint`: Passed (`tsc --noEmit`, 0 errors)
- `npm test`: Passed (`12 / 12` tests across `4` suites in `tests/core.test.ts`)
- `GET /api/v1/health`: `200 OK` with security headers; `GET /api/v1/services` unauthenticated: `401 Unauthorized`

---

## 1. Verified Existing Implementation Summary

| Domain | Verified Components | Current Reality |
| :--- | :--- | :--- |
| **Docs & Roadmap** | `docs/AUDIT_AND_ARCHITECTURE.md`, `walkthrough.md`, `README.md` | Accurate Phase 0/1 audit, architecture diagrams, 15 deliverables, and security PoC traces. |
| **CI & Packaging** | `.github/workflows/ci.yml`, `Dockerfile`, `docker-compose.yml` | Aligned with Node.js 22 on port `3000`, health check `/api/v1/health`, multi-stage Alpine Docker build, and tagged portable release tarballs. |
| **Persistence & Vault** | `src/persistence.ts` (`PersistenceManager`) | Atomic JSON writes (`auth-state.json`, `platform-state.json`, `audit-log.json`), AES-256-GCM field encryption (`enc:v1:...`), `.vault-key` (`0o600`) or `KATHAL_VAULT_KEY`. |
| **API Security** | `server.ts` | Baseline HTTP security headers, redacted `databases`/`env`/`settings` responses with audited reveal endpoints, constant-time HMAC-SHA256 Git webhooks, and 60s single-use WebSocket `wsTicket`. |
| **Fleet** | `server.ts` (`/api/v1/fleet/servers`), `Monitoring.jsx` | Local control-plane telemetry + remote node registration, TCP reachability probe, and basic metadata IP guard (`169.254.169.254`, `metadata.google.internal`). |
| **Tests** | `tests/core.test.ts` | 12 passing unit and HTTP/WS security integration tests running in isolated temp `KATHAL_DATA_DIR`. |

---

## 2. Findings Classified by Severity

### Critical

1. **Single-Admin Ephemeral JWT Authentication Without Revocable Server-Side Sessions (`server.ts:327-393, 178-203`)**
   - **Evidence**: `server.ts` authenticates a single administrator identity (`CONFIGURED_ADMIN_HASH` or `claimedAdmin`). Issued JWTs expire after `72h` with no `sessions` table, no logout endpoint, no session rotation, no password-change session invalidation, and no user account activation/deactivation checks. A compromised JWT remains valid until natural expiry even after password change or logout.
   - **Impact**: No multi-user accountability, no ability to revoke active compromised sessions, and no administrator policy controls.
   - **Recommended Fix**: Introduce normalized `users`, `sessions`, and `api_tokens` tables in SQLite; issue random session tokens (`HttpOnly; Secure; SameSite` cookie + Bearer session lookup); track idle/absolute expiration; invalidate sessions on logout and password change; enforce `is_active` and account lockout in DB.

2. **Absence of Backend Role-Based Access Control (RBAC) (`server.ts:178-203, 314-3525`)**
   - **Evidence**: `authMiddleware` attaches `{ id: 'admin', email, role: 'admin' }` without checking granular permissions on any `/api/v1/*` route. Every authenticated user has unconditional access to delete databases, reveal secrets, run WebSocket terminals, reset settings, and import backups.
   - **Impact**: Zero least-privilege isolation; impossible to safely onboard `Operator`, `Developer`, or `Viewer` team members.
   - **Recommended Fix**: Implement `roles`, `permissions`, `role_permissions`, and `user_roles` tables with the 5 standard roles (`Owner`, `Administrator`, `Operator`, `Developer`, `Viewer`) and granular permission middleware (`requirePermission('...')`), protecting final Owner demotion/deletion and self-role escalation.

3. **Unstructured Flat-JSON State Without ACID Transactions or Schema Migrations (`src/persistence.ts`, `src/store.ts`)**
   - **Evidence**: Platform state (`databases`, `envVars`, `registries`, `gitRepos`, `backups`, `fleetServers`) is rewritten monolithically into `platform-state.json`, while `apps`, `containers`, `files`, and logs stay ephemeral in `MemoryStore`. Concurrent mutations risk lost updates and lack foreign keys, indexes, migration history, and backupable relational tables.
   - **Impact**: State fragmentation, missing relational integrity across users/servers/deployments/audit events, and fragile upgrades.
   - **Recommended Fix**: Implement embedded SQLite persistence (`KATHAL_DATA_DIR/kathal.db`) using Node 22 built-in `node:sqlite` (`DatabaseSync` + `backup`) with WAL mode, `PRAGMA foreign_keys = ON`, versioned `schema_migrations`, transactions, hot DB backup, integrity checks, and repeatable idempotent import from existing JSON files (`auth-state.json`, `platform-state.json`, `audit-log.json`).

---

### High

4. **Silent Vault Key Overwrite Risk & Lack of Key Rotation / Key Versioning (`src/persistence.ts:91-150, 220-283`)**
   - **Evidence**: `PersistenceManager.getVaultKey()` generates a fresh random `.vault-key` if the file is missing or malformed, and `safeDecrypt()` silently returns `''` on decryption failure (`src/persistence.ts:277-283`). Encrypted payloads use unversioned `enc:v1:<iv>:<tag>:<cipher>` without key ID (`kid`), key metadata, rotation workflow, or explicit recovery diagnostics.
   - **Impact**: Missing or wrong vault keys can silently blank secrets on reload or overwrite an unreadable state with newly encrypted blank data, causing silent data loss.
   - **Recommended Fix**: Store key metadata (`kid`, algorithm, createdAt, status) in SQLite; tag ciphertexts as `enc:v2:<kid>:<iv>:<tag>:<cipher>` (retaining `enc:v1:` read compatibility); refuse to silently regenerate a replacement key when existing encrypted records are detected without the matching key (enter safe locked recovery state with actionable diagnostics); implement `POST /api/v1/vault/rotate` transactional re-encryption.

5. **WebSocket Terminal Upgrade Lacks Origin Validation, Permission Checks, Connection Limits & Session Revocation (`server.ts:2850-2878, 3736-3769`)**
   - **Evidence**: `upgrade` handler verifies single-use `wsTicket`, which prevents query-JWT exposure and replay, but does not verify WebSocket `Origin` against allowed hosts, check `terminal.access` permission on current user session state, bind `sessionId` ownership to the creating user, cap concurrent WS connections per session/user, or close active terminal sockets when a user's session is revoked/logged out.
   - **Impact**: Cross-site WebSocket hijacking risk if cookies are used, dangling privileged terminals after user deactivation/logout, and unbounded terminal socket creation.
   - **Recommended Fix**: Validate `Origin` header on WS upgrade; link `terminalSessions` & `terminalTickets` to `userId` and `sessionId`; enforce `terminal.access`; enforce per-user active socket cap; actively close WS connections whose auth session is revoked or expired; record terminal connect/disconnect audit events.

6. **Fleet Probe SSRF & DNS Rebinding Exposure + Missing Server ACL/Agent Auth (`server.ts:758-891`)**
   - **Evidence**: `isValidRemoteHost()` only blocks `169.254.169.254` and `metadata.google.internal`. Attackers or lower-privileged operators could register hostnames resolving via DNS to `169.254.x.x` (cloud metadata), IPv6 link-local (`fe80::/10`), multicast/reserved CIDRs, or scan internal host ports, without explicit DNS resolution validation or private-network opt-in controls. Remote servers also lack ownership, server-level permissions, status history, and signed agent credential rotation.
   - **Impact**: Hostname-based SSRF / DNS rebinding against link-local metadata and internal loopback services; unauthorized server registration/probing.
   - **Recommended Fix**: Resolve DNS (`dns.lookup(..., { all: true })`) before TCP probe, always block loopback/link-local/unspecified/multicast/metadata IPs (`169.254.0.0/16`, `0.0.0.0/8`, `fe80::/10`, `::1`, `fc00::/7` metadata/reserved), enforce explicit policy flag (`KATHAL_FLEET_ALLOW_PRIVATE_NETWORKS`, default `true` for homelab LAN with loopback/link-local still blocked unless explicit local node, or strict policy check), add RBAC (`servers.read/create/update/delete`), `owner_user_id`, `server_status_history`, hashed agent registration/auth tokens with rotation, and heartbeat protocol documentation.

7. **Monolithic `server.ts` (`3,789` LOC) Mixing Transport, Auth, Business Logic & Runtime Execution**
   - **Evidence**: Nearly 4,000 lines of route definitions, serialization helpers, auth logic, proxy logic, Git webhook handlers, Compose parsing, and WebSocket terminal handling live inside `server.ts`.
   - **Impact**: High coupling, difficult auditing, risk of missing middleware on new routes, and brittle testability.
   - **Recommended Fix**: Modularize backend cleanly into `src/config/`, `src/database/`, `src/auth/`, `src/security/`, `src/middleware/`, `src/routes/`, `src/audit/`, `src/fleet/`, and `src/websocket/` while preserving every existing `/api/v1/*` contract.

---

### Medium

8. **Audit Log Scalability, Structure & Tamper/Access Controls (`src/persistence.ts:320-343`, `server.ts:748-756`)**
   - **Evidence**: Audit log is a flat JSON array capped at `1,000` entries, lacking structured `user_id`, `resource_type`, `resource_id`, `correlation_id`, date-range/resource filters, pagination metadata (`total`, `page`, `pageSize`), and `audit.read` authorization. Several sensitive routes (`files/write`, `files/delete`, `registries` mutations, `proxy` mutations, `installations`, `containers/delete`) omit audit logging.
   - **Recommended Fix**: Store unlimited/retained structured audit events in SQLite `audit_events`, attach `X-Request-Id` correlation IDs across requests, sanitize sensitive keys recursively before storing metadata, protect `GET /api/v1/audit` behind `audit.read`, and prohibit mutation/deletion endpoints on audit history.

9. **Password Hashing Cost / Algorithm Modernization (`server.ts:47, 342, 381`)**
   - **Evidence**: Uses `bcryptjs` (pure JS blowfish, fixed cost 10). Node `v22.23.2` lacks native `crypto.argon2Sync`, and native npm `argon2` requires C++ toolchains on `node:22-alpine` Docker images if prebuilds miss.
   - **Recommended Fix**: Standardize on Node OpenSSL memory-hard `crypto.scrypt` (`$scrypt$v=1$N=32768,r=8,p=1$<salt>$<hash>`, 64-byte key, `timingSafeEqual`) for all new/updated hashes while seamlessly verifying and transparently upgrading legacy `$2a$/$2b$` hashes on login. Enforce password policy validation (8–128 chars, character diversity checks for multi-user accounts while preserving smooth first-run setup compatibility).

10. **Lack of Light/Dark Theme Switching, Permission-Aware UI & Security Consoles (`web/src/`)**
    - **Evidence**: `web/src/index.css` hardcodes `#080c08`; `Sidebar.jsx` displays static `Administrator` badge regardless of role; no UI exists for User Management, Role/Permission matrix, Active Sessions, Vault status/rotation, Security settings, Database status/migrations, or Access Denied state.
    - **Recommended Fix**: Add semantic light/dark CSS theme support preserving KATHAL's forest/jackfruit identity, permission-aware sidebar/action controls driven by `/api/v1/auth/me` permissions (with backend always enforcing truth), and polished management consoles for Users, Roles, Sessions, Security/Vault, Audit Log, and Database Status.

---

### Low / Informational

11. **Workspace Dependency Version Skew (`web/package.json` vs `package.json`)**
    - **Evidence**: Root `package.json` runs `vite@^8.3.8`, whereas `web/package.json` still lists `vite@^5.3.1` and `react-router-dom@^6.23.1`. `bun audit` flags dev-server advisories on `vite <=6.4.3` and `react-router <7.18.0` SSR hydration. Production SPA runtime is not affected by SSR hydration, and root Vite 8 executes builds cleanly.
    - **Recommended Fix**: Document clearly and schedule `web/package.json` alignment cleanly without introducing breaking router changes during Phase 1.5.

12. **`MemoryStore` Still Holds Ephemeral Virtual Files (`store.files`) & Ephemeral Runtime Image Lists**
    - **Evidence**: `MemoryStore` holds sample virtual files (`/etc/kathal/config.json`) in RAM alongside real filesystem operations under `data/apps`.
    - **Recommended Fix**: Keep existing File Manager compatibility intact while persisting core domain entities (`users`, `roles`, `permissions`, `sessions`, `api_tokens`, `servers`, `server_groups`, `applications`, `deployments`, `containers`, `databases`, `domains`, `certificates`, `secrets`, `backups`, `workflows`, `plugins`, `notifications`, `audit_events`, `system_settings`) in `kathal.db`.

---

## 3. Missing Test Coverage Identified

- SQLite initial schema, repeatable migrations, rollback behavior, foreign key enforcement, transaction rollback, JSON import idempotency & count verification, hot DB backup/integrity check.
- Multi-user login, logout, session expiration (idle + absolute), concurrent sessions list & revocation, password change revoking other active sessions, deactivated account rejection.
- Full RBAC matrix across all 5 roles (`Owner`, `Administrator`, `Operator`, `Developer`, `Viewer`), permission-denial (`403`), privilege-escalation attempts (user changing own role), and final Owner protection.
- Vault key versioning (`enc:v2`), key rotation across encrypted secrets, missing/invalid vault key refusal without overwriting existing encrypted DB, auth tag failure.
- WebSocket origin validation, expired/replayed ticket rejection, unauthorized terminal permission (`403`), active terminal disconnect on session revocation.
- Audit log pagination, filtering (`action`, `outcome`, `resourceType`, `userId`, date), and secret redaction assertions.
- Fleet SSRF/DNS rebinding protection, agent token issuance & rotation, server status history.

---

## 4. Phase 1.5 Execution Order

1. **Stage A**: Initial audit completed (`docs/PHASE_1_5_AUDIT.md`).
2. **Stage B**: SQLite persistence (`src/database/`), versioned migrations, repositories, hot backups, and repeatable migration from `auth-state.json`, `platform-state.json`, `audit-log.json` (`docs/DATABASE_MIGRATION.md`).
3. **Stage C & D**: Multi-user authentication (`scrypt` + legacy `bcrypt` upgrade, HttpOnly cookies + Bearer sessions, CSRF origin checks, idle/absolute timeouts, session revocation) and RBAC (`Owner`, `Administrator`, `Operator`, `Developer`, `Viewer`, 26+ granular permissions) (`docs/RBAC_AND_AUTHENTICATION.md`).
4. **Stage E**: Vault v2 (`enc:v2:<kid>:<iv>:<tag>:<cipher>`), key rotation, strict missing-key protection, `/api/v1/vault/*` (`docs/VAULT_SECURITY.md`).
5. **Stage F, G & H**: Backend modularization (`src/routes/*`, `src/middleware/*`, `src/auth/*`, `src/security/*`, `src/fleet/*`, `src/websocket/*`, `src/audit/*`), WebSocket hardening, Fleet SSRF/DNS/agent foundation (`docs/FLEET_AGENT_PROTOCOL.md`), and paginated structured Audit log.
6. **Stage I**: Frontend UI for Login/Setup, Users, Roles, Sessions, Security/Vault settings, Audit viewer, Database status, Light/Dark theme support, and Access Denied view.
7. **Stage J**: Comprehensive unit/integration tests (`npm test`), `npm run lint`, `npm run build`, live verification, and updated docs (`README.md`, `.env.example`, `walkthrough.md`, `docs/AUDIT_AND_ARCHITECTURE.md`, `docs/PHASE_1_5_RELEASE_NOTES.md`).
