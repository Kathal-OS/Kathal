import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import { promisify } from 'node:util'
import { isValidDockerImageRef, isValidSlugOrAppName } from '../../validation/validators.ts'

const execFileAsync = promisify(execFile)

export interface DockerContainerSummary {
  id: string
  name: string
  image: string
  state: string
  status: string
  ports: string[]
  createdAt: string
}

export interface DockerImageSummary {
  id: string
  repoTags: string[]
  size: number
  createdAt: string
}

export interface DockerVolumeSummary {
  name: string
  driver: string
  mountpoint: string
}

export interface DockerNetworkSummary {
  id: string
  name: string
  driver: string
  scope: string
  internal: boolean
}

export interface DockerStatsSample {
  cpuPercent: number
  memoryMb: number
  memoryLimitMb: number
  pids: number
}

export interface DockerExecutor {
  execCli: (args: string[], options?: { cwd?: string; timeoutMs?: number; signal?: AbortSignal }) => Promise<{ stdout: string; stderr: string }>
  requestApi?: (method: string, path: string, body?: unknown) => Promise<{ status: number; data: unknown }>
}

export interface DockerAvailability {
  available: boolean
  mode: 'socket' | 'cli' | 'mock' | 'unavailable'
  serverVersion: string | null
  socketPath: string | null
  reason: string | null
}

function defaultSocketPath(): string | null {
  const envHost = (process.env.DOCKER_HOST || '').trim()
  if (envHost.startsWith('unix://')) return envHost.slice(7)
  if (process.platform === 'win32') return '//./pipe/docker_engine'
  if (fs.existsSync('/var/run/docker.sock')) return '/var/run/docker.sock'
  return null
}

export class DockerAdapter {
  private executor: DockerExecutor | null
  private customAvailability: DockerAvailability | null

  constructor(options: { executor?: DockerExecutor; availability?: DockerAvailability } = {}) {
    this.executor = options.executor || null
    this.customAvailability = options.availability || null
  }

  async detectAvailability(): Promise<DockerAvailability> {
    if (this.customAvailability) return this.customAvailability
    if (this.executor) {
      return {
        available: true,
        mode: 'mock',
        serverVersion: '27.0.0-adapter',
        socketPath: null,
        reason: null,
      }
    }

    const sock = defaultSocketPath()
    if (sock && (process.platform === 'win32' || fs.existsSync(sock))) {
      try {
        const res = await this.socketRequest(sock, 'GET', '/version')
        if (res.status >= 200 && res.status < 300) {
          const data = res.data as { Version?: string }
          return {
            available: true,
            mode: 'socket',
            serverVersion: data?.Version || 'unknown',
            socketPath: sock,
            reason: null,
          }
        }
      } catch {
        // fallback to CLI probe
      }
    }

    try {
      const { stdout } = await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}'], {
        shell: false,
        timeout: 4_000,
      })
      const ver = stdout.trim()
      if (ver) {
        return {
          available: true,
          mode: 'cli',
          serverVersion: ver,
          socketPath: sock,
          reason: null,
        }
      }
    } catch (err) {
      return {
        available: false,
        mode: 'unavailable',
        serverVersion: null,
        socketPath: sock,
        reason: (err as Error).message || 'Docker daemon is not installed or not running on this host',
      }
    }

    return {
      available: false,
      mode: 'unavailable',
      serverVersion: null,
      socketPath: sock,
      reason: 'Docker daemon is unavailable on this host',
    }
  }

  private async runCli(
    args: string[],
    options: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<{ stdout: string; stderr: string }> {
    if (this.executor) {
      return this.executor.execCli(args, options)
    }
    const avail = await this.detectAvailability()
    if (!avail.available) {
      throw new Error(avail.reason || 'Docker Engine is unavailable on this host')
    }
    return execFileAsync('docker', args, {
      shell: false,
      cwd: options.cwd,
      timeout: options.timeoutMs ?? 120_000,
      signal: options.signal,
    })
  }

  private socketRequest(
    socketPath: string,
    method: string,
    apiPath: string,
    body?: unknown
  ): Promise<{ status: number; data: unknown }> {
    return new Promise((resolve, reject) => {
      const payload = body !== undefined ? JSON.stringify(body) : null
      const req = http.request(
        {
          socketPath,
          path: apiPath,
          method,
          timeout: 5_000,
          headers: payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : undefined,
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8')
            let parsed: unknown = raw
            try {
              parsed = raw ? JSON.parse(raw) : {}
            } catch {
              // plain text response
            }
            resolve({ status: res.statusCode || 500, data: parsed })
          })
        }
      )
      req.on('timeout', () => req.destroy(new Error('Docker socket request timed out')))
      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
    })
  }

  async listContainers(all = true): Promise<{ available: boolean; reason?: string; containers: DockerContainerSummary[] }> {
    const avail = await this.detectAvailability()
    if (!avail.available) {
      return { available: false, reason: avail.reason || 'Docker unavailable', containers: [] }
    }
    const args = ['ps', ...(all ? ['-a'] : []), '--format', '{{json .}}']
    const { stdout } = await this.runCli(args, { timeoutMs: 15_000 })
    const containers: DockerContainerSummary[] = []
    for (const line of stdout.split(/\r?\n/)) {
      const t = line.trim()
      if (!t) continue
      try {
        const obj = JSON.parse(t) as Record<string, string>
        containers.push({
          id: obj.ID || '',
          name: (obj.Names || '').replace(/^\//, ''),
          image: obj.Image || '',
          state: (obj.State || '').toLowerCase(),
          status: obj.Status || '',
          ports: obj.Ports ? obj.Ports.split(',').map((p) => p.trim()).filter(Boolean) : [],
          createdAt: obj.CreatedAt || '',
        })
      } catch {
        // ignore unparseable line
      }
    }
    return { available: true, containers }
  }

  async buildImage(input: {
    contextDir: string
    dockerfilePath?: string
    tag: string
    signal?: AbortSignal
    onLog?: (line: string) => void
  }): Promise<{ imageTag: string; logs: string[] }> {
    if (!isValidDockerImageRef(input.tag)) {
      throw new Error(`Invalid Docker image tag "${input.tag}"`)
    }
    const args = ['build', '-t', input.tag]
    if (input.dockerfilePath) {
      args.push('-f', input.dockerfilePath)
    }
    args.push(input.contextDir)
    const { stdout, stderr } = await this.runCli(args, {
      cwd: input.contextDir,
      timeoutMs: 300_000,
      signal: input.signal,
    })
    const logs = `${stdout}\n${stderr}`
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    for (const l of logs) input.onLog?.(l)
    return { imageTag: input.tag, logs }
  }

  async runContainer(input: {
    name: string
    image: string
    hostPort?: number
    containerPort?: number
    env?: Record<string, string>
    volumes?: string[]
    network?: string
    restartPolicy?: string
  }): Promise<{ containerId: string }> {
    if (!isValidSlugOrAppName(input.name)) {
      throw new Error(`Invalid container name "${input.name}"`)
    }
    if (!isValidDockerImageRef(input.image)) {
      throw new Error(`Invalid Docker image reference "${input.image}"`)
    }
    const args = ['run', '-d', '--name', input.name]
    if (input.restartPolicy) {
      args.push('--restart', input.restartPolicy)
    }
    if (input.hostPort && input.containerPort) {
      args.push('-p', `127.0.0.1:${input.hostPort}:${input.containerPort}`)
    }
    if (input.network) {
      args.push('--network', input.network)
    }
    for (const [k, v] of Object.entries(input.env || {})) {
      args.push('-e', `${k}=${v}`)
    }
    for (const vol of input.volumes || []) {
      args.push('-v', vol)
    }
    args.push(input.image)

    const { stdout } = await this.runCli(args, { timeoutMs: 60_000 })
    return { containerId: stdout.trim().split(/\r?\n/)[0] || input.name }
  }

  async startContainer(idOrName: string): Promise<void> {
    await this.runCli(['start', idOrName])
  }

  async stopContainer(idOrName: string): Promise<void> {
    await this.runCli(['stop', idOrName])
  }

  async restartContainer(idOrName: string): Promise<void> {
    await this.runCli(['restart', idOrName])
  }

  async removeContainer(idOrName: string, force = false): Promise<void> {
    await this.runCli(['rm', ...(force ? ['-f'] : []), idOrName])
  }

  async getContainerLogs(idOrName: string, tail = 150): Promise<string> {
    const { stdout, stderr } = await this.runCli(['logs', '--tail', String(Math.min(1000, Math.max(10, tail))), idOrName])
    return [stdout, stderr].filter(Boolean).join('\n')
  }

  async inspectContainerHealth(idOrName: string): Promise<{ running: boolean; healthStatus: string }> {
    const { stdout } = await this.runCli([
      'inspect',
      '--format',
      '{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}',
      idOrName,
    ])
    const [runningStr, healthStatus] = stdout.trim().split('|')
    return {
      running: runningStr === 'true',
      healthStatus: healthStatus || 'none',
    }
  }

  async composeUp(projectName: string, composeFilePath: string, cwd: string): Promise<{ stdout: string; stderr: string }> {
    if (!isValidSlugOrAppName(projectName)) {
      throw new Error(`Invalid compose project name "${projectName}"`)
    }
    return this.runCli(['compose', '-p', projectName, '-f', composeFilePath, 'up', '-d'], {
      cwd,
      timeoutMs: 180_000,
    })
  }

  async composeDown(projectName: string, composeFilePath: string, cwd: string): Promise<{ stdout: string; stderr: string }> {
    if (!isValidSlugOrAppName(projectName)) {
      throw new Error(`Invalid compose project name "${projectName}"`)
    }
    return this.runCli(['compose', '-p', projectName, '-f', composeFilePath, 'down'], {
      cwd,
      timeoutMs: 120_000,
    })
  }

  async composeStop(projectName: string, composeFilePath: string, cwd: string): Promise<{ stdout: string; stderr: string }> {
    return this.runCli(['compose', '-p', projectName, '-f', composeFilePath, 'stop'], {
      cwd,
      timeoutMs: 60_000,
    })
  }
}
