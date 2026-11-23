# KATHAL OS — SQLite Database & JSON Migration Guide

KATHAL OS Phase 1.5 replaces unstructured flat-JSON persistence with an embedded ACID SQLite database at `KATHAL_DATA_DIR/kathal.db` powered by Node.js 22's built-in `node:sqlite` (`DatabaseSync` and online `backup`) — requiring zero native C++ build toolchains across Windows, macOS, and Linux.

---

## 1. Database Engine & Location

- **Default Location**: `<KATHAL_DATA_DIR>/kathal.db` (defaults to `./data/kathal.db`, never inside temporary build directories).
- **WAL & Reliability Pragmas** (applied in `src/database/sqlite.ts` on initialization):
  - `PRAGMA journal_mode = WAL;` — Concurrent reads alongside atomic writes
  - `PRAGMA synchronous = NORMAL;` — Balanced durability + throughput
  - `PRAGMA foreign_keys = ON;` — Strict relational integrity across users, roles, servers, applications, and audit logs
  - `PRAGMA busy_timeout = 5000;` — 5-second lock contention wait window
- **Lifecycle & Shutdown**: `DatabaseManager.close()` executes `PRAGMA wal_checkpoint(TRUNCATE);` before closing the SQLite handle during server shutdown (`SIGINT` / `SIGTERM` / test teardown).

---

## 2. Schema Overview (`001_initial_schema`)

`DatabaseManager.runMigrations()` tracks applied migrations and SHA-256 checksums in `schema_migrations`, wrapping each migration (`up` and `down`) inside a `BEGIN IMMEDIATE ... COMMIT` transaction.

| Domain | Tables | Key Relationships & Indexes |
| :--- | :--- | :--- |
| **Migrations & Vault** | `schema_migrations`, `vault_keys` | Tracks migration version/checksum and active/retired AES-256-GCM key IDs (`kid`). |
| **Identity & Sessions** | `users`, `roles`, `permissions`, `role_permissions`, `user_roles`, `sessions`, `api_tokens`, `password_resets` | Unique `users(email)`, indexed `sessions(token_hash)`, cascading `ON DELETE CASCADE` on user removal. |
| **Fleet & Workloads** | `server_groups`, `servers`, `server_status_history`, `applications`, `deployments`, `containers`, `databases`, `domains`, `certificates` | Indexed `server_status_history(server_id, checked_at DESC)`, `applications(server_id, owner_user_id)`, cascading server deletion rules. |
| **Secrets & Ops** | `secrets`, `backups`, `workflows`, `plugins`, `notifications`, `system_settings` | Unique `secrets(scope, key_name)` with `key_version`, singleton `system_settings(id = 'default')`. |
| **Git & Compose** | `git_repos`, `git_deploy_logs`, `compose_projects`, `networks`, `volumes`, `registries` | Cascading `git_deploy_logs.repo_id -> git_repos.id`. |
| **Audit & Migration** | `audit_events`, `migration_runs` | Indexed on `created_at DESC`, `action`, `outcome`, `user_id`, `(resource_type, resource_id)`; records repeatable legacy import runs. |

---

## 3. Repeatable JSON-to-SQLite Migration (`src/database/jsonMigrator.ts`)

When KATHAL OS starts for the first time with SQLite against an existing Phase 1 data directory, `migrateLegacyJsonToSqlite()` automatically executes a deterministic 10-step import:

1. **Idempotency Check**: Queries `migration_runs` for `source_name = 'legacy_json_v1'`. If already `'completed'`, skips cleanly without duplicating records.
2. **Legacy File Detection**: Scans `KATHAL_DATA_DIR` for `auth-state.json`, `platform-state.json`, `audit-log.json`, and `reverse-proxy.json`.
3. **Pre-Validation**: Parses and validates JSON file structure before touching SQLite; malformed or corrupted JSON throws before opening the import transaction so partial corrupt data is never written.
4. **Pre-Migration SQLite Backup**: Calls `dbManager.backupTo()` to snapshot the database into `KATHAL_DATA_DIR/backups/pre-json-migration-<timestamp>.db` prior to importing records.
5. **Single Transactional Import**: Wraps all inserts inside `dbManager.transaction(() => { ... })` with `INSERT OR IGNORE`.
6. **ID & Timestamp Preservation**: Preserves existing IDs, hashes, timestamps, database definitions, registries, Git repos/logs, networks, volumes, backups, fleet servers, and audit records; maps the legacy admin into `users` with the `Owner` (`role-owner`) role.
7. **Vault Encryption Upgrade**: Re-seals any plaintext or `enc:v1:` encrypted secrets with the active `VaultManager` key (`enc:v2:`).
8. **Completion Marker**: Inserts the `legacy_json_v1` summary row (counts per table and timestamp) into `migration_runs` inside the same transaction.
9. **Integrity Verification**: Runs `dbManager.integrityCheck()` (`PRAGMA integrity_check === 'ok'`) after commit.
10. **Original File Retention**: Leaves `auth-state.json`, `platform-state.json`, and `audit-log.json` intact on disk so operators can inspect or recover cleanly if an anomaly occurs.

---

## 4. Database Operations API (`src/routes/databaseAdminRoutes.ts`)

| Endpoint | Required Permission | Purpose |
| :--- | :--- | :--- |
| `GET /api/v1/system/database/status` | `settings.read` | Reports DB path, byte size, WAL mode, `PRAGMA foreign_keys`, `integrity_check` result, migration version, per-table counts, and legacy JSON import status. |
| `GET /api/v1/system/database/migrations` | `settings.read` | Lists all applied migrations and checksums. |
| `POST /api/v1/system/database/integrity` | `settings.manage` | Runs on-demand `PRAGMA integrity_check` and logs an audit event. |
| `POST /api/v1/system/database/backup` | `backups.create` | Creates an online SQLite hot backup (`kathal-db-<timestamp>.db`) inside `KATHAL_DATA_DIR/backups/`. |

---

## 5. Rollback & Recovery Procedures

- **Failed Legacy JSON Import**: Because pre-validation runs prior to SQLite mutation and the import uses a single transaction, corrupt JSON aborts cleanly without leaving partial rows, and original JSON files remain untouched on disk.
- **Database Rollback from Pre-Migration Snapshot**:
  1. Stop the KATHAL OS server (`SIGTERM`).
  2. Copy the desired snapshot from `KATHAL_DATA_DIR/backups/pre-json-migration-*.db` (or `kathal-db-*.db`) over `KATHAL_DATA_DIR/kathal.db`.
  3. Remove stale `kathal.db-wal` and `kathal.db-shm` sidecar files if present.
  4. Start KATHAL OS and verify health via `GET /api/v1/system/database/status`.
- **Schema Migration Rollback (Dev/Test)**: `DatabaseManager.rollbackLastMigration()` executes the top applied migration's `down()` handler transactionally and removes its `schema_migrations` row.
