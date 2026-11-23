# KATHAL OS — Vault Security & Key Management

KATHAL OS Phase 1.5 hardens secret encryption at rest with versioned key metadata, authenticated ciphertexts (`enc:v2:`), anti-overwrite protection when a key is missing or mismatched, and Owner-only transactional key rotation.

---

## 1. Encryption Format & Key Sources (`src/security/vault.ts`)

- **Ciphertext Format (v2)**:
  `enc:v2:<kid>:<ivHex>:<authTagHex>:<ciphertextHex>`
  - **Algorithm**: `aes-256-gcm` with 12-byte CSPRNG IV and 16-byte authentication tag.
  - **Additional Authenticated Data (AAD)**: Binds `<kid>` into the GCM tag (`cipher.setAAD(Buffer.from(kid, 'utf8'))`), preventing key-ID substitution or ciphertext tampering.
- **Backward Compatibility (v1)**:
  `VaultManager.decryptSecret()` transparently reads legacy Phase 1 `enc:v1:<ivHex>:<authTagHex>:<ciphertextHex>` payloads and upgrades them to `enc:v2:` on write or key rotation.
- **Key Resolution Order**:
  1. `KATHAL_VAULT_KEY` environment variable (64-character hex string used directly as 32 bytes, or passphrase hashed via SHA-256).
  2. `<KATHAL_DATA_DIR>/.vault-key` (auto-generated on *clean* first initialization with POSIX mode `0o600`).

---

## 2. Anti-Overwrite & Locked Recovery Behavior

To eliminate silent secret loss caused by missing keys:

1. On startup, `VaultManager.initialize(db)` checks whether `secrets`, `databases`, `registries`, `system_settings`, or `vault_keys` already contain encrypted records.
2. If existing encrypted records or key metadata exist, **and** neither `KATHAL_VAULT_KEY` nor a valid `.vault-key` is present (or the provided key fingerprint does not match the active `vault_keys` record):
   - `VaultManager` **refuses to generate a replacement `.vault-key`**.
   - It enters a safe **Locked** state (`needsRecovery: true`) with an explicit diagnostic reason and throws `VaultLockedError` on decrypt/encrypt/rotate attempts.
3. Operators inspect recovery guidance via `GET /api/v1/vault/recovery` (or the UI Security Console), restore the original `KATHAL_VAULT_KEY` or `.vault-key` (`0o600`), and restart cleanly without data corruption.

---

## 3. Transactional Key Rotation

Only a user holding the **Owner** role (plus `settings.manage`) can rotate the vault master key:

1. `POST /api/v1/vault/rotate` generates a new 256-bit key (or derives an explicitly supplied `newKey`) under a fresh `kid` (`vk-<timestamp>-<hex>`).
2. Inside a single `BEGIN IMMEDIATE ... COMMIT` SQLite transaction, `VaultManager.rotateKey()` decrypts and re-encrypts every encrypted row across:
   - `secrets` (`value_enc`, updating `key_version`)
   - `databases` (`password_enc`)
   - `registries` (`password_enc`)
   - `system_settings` (`webhook_secret_enc`)
   - `vault_keys` (marks the previous active key `retired` with `rotated_at`, inserts the new `active` key)
3. If using file-backed keys, writes `.vault-key` atomically (`tmp` + `rename` with `0o600`).
4. Reloads the runtime store and records a sanitized `vault.rotate` audit event (logging `previousKid`, `newKid`, and `reencryptedCount`, never key material).

---

## 4. Secret Masking & Per-Secret Rotation API

| Endpoint | Required Permission | Behavior |
| :--- | :--- | :--- |
| `GET /api/v1/vault/status` | `settings.read` | Shows vault state (`ready`/`locked`), `activeKid`, `keySource`, `.vault-key` permission check, key history, and encrypted count. |
| `GET /api/v1/vault/recovery` | `settings.read` | Returns lock state and actionable key recovery steps. |
| `POST /api/v1/vault/rotate` | `settings.manage` + `Owner` role | Atomically rotates the master key across all encrypted tables (`403` for non-Owners). |
| `GET /api/v1/vault/secrets` | `secrets.read` | Returns key metadata, `keyVersion`, and masked value (`••••••••`) — never plaintext. |
| `POST /api/v1/vault/secrets/:key/reveal` | `secrets.reveal` | Decrypts and returns a single secret value while recording `vault.secret_reveal` in `audit_events`. |
| `POST /api/v1/vault/secrets/:key/rotate` | `secrets.reveal` | Replaces a specific secret value encrypted under the active `kid` and updates `rotated_at`. |
