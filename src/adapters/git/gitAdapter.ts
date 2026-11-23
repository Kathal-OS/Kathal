import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { safeEqualStrings } from '../../security/password.ts'
import {
  isValidGitBranchOrRef,
  redactSecretsInText,
  validateGitRepositoryUrl,
} from '../../validation/validators.ts'

const execFileAsync = promisify(execFile)

export interface GitCommitMetadata {
  sha: string
  shortSha: string
  message: string
  author: string
  committedAt: string
}

export interface GitCheckoutResult {
  workDir: string
  commit: GitCommitMetadata
  branch: string
  logs: string[]
}

export class GitAdapter {
  private defaultTimeoutMs: number

  constructor(defaultTimeoutMs = 120_000) {
    this.defaultTimeoutMs = defaultTimeoutMs
  }

  async isGitAvailable(): Promise<{ available: boolean; version: string | null }> {
    try {
      const { stdout } = await execFileAsync('git', ['--version'], {
        shell: false,
        timeout: 5_000,
      })
      return { available: true, version: stdout.trim() }
    } catch {
      return { available: false, version: null }
    }
  }

  private async runWithAuth<T>(
    token: string | undefined,
    fn: (env: NodeJS.ProcessEnv) => Promise<T>
  ): Promise<T> {
    const cleanToken = (token || '').trim()
    const baseEnv: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
    }
    if (!cleanToken) {
      return fn(baseEnv)
    }

    // Write a short-lived askpass script inside temp dir with 0700 permissions so secrets
    // never appear in CLI args, remote URLs, or .git/config on disk.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kathal-git-auth-'))
    const isWin = process.platform === 'win32'
    const askPassFile = path.join(tmpDir, isWin ? 'askpass.cmd' : 'askpass.sh')
    if (isWin) {
      fs.writeFileSync(askPassFile, '@echo off\r\necho %KATHAL_GIT_TOKEN%\r\n', 'utf8')
    } else {
      fs.writeFileSync(askPassFile, '#!/bin/sh\nprintf "%s\\n" "$KATHAL_GIT_TOKEN"\n', {
        mode: 0o700,
      })
      fs.chmodSync(askPassFile, 0o700)
    }

    try {
      return await fn({
        ...baseEnv,
        GIT_ASKPASS: askPassFile,
        KATHAL_GIT_TOKEN: cleanToken,
      })
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  async listRemoteRefs(
    rawUrl: string,
    options: { token?: string; allowLocalPath?: boolean; allowPrivateHosts?: boolean } = {}
  ): Promise<{ branches: string[]; tags: string[] }> {
    const check = validateGitRepositoryUrl(rawUrl, options)
    if (!check.ok) throw new Error(check.error || 'Invalid repository URL')

    return this.runWithAuth(options.token, async (env) => {
      const { stdout } = await execFileAsync('git', ['ls-remote', '--heads', '--tags', check.sanitizedUrl], {
        shell: false,
        env,
        timeout: 20_000,
      })
      const branches: string[] = []
      const tags: string[] = []
      for (const line of stdout.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/)
        if (parts.length < 2) continue
        const ref = parts[1]
        if (ref.startsWith('refs/heads/')) branches.push(ref.slice('refs/heads/'.length))
        else if (ref.startsWith('refs/tags/') && !ref.endsWith('^{}')) tags.push(ref.slice('refs/tags/'.length))
      }
      return { branches, tags }
    })
  }

  async cloneAndCheckout(input: {
    repoUrl: string
    destDir: string
    branch?: string
    commitSha?: string | null
    token?: string
    allowLocalPath?: boolean
    allowPrivateHosts?: boolean
    signal?: AbortSignal
    onLog?: (line: string) => void
  }): Promise<GitCheckoutResult> {
    const check = validateGitRepositoryUrl(input.repoUrl, {
      allowLocalPath: input.allowLocalPath,
      allowPrivateHosts: input.allowPrivateHosts,
    })
    if (!check.ok) {
      throw new Error(check.error || 'Invalid Git repository URL')
    }

    const branch = (input.branch || 'main').trim() || 'main'
    if (!isValidGitBranchOrRef(branch)) {
      throw new Error(`Invalid Git branch or ref: "${branch}"`)
    }
    const targetCommit = input.commitSha?.trim() || null
    if (targetCommit && !/^[a-fA-F0-9]{7,64}$/.test(targetCommit)) {
      throw new Error('Invalid Git commit SHA')
    }

    const logs: string[] = []
    const secretsToRedact = input.token ? [input.token] : []
    const pushLog = (raw: string) => {
      const clean = redactSecretsInText(raw, secretsToRedact).trim()
      if (!clean) return
      logs.push(clean)
      input.onLog?.(clean)
    }

    fs.rmSync(input.destDir, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(input.destDir), { recursive: true })

    await this.runWithAuth(input.token, async (env) => {
      pushLog(`Cloning ${check.isLocalPath ? path.basename(check.sanitizedUrl) : check.sanitizedUrl} (branch: ${branch})...`)
      const cloneArgs = targetCommit
        ? ['clone', '--no-single-branch', '--branch', branch, check.sanitizedUrl, input.destDir]
        : ['clone', '--depth', '1', '--branch', branch, check.sanitizedUrl, input.destDir]

      try {
        const res = await execFileAsync('git', cloneArgs, {
          shell: false,
          env,
          timeout: this.defaultTimeoutMs,
          signal: input.signal,
        })
        if (res.stdout) pushLog(res.stdout)
        if (res.stderr) pushLog(res.stderr)
      } catch (err) {
        const msg = redactSecretsInText((err as Error).message || 'git clone failed', secretsToRedact)
        throw new Error(`Git clone failed: ${msg}`)
      }

      if (targetCommit) {
        pushLog(`Checking out target commit ${targetCommit}...`)
        await execFileAsync('git', ['-C', input.destDir, 'checkout', '--detach', targetCommit], {
          shell: false,
          env,
          timeout: 30_000,
          signal: input.signal,
        })
      }
    })

    const commit = await this.readHeadCommit(input.destDir)
    pushLog(`Resolved commit ${commit.shortSha}: ${commit.message}`)
    return {
      workDir: input.destDir,
      commit,
      branch,
      logs,
    }
  }

  async readHeadCommit(repoDir: string): Promise<GitCommitMetadata> {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoDir, 'show', '-s', '--format=%H%n%h%n%s%n%an%n%cI', 'HEAD'],
      { shell: false, timeout: 10_000 }
    )
    const lines = stdout.trim().split(/\r?\n/)
    return {
      sha: lines[0] || '',
      shortSha: lines[1] || (lines[0] || '').slice(0, 8),
      message: lines[2] || '',
      author: lines[3] || '',
      committedAt: lines[4] || new Date().toISOString(),
    }
  }

  verifyWebhookSignature(options: {
    secret: string
    rawBody: Buffer
    signatureHeader?: string
    gitlabTokenHeader?: string
    kathalSecretHeader?: string
  }): { ok: boolean; method?: string } {
    if (!options.secret) return { ok: false }

    const sig = (options.signatureHeader || '').trim()
    if (sig) {
      const expected = 'sha256=' + crypto.createHmac('sha256', options.secret).update(options.rawBody).digest('hex')
      if (safeEqualStrings(sig.toLowerCase(), expected.toLowerCase())) {
        return { ok: true, method: 'x-hub-signature-256' }
      }
      return { ok: false }
    }

    const token = (options.kathalSecretHeader || options.gitlabTokenHeader || '').trim()
    if (token && safeEqualStrings(token, options.secret)) {
      return { ok: true, method: options.gitlabTokenHeader ? 'x-gitlab-token' : 'x-kathal-webhook-secret' }
    }
    return { ok: false }
  }

  /**
   * Anti-replay defense: rejects duplicate webhook delivery IDs for the same source.
   */
  recordDeliveryOnce(db: DatabaseSync, deliveryId: string, sourceId: string, eventType = 'push'): boolean {
    const cleanId = deliveryId.trim()
    if (!cleanId) return true
    const now = new Date().toISOString()
    const info = db
      .prepare(
        `INSERT OR IGNORE INTO webhook_deliveries (delivery_id, source_id, event_type, received_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(cleanId, sourceId, eventType, now)
    return info.changes > 0
  }
}
