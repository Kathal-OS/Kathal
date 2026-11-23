# KATHAL OS — Authentication, Sessions & RBAC

KATHAL OS Phase 1.5 replaces the single-admin JWT model with revocable multi-user server-side sessions, memory-hard password hashing, cookie + CSRF hardening, and a 5-role, 26-permission Role-Based Access Control (RBAC) engine enforced strictly on the backend.

---

## 1. Password Hashing & Policy (`src/security/password.ts`)

- **Primary Algorithm**: Node.js OpenSSL `crypto.scrypt` (`$scrypt$v=1$N=32768,r=8,p=1$<salt>$<hash>`, 64-byte derived key, ~32 MiB memory-hard cost) compared via `crypto.timingSafeEqual`.
- **Legacy Compatibility**: Verifies existing Phase 1 `bcryptjs` (`$2a$` / `$2b$` / `$2y$`) hashes and transparently re-hashes them to `$scrypt$v=1$` on successful login (`needsPasswordRehash()`).
- **Password Policy**: Multi-user creation, password changes, and resets require 8–128 characters combining at least two character classes (lowercase, uppercase, digits, symbols). First-run Owner claim permits standard passphrase lengths (`>= 6` chars) while hashing with `scrypt`.
- **Rate Limiting & Account Lockout**: `POST /api/v1/login` and `/api/v1/auth/login` enforce 5 failed attempts -> 5-minute account lock (`HTTP 429`) alongside IP rate limiting (`createSimpleRateLimiter`).

---

## 2. Session Lifecycle & Transport Security (`src/auth/authService.ts`, `src/middleware/authMiddleware.ts`)

- **Revocable Sessions (`sessions` table)**:
  - Random 256-bit tokens (`ks_<64 hex>`) stored only as SHA-256 digests (`token_hash`) in SQLite.
  - Supports **both** `HttpOnly` cookie (`kathal_session`) and `Authorization: Bearer ks_...` headers (`GET /api/v1/auth/session` restores cookie sessions cleanly on page refresh).
  - Cookie attributes: `HttpOnly; Path=/`; `Secure; SameSite=None; Partitioned` over HTTPS / `KATHAL_COOKIE_SECURE=true`, or `SameSite=Lax` on local HTTP.
- **Idle & Absolute Expiration**:
  - Configurable via `KATHAL_SESSION_IDLE_HOURS` (default `12h`, sliding window refreshed on authenticated requests) and `KATHAL_SESSION_MAX_HOURS` (default `72h`, hard cap).
- **Cookie CSRF Defense**: Cookie-authenticated mutating requests (`POST`, `PUT`, `PATCH`, `DELETE`) require either `X-Requested-With` (sent by the KATHAL UI) or a same-host `Origin` / `Referer` header, rejecting cross-site form/fetch requests with `HTTP 403`.
- **Credential Hygiene**:
  - `POST /api/v1/auth/change-password` verifies the current password, rotates the caller's session token, and **revokes all other active sessions**.
  - Deactivating or deleting a user immediately revokes all sessions and closes any connected WebSocket terminals (`4001`) via `AuthService.onSessionsRevoked`.
- **Self-Registration Policy**: Disabled by default (`KATHAL_ALLOW_SELF_REGISTRATION=false`, returning `403`). When explicitly enabled (`true`), `/api/v1/auth/register` always assigns the least-privilege `Viewer` role and ignores client-supplied role fields.

---

## 3. Roles & Permissions (`src/auth/rbac.ts`)

| Role | Rank | Intended Scope |
| :--- | :---: | :--- |
| **Owner** | `100` | Full platform ownership: all 26 permissions + exclusive ability to assign/remove `Owner` and rotate Vault master keys. |
| **Administrator** | `80` | Full operational control (all 26 permissions) except assigning/demoting `Owner` or rotating the Vault master key. |
| **Operator** | `60` | Deploy/restart apps, manage workloads/databases/fleet probes, create backups, view settings/secrets metadata, and open terminal (`14` permissions). |
| **Developer** | `40` | Create/deploy/restart applications, read servers/workloads/databases/settings/secrets metadata (`10` permissions). |
| **Viewer** | `10` | Strict read-only visibility across dashboard, servers, applications, workloads, databases, secrets list, and settings (`7` permissions). |

### Full Permission Catalog (26 Permissions)
`dashboard.read`, `servers.read`, `servers.create`, `servers.update`, `servers.delete`, `applications.read`, `applications.create`, `applications.deploy`, `applications.restart`, `applications.delete`, `containers.read`, `containers.manage`, `databases.read`, `databases.manage`, `secrets.read`, `secrets.reveal`, `users.read`, `users.manage`, `settings.read`, `settings.manage`, `audit.read`, `backups.create`, `backups.restore`, `plugins.manage`, `workflows.manage`, `terminal.access`.

### Anti-Escalation Guards
1. Non-Owners cannot modify their own roles (`PUT /api/v1/users/:id/roles` -> `403`).
2. Non-Owners cannot create an `Owner` or promote/demote any `Owner` (`403`).
3. The final active `Owner` cannot be demoted, deactivated, or deleted (`400`).
4. Missing any route's `requirePermission(...)` immediately returns `403` and appends an `rbac.denied` audit record.

---

## 4. WebSocket Terminal Security (`src/websocket/terminalGateway.ts`)

1. Clients with `terminal.access` mint a 60-second single-use ticket (`POST /api/v1/terminal/sessions`).
2. Upgrade (`WS /api/v1/terminal/ws/:id?ticket=<wsTicket>`) checks `Origin` against the request `Host` / `KATHAL_ALLOWED_ORIGINS` (`403` if mismatched).
3. Validates and consumes the single-use `wsTicket` via constant-time comparison **before** attaching the shell (`401` on missing/expired/replayed tickets or legacy `?token=`).
4. Confirms the owning auth session is still active, the user is active with `terminal.access`, and active sockets are below the per-user limit (`5` concurrent sockets -> `429`).
5. Actively closes open WebSockets (`close(4001)`) the moment a user's session is logged out or revoked.
