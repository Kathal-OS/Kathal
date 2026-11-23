import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { AppBuildType } from '../../types/phase2.ts'
import { assertPathWithinBase, redactSecretsInText } from '../../validation/validators.ts'
import type { DockerAdapter } from '../containers/dockerAdapter.ts'

const execFileAsync = promisify(execFile)

export interface BuildArtifactResult {
  buildType: Exclude<AppBuildType, 'auto'>
  artifactPath: string
  imageRef: string | null
  entrypoint: string
  logs: string[]
}

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.git') continue
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDirSync(s, d)
    else fs.copyFileSync(s, d)
  }
}

export class BuildAdapter {
  private dockerAdapter: DockerAdapter

  constructor(dockerAdapter: DockerAdapter) {
    this.dockerAdapter = dockerAdapter
  }

  detectBuildType(sourceDir: string, preferred: AppBuildType = 'auto', dockerfileRel = 'Dockerfile'): Exclude<AppBuildType, 'auto'> {
    if (preferred !== 'auto') return preferred
    const dfPath = assertPathWithinBase(sourceDir, dockerfileRel || 'Dockerfile')
    if (fs.existsSync(dfPath)) return 'dockerfile'
    if (
      fs.existsSync(path.join(sourceDir, 'docker-compose.yml')) ||
      fs.existsSync(path.join(sourceDir, 'compose.yaml'))
    ) {
      return 'compose'
    }
    if (fs.existsSync(path.join(sourceDir, 'package.json'))) return 'node'
    if (
      fs.existsSync(path.join(sourceDir, 'requirements.txt')) ||
      fs.existsSync(path.join(sourceDir, 'app.py')) ||
      fs.existsSync(path.join(sourceDir, 'main.py')) ||
      fs.existsSync(path.join(sourceDir, 'server.py'))
    ) {
      return 'python'
    }
    return 'static'
  }

  async buildRelease(input: {
    sourceDir: string
    releaseDir: string
    appSlug: string
    deploymentId: string
    preferredBuildType?: AppBuildType
    dockerfilePath?: string
    buildContext?: string
    env?: Record<string, string>
    signal?: AbortSignal
    onLog?: (line: string) => void
  }): Promise<BuildArtifactResult> {
    const logs: string[] = []
    const secretValues = Object.values(input.env || {}).filter((v) => v.length >= 6)
    const log = (line: string) => {
      const clean = redactSecretsInText(line, secretValues).trim()
      if (!clean) return
      logs.push(clean)
      input.onLog?.(clean)
    }

    const detected = this.detectBuildType(
      input.sourceDir,
      input.preferredBuildType || 'auto',
      input.dockerfilePath || 'Dockerfile'
    )
    log(`Detected build driver: ${detected}`)

    if (detected === 'dockerfile') {
      const avail = await this.dockerAdapter.detectAvailability()
      if (!avail.available) {
        throw new Error(
          `Dockerfile build requires a running Docker daemon (${avail.reason || 'docker unavailable'}). Switch build type to node/python/static or start Docker.`
        )
      }
      const contextDir = assertPathWithinBase(input.sourceDir, input.buildContext || '.')
      const dfPath = assertPathWithinBase(input.sourceDir, input.dockerfilePath || 'Dockerfile')
      if (!fs.existsSync(dfPath)) {
        throw new Error(`Dockerfile not found at "${input.dockerfilePath || 'Dockerfile'}"`)
      }
      const tag = `kathal-${input.appSlug}:${input.deploymentId.slice(0, 14).toLowerCase()}`
      const built = await this.dockerAdapter.buildImage({
        contextDir,
        dockerfilePath: dfPath,
        tag,
        signal: input.signal,
        onLog: log,
      })
      return {
        buildType: 'dockerfile',
        artifactPath: input.releaseDir,
        imageRef: built.imageTag,
        entrypoint: 'docker',
        logs,
      }
    }

    fs.rmSync(input.releaseDir, { recursive: true, force: true })
    copyDirSync(input.sourceDir, input.releaseDir)
    log(`Staged source files into release artifact ${path.basename(input.releaseDir)}`)

    if (detected === 'node') {
      const pkgFile = path.join(input.releaseDir, 'package.json')
      let entrypoint = 'index.js'
      if (fs.existsSync(pkgFile)) {
        const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')) as {
          main?: string
          scripts?: Record<string, string>
          dependencies?: Record<string, string>
        }
        if (pkg.main && fs.existsSync(assertPathWithinBase(input.releaseDir, pkg.main))) {
          entrypoint = pkg.main
        } else {
          for (const candidate of ['server.js', 'index.js', 'app.js', 'main.js', 'dist/index.js']) {
            if (fs.existsSync(path.join(input.releaseDir, candidate))) {
              entrypoint = candidate
              break
            }
          }
        }

        const depsCount = Object.keys(pkg.dependencies || {}).length
        if (depsCount > 0 && !fs.existsSync(path.join(input.releaseDir, 'node_modules'))) {
          const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'
          const installArgs = fs.existsSync(path.join(input.releaseDir, 'package-lock.json'))
            ? ['ci', '--omit=dev', '--no-audit', '--no-fund']
            : ['install', '--omit=dev', '--no-audit', '--no-fund']
          log(`Installing ${depsCount} Node.js dependencies via ${npmBin} ${installArgs[0]}...`)
          const res = await execFileAsync(npmBin, installArgs, {
            shell: false,
            cwd: input.releaseDir,
            env: { ...process.env, ...input.env },
            timeout: 180_000,
            signal: input.signal,
          })
          if (res.stdout) log(res.stdout)
          if (res.stderr) log(res.stderr)
        }

        if (pkg.scripts?.build) {
          const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'
          log('Executing npm run build...')
          const res = await execFileAsync(npmBin, ['run', 'build'], {
            shell: false,
            cwd: input.releaseDir,
            env: { ...process.env, ...input.env },
            timeout: 180_000,
            signal: input.signal,
          })
          if (res.stdout) log(res.stdout)
          if (res.stderr) log(res.stderr)
        }
      }
      log(`Node.js build complete (entrypoint: ${entrypoint})`)
      return {
        buildType: 'node',
        artifactPath: input.releaseDir,
        imageRef: null,
        entrypoint,
        logs,
      }
    }

    if (detected === 'python') {
      let entrypoint = 'app.py'
      for (const candidate of ['app.py', 'main.py', 'server.py']) {
        if (fs.existsSync(path.join(input.releaseDir, candidate))) {
          entrypoint = candidate
          break
        }
      }
      const pyBin = process.platform === 'win32' ? 'python' : 'python3'
      if (fs.existsSync(path.join(input.releaseDir, entrypoint))) {
        try {
          await execFileAsync(pyBin, ['-m', 'py_compile', entrypoint], {
            shell: false,
            cwd: input.releaseDir,
            timeout: 20_000,
            signal: input.signal,
          })
          log(`Verified Python syntax for ${entrypoint}`)
        } catch (err) {
          throw new Error(`Python build verification failed: ${(err as Error).message}`)
        }
      }
      return {
        buildType: 'python',
        artifactPath: input.releaseDir,
        imageRef: null,
        entrypoint,
        logs,
      }
    }

    if (detected === 'compose') {
      log('Staged Docker Compose bundle artifact')
      return {
        buildType: 'compose',
        artifactPath: input.releaseDir,
        imageRef: null,
        entrypoint: 'docker-compose.yml',
        logs,
      }
    }

    const indexPath = path.join(input.releaseDir, 'index.html')
    if (!fs.existsSync(indexPath)) {
      log('Static artifact staged (no index.html at root; default landing will serve if needed)')
    } else {
      log('Verified static index.html release artifact')
    }
    return {
      buildType: 'static',
      artifactPath: input.releaseDir,
      imageRef: null,
      entrypoint: 'index.html',
      logs,
    }
  }
}
