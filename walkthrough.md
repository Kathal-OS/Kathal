# Security Summary

**Reviewed Files**: 48 (backend modules, SQLite database & migrator, API routers, WebSocket gateway, frontend pages, Docker/CI configs, install scripts)
**Issues Resolved**: 11 (6 Phase 1 + 5 Phase 1.5)

### Issues Resolved
| Area | File | Line | What Was Happening | Impact | Status | How It Was Fixed |
|---|---|---|---|---|---|---|
| Long-Lived Token in WebSocket URL | `server.ts` / `web/src/pages/Terminal.jsx` | `server.ts:2858, 3745` / `Terminal.jsx:97` | The browser passed the 72-hour administrator JWT in the WebSocket query string (`?token=<jwt>`), exposing session credentials in server/proxy URL logs. | High | Fixed | `POST /api/v1/terminal/sessions` now mints a 60-second single-use `wsTicket`; the WebSocket upgrade handler validates the ticket with constant-time comparison and deletes it before upgrading. |
| Unverified Git Webhook Triggers | `server.ts` | `183, 197, 2768-2800` | Git webhook routes lacked raw-body cryptographic signature checks and were mismatched with the Bearer auth gate. | High | Fixed | `authMiddleware` routes webhook paths directly into `verifyWebhookSignature()`, which requires constant-time HMAC-SHA256 verification (`X-Hub-Signature-256`) over raw request bytes or a matching `X-Kathal-Webhook-Secret` / `X-Gitlab-Token`, returning `401` and recording an audit denial otherwise. |
| Plaintext Secrets Returned in List/Settings APIs | `server.ts` / `web/src/pages/Env.jsx` / `Settings.jsx` | `685, 1844, 3259` | Reading `/api/v1/databases`, `/api/v1/env`, or `/api/v1/settings` returned raw database passwords, secret env variable values, and webhook secrets automatically. | High | Fixed | Added `serializeDatabase()`, `serializeEnvVar()`, and `serializeSettings()` to redact secret values on list/read calls; introduced explicit, audit-logged reveal endpoints (`POST /api/v1/env/:key/reveal`, `POST /api/v1/settings/reveal-webhook`). |
| Unencrypted & Ephemeral Sensitive State | `src/persistence.ts` / `server.ts` | `src/persistence.ts:91-150, 285-316` | Sensitive settings, DB passwords, secret env vars, registries, and claimed admin credentials lived only in memory and lacked authenticated encryption on disk. | High | Fixed | Implemented `PersistenceManager` with AES-256-GCM authenticated encryption at rest (`KATHAL_VAULT_KEY` or `0o600` `.vault-key`), atomic file writes for `auth-state.json` and `platform-state.json`, and persistent `audit-log.json`. |
| Missing HTTP Security Headers | `server.ts` | `245-251` | Express responses omitted baseline browser hardening headers (`nosniff`, `Referrer-Policy`, `Permissions-Policy`, `X-DNS-Prefetch-Control`). | Medium | Fixed | Added iframe-compatible security header middleware across all responses before route handling. |
| Cloud Metadata Probe Target on Fleet Registration | `server.ts` | `758-763, 833` | Adding a remote Fleet node did not screen out cloud metadata hostnames/IPs before probing. | Medium | Fixed | Added `isValidRemoteHost()` validation rejecting `169.254.169.254`, `metadata.google.internal`, and malformed hostnames with `400`. |
| Single-Admin Token Auth & Missing Role Separation | `src/auth/*` / `src/middleware/authMiddleware.ts` | `authService.ts:175-712`, `rbac.ts:49-300` | Single admin account issued 72h stateless tokens without logout revocation, cookie origin checks, user deactivation, or permission boundaries. | Critical | Fixed | Implemented `scrypt` hashing (`N=32768`), revocable SHA-256 SQLite sessions, `HttpOnly` cookies with origin/`X-Requested-With` verification, 5-attempt lockout, and 5-role / 26-permission backend RBAC with final-Owner and self-escalation guards. |
| Silent Vault Key Overwrite & Flat JSON Secrets | `src/security/vault.ts` / `src/database/sqlite.ts` | `vault.ts:118-167, 264-392` | Missing `.vault-key` could regenerate over unreadable encrypted records, and flat JSON lacked ACID transactions or key rotation. | High | Fixed | Migrated storage to WAL SQLite (`kathal.db`) with `enc:v2:<kid>:<iv>:<tag>:<cipher>` (AAD-bound key IDs); missing/wrong keys lock safely for recovery without overwriting data, and Owners can rotate keys atomically. |
| WebSocket Origin, Permission & Session-Revocation Gaps | `src/websocket/terminalGateway.ts` | `terminalGateway.ts:49-54, 155-273` | Terminal socket upgrades verified tickets but lacked Origin checks, `terminal.access` checks, per-user limits, and teardown when sessions ended. | High | Fixed | Enforced `Origin` validation, `terminal.access` permission checks, user ownership + 5-socket cap, and automatic socket close (`4001`) when sessions are revoked or logged out. |
| Fleet DNS-Resolution Bypass & Unscoped Agent Telemetry | `src/fleet/fleetService.ts` / `src/routes/fleetRoutes.ts` | `fleetService.ts:65-185, 439-516` | Hostname syntax checks alone could miss DNS records resolving to loopback or link-local metadata addresses, and remote nodes lacked scoped agent tokens. | High | Fixed | Resolved all A/AAAA DNS records before probing to screen loopback, link-local metadata (`169.254.0.0/16`, `fe80::/10`), and multicast ranges, and added hashed `agentToken` rotation plus `POST /api/v1/fleet/agent/heartbeat`. |
| Unpaginated Flat Audit Log Without Secret Filtering | `src/audit/auditService.ts` / `src/routes/auditRoutes.ts` | `auditService.ts:50-238` | Audit logs were capped at 1,000 JSON entries in RAM/file without key sanitization, pagination, or `audit.read` enforcement. | Medium | Fixed | Stored structured audit events in indexed SQLite `audit_events`, recursively redacted secret keys before write, enforced `audit.read`, and added paginated filtering. |

### Safeguards Verified
| Area | File | How It's Protected |
|---|---|---|
| Vault v2 & SQLite Encryption at Rest | `src/security/vault.ts`, `src/database/sqlite.ts` | Secrets seal under `enc:v2:<kid>:<iv>:<tag>:<cipher>` inside transactional SQLite (`kathal.db`, WAL + `PRAGMA foreign_keys = ON`); missing keys lock safely without key regeneration. |
| Subprocess Execution & Path Confinement | `src/platform.ts`, `src/backupManager.ts`, `src/localRuntime.ts` | Child processes run with `shell: false`; ZIP extraction checks CRC-32 and rejects traversal paths; installed apps remain confined inside `KATHAL_APPS_DIR`. |
| Password Hashing & Session Isolation | `src/security/password.ts`, `src/auth/authService.ts`, `src/middleware/authMiddleware.ts` | Passwords hash with `scrypt` (`N=32768`) with transparent `bcrypt` upgrade; `HttpOnly` cookie sessions enforce idle/absolute limits, rotation on password change, and `Origin`/`X-Requested-With` verification on mutations. |
| Backend Role-Based Access Control | `src/auth/rbac.ts`, `src/routes/userRoutes.ts` | 26 permissions mapped across `Owner`, `Administrator`, `Operator`, `Developer`, and `Viewer` enforced on every route; non-Owners cannot self-escalate or remove the final `Owner`. |
| Localhost Proxy & Fleet Probe Target Screening | `src/localRuntime.ts`, `src/fleet/fleetService.ts` | Custom proxy rules permit only `localhost` / `127.0.0.1` ports (`1`–`65535`); Fleet probes verify DNS-resolved IPs against loopback and metadata ranges before opening TCP sockets. |

---

## PoC Verification

### 1. Single-Use WebSocket Terminal Ticket & Query-JWT Blocking

#### Summary
| Field | Value |
|---|---|
| Issue Type | Query-String Credential Exposure & Token Replay on WebSocket Upgrade |
| Impact | High |
| Affected File | `server.ts:2850-2869`, `server.ts:3736-3769`, `web/src/pages/Terminal.jsx:90-98` |
| Test Scenario | Attempt WS upgrade with `?token=<valid-admin-jwt>`, connect with `?ticket=<wsTicket>`, then replay the same `?ticket=<wsTicket>` a second time. |

#### How It Was Fixed
WebSocket authentication was decoupled from the 72-hour admin JWT. The authenticated `POST /api/v1/terminal/sessions` route generates a short-lived (60-second) 24-byte random single-use ticket scoped to the exact terminal `sessionId`, and the upgrade handler validates and deletes the ticket atomically before opening the socket.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | Legacy client opens `WS /api/v1/terminal/ws/<id>?token=<jwt>` at `server.ts:3736`. | Enters `upgrade` handler |
| 2 | `reqUrl.searchParams.get('ticket')` returns `''` (`server.ts:3745`); `stored` is `undefined`. | Fails ticket lookup at `server.ts:3748` |
| 3 | Handler writes audit denial (`server.ts:3753`), sends `HTTP/1.1 401 Unauthorized`, and destroys the socket (`server.ts:3754-3755`). | **Legacy `?token=` Blocked** |
| 4 | Valid client fetches `wsTicket` from `POST /api/v1/terminal/sessions` (`server.ts:2858-2868`) and opens `?ticket=<wsTicket>`. | Matches `stored.sessionId` and `safeEqualStrings` (`server.ts:3750-3751`) |
| 5 | Handler executes `terminalTickets.delete(rawTicket)` (`server.ts:3759`) prior to `wss.handleUpgrade` (`server.ts:3766`); a second upgrade with the same ticket finds `stored === undefined` and returns `401`. | **Replay Handled Safely** |

#### Conclusion
**Fix Verified** — Verified in `tests/core.test.ts` (`316-364`): `?token=<jwt>` connections are rejected, a valid single-use `wsTicket` connects once cleanly, and replaying that ticket fails with `401`.

---

### 2. Git Webhook Cryptographic Signature Enforcement

#### Summary
| Field | Value |
|---|---|
| Issue Type | Missing Signature Verification on Public Webhook Trigger |
| Impact | High |
| Affected File | `server.ts:178-203`, `server.ts:305-312`, `server.ts:2768-2830` |
| Test Scenario | Send unauthenticated `POST /api/v1/git/webhook`, a request with forged `X-Hub-Signature-256: sha256=000...`, and a request signed with raw-body HMAC-SHA256. |

#### How It Was Fixed
Raw request body bytes are preserved via `express.json({ verify })` so HMAC-SHA256 verification does not depend on re-serialized JSON formatting. `authMiddleware` delegates webhook routes into `verifyWebhookSignature()`, which requires constant-time HMAC-SHA256 (`X-Hub-Signature-256`) or matching secret header (`X-Kathal-Webhook-Secret` / `X-Gitlab-Token`).

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | `express.json` stores incoming raw payload bytes in `req.rawBody` (`server.ts:308-310`). | Raw body preserved |
| 2 | `authMiddleware` identifies `/git/webhook` (`server.ts:183, 197`) and passes control to `handleWebhookTrigger` (`server.ts:2792`). | Reaches signature check |
| 3 | Unauthenticated or forged request enters `verifyWebhookSignature(req)` (`server.ts:2768-2790`); HMAC check fails `safeEqualStrings` (`server.ts:2776`). | Returns `{ ok: false }` |
| 4 | Handler records denied audit event (`server.ts:2795`) and responds `401 Unauthorized` (`server.ts:2796-2799`). | **Blocked Safely** |
| 5 | Valid HMAC-SHA256 digest passes `safeEqualStrings` (`server.ts:2776`) and proceeds deterministically. | **Authorized Trigger** |

#### Conclusion
**Fix Verified** — Verified in `tests/core.test.ts` (`265-314`): unsigned and forged webhook requests return `401` with denied audit entries, while properly HMAC-signed payloads are accepted.

---

### 3. Secret Redaction in API Responses & Encrypted Disk Persistence

#### Summary
| Field | Value |
|---|---|
| Issue Type | Sensitive Credential Exposure in List Responses & Unencrypted Storage |
| Impact | High |
| Affected File | `server.ts:685-728, 1844-1895, 3259-3302`, `src/persistence.ts:123-150, 285-316` |
| Test Scenario | Create a database password, secret env var, and webhook secret; query `GET` endpoints and inspect raw `data/platform-state.json` on disk; tamper with stored ciphertext. |

#### How It Was Fixed
All read/list endpoints return masked representations (`serializeDatabase`, `serializeEnvVar`, `serializeSettings`), requiring explicit audited `POST` reveal actions (`POST /env/:key/reveal`, `POST /settings/reveal-webhook`, `GET /databases/:id/connection`) to retrieve plaintext. On disk, `PersistenceManager` encrypts secrets with AES-256-GCM before atomic write.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | `POST /api/v1/databases` and `POST /api/v1/env` persist secrets via `persistence.savePlatformState()` (`src/persistence.ts:285`). | Triggers AES-256-GCM encryption |
| 2 | `encryptSecret()` seals each secret with a 12-byte random IV and GCM auth tag (`src/persistence.ts:123-132`). | No plaintext written to disk |
| 3 | `GET /api/v1/databases`, `GET /api/v1/env`, and `GET /api/v1/settings` run through `serializeDatabase`, `serializeEnvVar`, and `serializeSettings`. | Plaintext omitted from JSON responses |
| 4 | Tampered ciphertext enters `decryptSecret()` (`src/persistence.ts:134-150`); `decipher.final()` fails GCM tag verification and throws. | **Tampering Rejected** |

#### Conclusion
**Fix Verified** — Verified in `tests/core.test.ts` (`94-135` and `206-263`): raw JSON files contain zero plaintext secret values, list endpoints mask secrets, and GCM auth-tag tampering throws immediately.

---

### 4. Fleet Host Validation & HTTP Response Hardening

#### Summary
| Field | Value |
|---|---|
| Issue Type | Unvalidated Remote Host Registration (Metadata IP) & Missing Security Headers |
| Impact | Medium |
| Affected File | `server.ts:245-251`, `server.ts:758-763`, `server.ts:833-836` |
| Test Scenario | Check response headers on `GET /api/v1/health` and submit `POST /api/v1/fleet/servers` targeting `169.254.169.254`. |

#### How It Was Fixed
Added baseline browser protection headers to all responses (`server.ts:245-251`) and added `isValidRemoteHost()` validation rejecting metadata endpoints (`169.254.169.254`, `metadata.google.internal`) before registering or probing remote Fleet servers.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | Every HTTP request passes through header middleware (`server.ts:245-251`). | `X-Content-Type-Options: nosniff` & `Referrer-Policy` attached |
| 2 | `POST /api/v1/fleet/servers` with `host: "169.254.169.254"` calls `isValidRemoteHost(host)` (`server.ts:758-763, 833`). | Returns `false` at line 761 |
| 3 | Route aborts registration and returns `400 Bad Request` (`server.ts:834-835`). | **Metadata Probe Prevented** |

#### Conclusion
**Fix Verified** — Verified in `tests/core.test.ts` (`158-166` and `366-396`): baseline security headers are present on HTTP responses and metadata endpoint registration is rejected with `400`.

---

### 5. Multi-User RBAC Privilege Boundaries & Anti-Escalation (Phase 1.5)

#### Summary
| Field | Value |
|---|---|
| Issue Type | Privilege Escalation & Insufficient Role Separation |
| Impact | Critical |
| Affected File | `src/auth/rbac.ts:263-300`, `src/routes/userRoutes.ts:94-161`, `src/routes/vaultRoutes.ts:42-88` |
| Test Scenario | Authenticate as `Viewer`, `Developer`, `Operator`, and `Administrator`; verify denied mutations (`403`), attempt self-role escalation (`403`), attempt assigning/removing `Owner` without holding `Owner` (`403`), and attempt deleting the final active `Owner` (`400`). |

#### How It Was Fixed
Every `/api/v1/*` operational route checks fine-grained permissions via `requirePermission(...)`, while `RbacService.assignRoles()` and `userRoutes` block self-role modification by non-Owners, restrict `Owner` grants and `POST /api/v1/vault/rotate` to `Owner` holders, and refuse deleting or demoting the final active `Owner`.

#### Conclusion
**Fix Verified** — Verified in `tests/phase1_5.test.ts`: every role matrix check, self-escalation rejection (`403`), non-Owner Vault rotation rejection (`403`), and final-Owner deletion block (`400`) passes cleanly.

---

### 6. Cookie CSRF Enforcement, Session Revocation & Immediate WebSocket Close (Phase 1.5)

#### Summary
| Field | Value |
|---|---|
| Issue Type | Cross-Site Cookie Mutation & Dangling Terminal Session After Logout |
| Impact | High |
| Affected File | `src/middleware/authMiddleware.ts:83-153`, `src/auth/authService.ts:420-457`, `src/websocket/terminalGateway.ts:49-54, 155-255` |
| Test Scenario | Send cookie-authenticated `POST /api/v1/env` without `X-Requested-With` or matching `Origin`; open an active WS terminal socket and invoke `POST /api/v1/auth/logout` or change password from another session. |

#### How It Was Fixed
Mutating requests authenticated by the `kathal_session` cookie require either `X-Requested-With` or a matching same-host `Origin`/`Referer` (`403` otherwise). Active terminal sockets register by `authSessionId`, and `AuthService.revokeSession()` / `changePassword()` triggers immediate WebSocket closure with close code `4001`.

#### Conclusion
**Fix Verified** — Verified in `tests/phase1_5.test.ts`: cross-site cookie mutations return `403`, cross-origin WS upgrades return `403`, and active WS terminals disconnect automatically on logout (`4001`).

---

### 7. Vault v2 Anti-Overwrite Lock & Key Rotation (Phase 1.5)

#### Summary
| Field | Value |
|---|---|
| Issue Type | Silent Key Overwrite Risk When Master Key Is Missing |
| Impact | High |
| Affected File | `src/security/vault.ts:118-167, 264-392` |
| Test Scenario | Encrypt secrets under key A, reopen database without `.vault-key` or `KATHAL_VAULT_KEY`, confirm keyfile is not regenerated and `VaultLockedError` is raised, then unlock with key A and execute `POST /api/v1/vault/rotate`. |

#### How It Was Fixed
`VaultManager.initialize()` inspects SQLite encrypted columns and `vault_keys` before generating a key; if encrypted payloads exist without the matching key, it refuses key generation and exposes recovery instructions until the original key is provided. Rotation re-encrypts all secrets transactionally under a fresh `kid` (`enc:v2:`).

#### Conclusion
**Fix Verified** — Verified in `tests/phase1_5.test.ts`: missing-key startup locks cleanly without destroying encrypted rows, recovery restores access, and `rotateKey()` atomically re-seals all records under the new key ID.
