import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { AcmeDirectoryMode } from '../../types/phase2.ts'

const execFileAsync = promisify(execFile)

export const ACME_DIRECTORY_URLS: Record<AcmeDirectoryMode, string> = {
  staging: 'https://acme-staging-v02.api.letsencrypt.org/directory',
  production: 'https://acme-v02.api.letsencrypt.org/directory',
}

export interface GeneratedKeyPairAndCert {
  privateKeyPem: string
  certificatePem: string
  csrPem: string
  expiresAt: string
  issuer: string
}

export interface Dns01Provider {
  name: string
  createTxtRecord: (domain: string, value: string) => Promise<void>
  cleanupTxtRecord: (domain: string, value: string) => Promise<void>
}

export interface AcmeDirectoryClient {
  fetchDirectory: (directoryUrl: string) => Promise<Record<string, string>>
}

export class AcmeAdapter {
  private client: AcmeDirectoryClient | null

  constructor(options: { client?: AcmeDirectoryClient } = {}) {
    this.client = options.client || null
  }

  async isOpensslAvailable(): Promise<boolean> {
    try {
      await execFileAsync('openssl', ['version'], { shell: false, timeout: 3_000 })
      return true
    } catch {
      return false
    }
  }

  async fetchDirectory(mode: AcmeDirectoryMode): Promise<{ ok: boolean; directoryUrl: string; endpoints?: Record<string, string>; error?: string }> {
    const directoryUrl = ACME_DIRECTORY_URLS[mode]
    try {
      if (this.client) {
        const endpoints = await this.client.fetchDirectory(directoryUrl)
        return { ok: true, directoryUrl, endpoints }
      }
      const res = await fetch(directoryUrl, { signal: AbortSignal.timeout(8_000) })
      if (!res.ok) {
        return { ok: false, directoryUrl, error: `HTTP ${res.status} from ACME directory` }
      }
      const endpoints = (await res.json()) as Record<string, string>
      return { ok: true, directoryUrl, endpoints }
    } catch (err) {
      return {
        ok: false,
        directoryUrl,
        error: (err as Error).message || 'Unable to reach ACME directory server',
      }
    }
  }

  createHttp01Challenge(accountThumbprint?: string): { token: string; keyAuthorization: string } {
    const token = crypto.randomBytes(24).toString('base64url')
    const thumb = accountThumbprint || crypto.randomBytes(16).toString('base64url')
    return {
      token,
      keyAuthorization: `${token}.${thumb}`,
    }
  }

  computeDns01TxtValue(keyAuthorization: string): string {
    return crypto.createHash('sha256').update(keyAuthorization, 'utf8').digest('base64url')
  }

  /**
   * Generates a real ECDSA P-256 private key, CSR, and self-signed X.509 certificate
   * via OpenSSL when available (fallback to Node crypto EC keypair + explicit error if OpenSSL missing).
   */
  async generateSelfSignedCertificate(domain: string, sanDomains: string[] = [], validDays = 90): Promise<GeneratedKeyPairAndCert> {
    const { privateKey } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    })
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kathal-cert-'))
    const keyFile = path.join(tmpDir, 'privkey.pem')
    const certFile = path.join(tmpDir, 'cert.pem')
    const csrFile = path.join(tmpDir, 'req.csr')
    const extFile = path.join(tmpDir, 'ext.cnf')
    try {
      fs.writeFileSync(keyFile, privateKeyPem, { mode: 0o600 })
      const allSans = Array.from(new Set([domain, ...sanDomains].map((d) => d.trim().toLowerCase()).filter(Boolean)))
      const sanLine = allSans.map((d) => `DNS:${d}`).join(',')
      fs.writeFileSync(
        extFile,
        `[req]\ndistinguished_name=dn\nreq_extensions=v3_req\nprompt=no\n[dn]\nCN=${domain}\n[v3_req]\nsubjectAltName=${sanLine}\n`,
        'utf8'
      )

      const hasOpenssl = await this.isOpensslAvailable()
      if (!hasOpenssl) {
        throw new Error('OpenSSL binary not found on host; unable to sign X.509 certificate')
      }

      await execFileAsync(
        'openssl',
        ['req', '-new', '-key', keyFile, '-out', csrFile, '-config', extFile],
        { shell: false, timeout: 10_000 }
      )
      await execFileAsync(
        'openssl',
        [
          'x509',
          '-req',
          '-in',
          csrFile,
          '-signkey',
          keyFile,
          '-out',
          certFile,
          '-days',
          String(Math.max(1, validDays)),
          '-extensions',
          'v3_req',
          '-extfile',
          extFile,
        ],
        { shell: false, timeout: 10_000 }
      )

      const csrPem = fs.readFileSync(csrFile, 'utf8')
      const certificatePem = fs.readFileSync(certFile, 'utf8')
      const expiresAt = new Date(Date.now() + validDays * 86_400_000).toISOString()
      return {
        privateKeyPem,
        certificatePem,
        csrPem,
        expiresAt,
        issuer: 'KATHAL Local Self-Signed CA',
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  }
}
