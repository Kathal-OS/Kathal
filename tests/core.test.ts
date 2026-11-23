import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import type http from 'node:http'
import WebSocket from 'ws'

// Configure an isolated temporary KATHAL_DATA_DIR before importing server modules
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kathal-test-'))
const testAppsDir = path.join(testRoot, 'apps')
fs.mkdirSync(testAppsDir, { recursive: true })
process.env.KATHAL_DATA_DIR = testRoot
process.env.KATHAL_APPS_DIR = testAppsDir
process.env.KATHAL_DISABLE_AUTOSTART = '1'
process.env.KATHAL_JWT_SECRET = 'test-jwt-secret-for-suite-only-00112233'
process.env.KATHAL_VAULT_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
process.env.NODE_ENV = 'production'

const { compareSemver, normalizeVersion, parseSemver, resolveCurrentEnvVersion } = await import(
  '../src/updateChecker.ts'
)
const { buildZipArchive, parseZipArchive } = await import('../src/backupManager.ts')
const { PersistenceManager } = await import('../src/persistence.ts')
const { MemoryStore } = await import('../src/store.ts')
const { startServer } = await import('../server.ts')

describe('UpdateChecker Semver & Config Validation', () => {
  it('parses and compares semver versions including prereleases', () => {
    assert.equal(normalizeVersion(' v1.2.3 '), '1.2.3')
    assert.deepEqual(parseSemver('v2.4.1-beta.2'), {
      major: 2,
      minor: 4,
      patch: 1,
      prerelease: ['beta', '2'],
    })
    assert.equal(compareSemver('1.0.0', '0.9.9'), 1)
    assert.equal(compareSemver('0.1.0', '0.1.0'), 0)
    assert.equal(compareSemver('1.0.0-alpha.1', '1.0.0'), -1)
    assert.equal(compareSemver('1.0.0-beta.2', '1.0.0-beta.1'), 1)
  })

  it('falls back safely when KATHAL_GITHUB_REPO contains invalid input', () => {
    const prev = process.env.KATHAL_GITHUB_REPO
    process.env.KATHAL_GITHUB_REPO = 'https://evil.example.com/../../'
    try {
      const meta = resolveCurrentEnvVersion()
      assert.equal(meta.repository, 'Kathal-OS/Kathal')
    } finally {
      if (prev === undefined) delete process.env.KATHAL_GITHUB_REPO
      else process.env.KATHAL_GITHUB_REPO = prev
    }
  })
})

describe('BackupManager ZIP Archive & Safety Checks', () => {
  it('creates and parses compressed PKZIP archives with CRC integrity', () => {
    const payload = Buffer.from('hello kathal jackfruit ecosystem '.repeat(20), 'utf8')
    const archive = buildZipArchive([
      { name: 'manifest.json', data: Buffer.from('{"format":"kathal-backup-v1"}') },
      { name: 'config/test.conf', data: payload },
    ])
    const parsed = parseZipArchive(archive)
    assert.equal(parsed.length, 2)
    assert.equal(parsed[0].name, 'manifest.json')
    assert.equal(parsed[1].name, 'config/test.conf')
    assert.equal(parsed[1].data.toString('utf8'), payload.toString('utf8'))
  })

  it('rejects zip-slip traversal paths in crafted ZIP archives', () => {
    // Build normal ZIP then mutate the filename in local + central headers to "../../evil.txt"
    const cleanZip = buildZipArchive([{ name: 'aaaa/bbbb.txt', data: Buffer.from('safe') }])
    const patched = Buffer.from(cleanZip)
    const idx1 = patched.indexOf('aaaa/bbbb.txt')
    const idx2 = patched.lastIndexOf('aaaa/bbbb.txt')
    assert.ok(idx1 > 0 && idx2 > idx1)
    patched.write('../../etc/pwd', idx1, 'utf8')
    patched.write('../../etc/pwd', idx2, 'utf8')
    assert.throws(() => parseZipArchive(patched), /Unsafe ZIP entry path rejected/)
  })

  it('rejects corrupted payloads via CRC-32 mismatch', () => {
    const buf = Buffer.from(
      buildZipArchive([{ name: 'data/check.txt', data: Buffer.from('integrity-check') }])
    )
    const marker = buf.indexOf('integrity-check')
    assert.ok(marker > 0)
    buf[marker] = 'X'.charCodeAt(0)
    assert.throws(() => parseZipArchive(buf), /Checksum mismatch/)
  })
})

describe('PersistenceManager Encryption & Atomic Storage', () => {
  it('encrypts secrets with AES-256-GCM and persists platform state safely', () => {
    const pm = new PersistenceManager()
    const cipher = pm.encryptSecret('super-secret-db-pass')
    assert.ok(cipher.startsWith('enc:v1:'))
    assert.notEqual(cipher, 'super-secret-db-pass')
    assert.equal(pm.decryptSecret(cipher), 'super-secret-db-pass')

    // Tampered ciphertext must throw authentication failure
    const parts = cipher.split(':')
    parts[4] = parts[4].slice(0, -2) + (parts[4].endsWith('aa') ? 'bb' : 'aa')
    assert.throws(() => pm.decryptSecret(parts.join(':')))

    const s = new MemoryStore()
    s.databases.push({
      id: 'db-test1',
      name: 'prod-pg',
      type: 'postgres',
      port: 5432,
      user: 'postgres',
      password: 'plaintext-password-never-on-disk',
      status: 'running',
    })
    s.envVars.push({
      key: 'STRIPE_KEY',
      value: 'sk_live_secret_value',
      description: 'Payment secret',
      secret: true,
    })

    pm.savePlatformState(s, [pm.createDefaultLocalFleetServer()])
    const rawDisk = fs.readFileSync(path.join(testRoot, 'platform-state.json'), 'utf8')
    assert.equal(rawDisk.includes('plaintext-password-never-on-disk'), false)
    assert.equal(rawDisk.includes('sk_live_secret_value'), false)

    const reloadedStore = new MemoryStore()
    pm.loadPlatformState(reloadedStore)
    assert.equal(reloadedStore.databases[0].password, 'plaintext-password-never-on-disk')
    const stripe = reloadedStore.envVars.find((v) => v.key === 'STRIPE_KEY')
    assert.equal(stripe?.value, 'sk_live_secret_value')
  })
})

describe('KATHAL OS HTTP & WebSocket Security Integration', () => {
  let server: http.Server
  let baseUrl = ''
  let wsBaseUrl = ''
  let adminToken = ''
  let webhookSecret = ''

  before(async () => {
    const started = await startServer(0)
    server = started.server
    const addr = server.address()
    assert.ok(addr && typeof addr === 'object')
    baseUrl = `http://127.0.0.1:${addr.port}`
    wsBaseUrl = `ws://127.0.0.1:${addr.port}`
  })

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(testRoot, { recursive: true, force: true })
  })

  it('sets baseline security headers and blocks unauthenticated API calls', async () => {
    const healthRes = await fetch(`${baseUrl}/api/v1/health`)
    assert.equal(healthRes.status, 200)
    assert.equal(healthRes.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(healthRes.headers.get('referrer-policy'), 'strict-origin-when-cross-origin')

    const denied = await fetch(`${baseUrl}/api/v1/services`)
    assert.equal(denied.status, 401)
  })

  it('enforces one-time admin setup and rejects wrong credentials', async () => {
    const stBefore = await fetch(`${baseUrl}/api/v1/auth/status`).then((r) => r.json())
    assert.equal(stBefore.needsSetup, true)

    const preLogin = await fetch(`${baseUrl}/api/v1/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@kathal.local', password: 'Password123!' }),
    })
    assert.equal(preLogin.status, 403)

    const setupRes = await fetch(`${baseUrl}/api/v1/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@kathal.local', password: 'Password123!' }),
    })
    assert.equal(setupRes.status, 200)
    const setupJson = (await setupRes.json()) as { token: string }
    assert.ok(setupJson.token)
    adminToken = setupJson.token

    // Duplicate setup blocked
    const dupRes = await fetch(`${baseUrl}/api/v1/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'attacker@evil.local', password: 'Password123!' }),
    })
    assert.equal(dupRes.status, 409)

    // Wrong password rejected
    const badLogin = await fetch(`${baseUrl}/api/v1/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@kathal.local', password: 'WrongPassword!' }),
    })
    assert.equal(badLogin.status, 401)
  })

  it('redacts DB passwords, secret env vars, and webhook secrets in list/read endpoints', async () => {
    const authHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    }

    const dbCreated = (await fetch(`${baseUrl}/api/v1/databases`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ name: 'orders-db', type: 'postgres', password: 'db-secret-xyz' }),
    }).then((r) => r.json())) as Record<string, unknown>

    assert.equal('password' in dbCreated, false)
    assert.equal(dbCreated.hasPassword, true)
    assert.equal(dbCreated.passwordMasked, '••••••••')

    const dbList = (await fetch(`${baseUrl}/api/v1/databases`, { headers: authHeaders }).then((r) =>
      r.json()
    )) as Array<Record<string, unknown>>
    assert.equal('password' in dbList[0], false)

    const connRes = (await fetch(`${baseUrl}/api/v1/databases/${dbCreated.id}/connection`, {
      headers: authHeaders,
    }).then((r) => r.json())) as { connection_string: string }
    assert.ok(connRes.connection_string.includes('db-secret-xyz'))

    await fetch(`${baseUrl}/api/v1/env`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ key: 'API_TOKEN', value: 'tok_live_999', secret: true }),
    })
    const envList = (await fetch(`${baseUrl}/api/v1/env`, { headers: authHeaders }).then((r) =>
      r.json()
    )) as Array<{ key: string; value: string; secret: boolean }>
    const apiTok = envList.find((e) => e.key === 'API_TOKEN')
    assert.equal(apiTok?.value, '')

    const revealed = (await fetch(`${baseUrl}/api/v1/env/API_TOKEN/reveal`, {
      method: 'POST',
      headers: authHeaders,
      body: '{}',
    }).then((r) => r.json())) as { value: string }
    assert.equal(revealed.value, 'tok_live_999')

    const settingsGet = (await fetch(`${baseUrl}/api/v1/settings`, { headers: authHeaders }).then((r) =>
      r.json()
    )) as Record<string, unknown>
    assert.equal('webhookSecret' in settingsGet, false)
    assert.equal(settingsGet.hasWebhookSecret, true)

    const revealedWebhook = (await fetch(`${baseUrl}/api/v1/settings/reveal-webhook`, {
      method: 'POST',
      headers: authHeaders,
      body: '{}',
    }).then((r) => r.json())) as { webhookSecret: string }
    assert.ok(revealedWebhook.webhookSecret.length >= 16)
    webhookSecret = revealedWebhook.webhookSecret
  })

  it('verifies HMAC signatures on git webhooks and blocks unauthenticated triggers', async () => {
    const authHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    }

    // Disable autoDeployWebhook so authenticated webhook verification returns deterministic 'ignored' without cloning
    await fetch(`${baseUrl}/api/v1/settings`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ autoDeployWebhook: false }),
    })

    const repo = (await fetch(`${baseUrl}/api/v1/git/repos`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ name: 'sample-app', url: 'https://github.com/Kathal-OS/Kathal.git' }),
    }).then((r) => r.json())) as { id: string }

    const unauth = await fetch(`${baseUrl}/api/v1/git/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo_id: repo.id }),
    })
    assert.equal(unauth.status, 401)

    const forged = await fetch(`${baseUrl}/api/v1/git/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64),
      },
      body: JSON.stringify({ repo_id: repo.id }),
    })
    assert.equal(forged.status, 401)

    const rawBody = JSON.stringify({ repo_id: repo.id })
    const sig = 'sha256=' + crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex')
    const valid = await fetch(`${baseUrl}/api/v1/git/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': sig,
      },
      body: rawBody,
    })
    assert.equal(valid.status, 200)
    const validJson = (await valid.json()) as { status: string }
    assert.equal(validJson.status, 'ignored')
  })

  it('enforces single-use WebSocket terminal tickets and rejects legacy query JWTs or replays', async () => {
    const authHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    }
    const sess = (await fetch(`${baseUrl}/api/v1/terminal/sessions`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ cols: 80, rows: 24 }),
    }).then((r) => r.json())) as { id: string; wsTicket: string }
    assert.ok(sess.wsTicket)

    // 1. Legacy ?token=<jwt> must be rejected
    await assert.rejects(
      () =>
        new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(`${wsBaseUrl}/api/v1/terminal/ws/${sess.id}?token=${adminToken}`)
          ws.once('open', () => {
            ws.close()
            resolve()
          })
          ws.once('error', reject)
        })
    )

    // 2. Valid ticket connects once cleanly
    const firstMsg = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`${wsBaseUrl}/api/v1/terminal/ws/${sess.id}?ticket=${sess.wsTicket}`)
      ws.once('message', (data) => {
        ws.close()
        resolve(data.toString())
      })
      ws.once('error', reject)
    })
    assert.ok(firstMsg.includes('KATHAL OS Local Terminal'))

    // 3. Replaying same ticket must fail
    await assert.rejects(
      () =>
        new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(`${wsBaseUrl}/api/v1/terminal/ws/${sess.id}?ticket=${sess.wsTicket}`)
          ws.once('open', () => {
            ws.close()
            resolve()
          })
          ws.once('error', reject)
        })
    )
  })

  it('manages Fleet nodes with validation and records Audit events', async () => {
    const authHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    }

    const fleetInitial = (await fetch(`${baseUrl}/api/v1/fleet/servers`, { headers: authHeaders }).then((r) =>
      r.json()
    )) as { servers: Array<{ id: string }>; summary: { total: number } }
    assert.ok(fleetInitial.servers.some((s) => s.id === 'local-primary'))

    const ssrfBlocked = await fetch(`${baseUrl}/api/v1/fleet/servers`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ name: 'meta', host: '169.254.169.254', port: 80 }),
    })
    assert.equal(ssrfBlocked.status, 400)

    const delLocal = await fetch(`${baseUrl}/api/v1/fleet/servers/local-primary`, {
      method: 'DELETE',
      headers: authHeaders,
    })
    assert.equal(delLocal.status, 400)

    const audit = (await fetch(`${baseUrl}/api/v1/audit?limit=50`, { headers: authHeaders }).then((r) =>
      r.json()
    )) as Array<{ action: string; outcome: string }>
    assert.ok(audit.some((e) => e.action === 'auth.setup' && e.outcome === 'success'))
    assert.ok(audit.some((e) => e.action === 'terminal.ws_connect' && e.outcome === 'denied'))
    assert.ok(audit.some((e) => e.action === 'git.webhook' && e.outcome === 'denied'))
  })
})
