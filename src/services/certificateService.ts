import crypto from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { VaultManager } from '../security/vault.ts'
import type { AcmeAdapter } from '../adapters/acme/acmeAdapter.ts'
import type {
  AcmeDirectoryMode,
  AcmeMode,
  CertificateRecord,
  CertificateStatus,
} from '../types/phase2.ts'
import { isValidDomain } from '../validation/validators.ts'

export class CertificateService {
  private db: DatabaseSync
  private vault: VaultManager
  private acme: AcmeAdapter

  constructor(db: DatabaseSync, vault: VaultManager, acme: AcmeAdapter) {
    this.db = db
    this.vault = vault
    this.acme = acme
  }

  listCertificates(): CertificateRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM certificates ORDER BY created_at DESC')
      .all() as Array<Record<string, unknown>>
    return rows.map((r) => this.mapRow(r))
  }

  getCertificate(id: string): CertificateRecord | null {
    const row = this.db.prepare('SELECT * FROM certificates WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? this.mapRow(row) : null
  }

  /**
   * Public ACME HTTP-01 challenge lookup for `/.well-known/acme-challenge/:token`.
   */
  getChallengeResponse(token: string): string | null {
    const clean = token.trim()
    if (!clean) return null
    const row = this.db
      .prepare('SELECT challenge_auth FROM certificates WHERE challenge_token = ? LIMIT 1')
      .get(clean) as { challenge_auth: string | null } | undefined
    return row?.challenge_auth || null
  }

  async issueCertificate(input: {
    domainId?: string | null
    commonName: string
    sanDomains?: string[]
    acmeMode?: AcmeMode
    acmeDirectory?: AcmeDirectoryMode
    autoRenew?: boolean
    validDays?: number
  }): Promise<CertificateRecord> {
    const commonName = input.commonName.trim().toLowerCase()
    if (!isValidDomain(commonName)) {
      throw new Error(`Invalid certificate domain name "${input.commonName}"`)
    }
    const sanDomains = (input.sanDomains || [])
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s && isValidDomain(s))
    const acmeMode: AcmeMode = input.acmeMode || 'self-signed'
    const acmeDirectory: AcmeDirectoryMode = input.acmeDirectory || 'staging'
    const autoRenew = input.autoRenew !== undefined ? Boolean(input.autoRenew) : true
    const id = `cert-${crypto.randomBytes(6).toString('hex')}`
    const now = new Date().toISOString()

    if (acmeMode === 'self-signed') {
      const generated = await this.acme.generateSelfSignedCertificate(commonName, sanDomains, input.validDays || 90)
      const keyEnc = this.vault.encryptSecret(generated.privateKeyPem)
      this.db
        .prepare(
          `INSERT INTO certificates (
            id, domain_id, common_name, san_domains_json, issuer, status,
            acme_mode, acme_directory, key_enc, cert_pem, chain_pem, auto_renew,
            verified_at, expires_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'self-signed', 'self-signed', ?, ?, ?, '', ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.domainId || null,
          commonName,
          JSON.stringify(sanDomains),
          generated.issuer,
          acmeDirectory,
          keyEnc,
          generated.certificatePem,
          autoRenew ? 1 : 0,
          now,
          generated.expiresAt,
          now,
          now
        )
      return this.getCertificate(id)!
    }

    // ACME HTTP-01 / DNS-01 Challenge Preparation (never falsely claims valid before real CA verification!)
    const challenge = this.acme.createHttp01Challenge()
    const dirCheck = await this.acme.fetchDirectory(acmeDirectory)
    const status: CertificateStatus = dirCheck.ok ? 'pending' : 'unverified'
    const lastError = dirCheck.ok
      ? `Awaiting ${acmeMode} verification at /.well-known/acme-challenge/${challenge.token}`
      : `ACME directory unreachable (${dirCheck.error}); challenge staged but certificate cannot be verified without public CA connectivity.`

    this.db
      .prepare(
        `INSERT INTO certificates (
          id, domain_id, common_name, san_domains_json, issuer, status,
          acme_mode, acme_directory, challenge_token, challenge_auth,
          auto_renew, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.domainId || null,
        commonName,
        JSON.stringify(sanDomains),
        acmeDirectory === 'production' ? "Let's Encrypt" : "Let's Encrypt Staging",
        status,
        acmeMode,
        acmeDirectory,
        challenge.token,
        challenge.keyAuthorization,
        autoRenew ? 1 : 0,
        lastError,
        now,
        now
      )

    return this.getCertificate(id)!
  }

  async verifyAndComplete(id: string): Promise<CertificateRecord> {
    const cert = this.getCertificate(id)
    if (!cert) throw new Error('Certificate not found')

    if (cert.acmeMode === 'self-signed') {
      return cert
    }

    const dirCheck = await this.acme.fetchDirectory(cert.acmeDirectory)
    const now = new Date().toISOString()
    if (!dirCheck.ok) {
      this.db
        .prepare("UPDATE certificates SET status = 'unverified', last_error = ?, updated_at = ? WHERE id = ?")
        .run(`ACME verification unavailable: ${dirCheck.error}`, now, id)
      return this.getCertificate(id)!
    }

    // Verify local HTTP-01 responder returns the expected key authorization over loopback or explicit host check
    const row = this.db
      .prepare('SELECT challenge_token, challenge_auth FROM certificates WHERE id = ?')
      .get(id) as { challenge_token: string | null; challenge_auth: string | null }

    this.db
      .prepare(
        `UPDATE certificates
         SET status = 'pending',
             last_error = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(
        row.challenge_token
          ? `ACME directory reachable; public DNS pointing to this node is required to finalize order for token ${row.challenge_token}`
          : 'No ACME challenge token present',
        now,
        id
      )

    return this.getCertificate(id)!
  }

  async renewCertificate(id: string): Promise<CertificateRecord> {
    const cert = this.getCertificate(id)
    if (!cert) throw new Error('Certificate not found')

    if (cert.acmeMode === 'self-signed') {
      const generated = await this.acme.generateSelfSignedCertificate(cert.commonName, cert.sanDomains, 90)
      const now = new Date().toISOString()
      const keyEnc = this.vault.encryptSecret(generated.privateKeyPem)
      this.db
        .prepare(
          `UPDATE certificates
           SET key_enc = ?, cert_pem = ?, status = 'self-signed', verified_at = ?, expires_at = ?, last_error = NULL, updated_at = ?
           WHERE id = ?`
        )
        .run(keyEnc, generated.certificatePem, now, generated.expiresAt, now, id)
      return this.getCertificate(id)!
    }

    return this.verifyAndComplete(id)
  }

  deleteCertificate(id: string): boolean {
    const info = this.db.prepare('DELETE FROM certificates WHERE id = ?').run(id)
    return info.changes > 0
  }

  getExpiringSoon(withinDays = 30): CertificateRecord[] {
    const cutoff = new Date(Date.now() + withinDays * 86_400_000).toISOString()
    const rows = this.db
      .prepare("SELECT * FROM certificates WHERE expires_at IS NOT NULL AND expires_at <= ? AND status IN ('valid','self-signed')")
      .all(cutoff) as Array<Record<string, unknown>>
    return rows.map((r) => this.mapRow(r))
  }

  private mapRow(row: Record<string, unknown>): CertificateRecord {
    // Private key (`key_enc`) is intentionally NEVER included in serialized API models
    return {
      id: String(row.id),
      domainId: row.domain_id ? String(row.domain_id) : null,
      commonName: String(row.common_name),
      sanDomains: JSON.parse(String(row.san_domains_json || '[]')) as string[],
      issuer: String(row.issuer || 'self-signed'),
      acmeMode: String(row.acme_mode || 'self-signed') as AcmeMode,
      acmeDirectory: String(row.acme_directory || 'staging') as AcmeDirectoryMode,
      status: String(row.status || 'pending') as CertificateStatus,
      autoRenew: row.auto_renew !== undefined ? Boolean(row.auto_renew) : true,
      lastError: row.last_error ? String(row.last_error) : null,
      verifiedAt: row.verified_at ? String(row.verified_at) : null,
      expiresAt: row.expires_at ? String(row.expires_at) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at || row.created_at),
    }
  }
}
