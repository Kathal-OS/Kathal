export type CompatibilityLabel =
  | 'Native'
  | 'Node.js'
  | 'Python'
  | 'Go Binary'
  | 'Java'
  | 'PHP'
  | 'External Dependencies'
  | 'Advanced Installation'

export type InstallMethod =
  | 'npm'
  | 'python-venv'
  | 'binary-download'
  | 'git'
  | 'system-binary'
  | 'docker-required'
  | 'external-guide'

export type AppCategoryId =
  | 'databases'
  | 'webservers'
  | 'cms'
  | 'devtools'
  | 'business'
  | 'ai'
  | 'monitoring'
  | 'media'
  | 'networking'
  | 'automation'

export interface AppConfigTemplate {
  filename: string
  format: 'env' | 'json' | 'yaml' | 'toml'
  content: string
}

export interface AppInstallCommands {
  mode: 'node' | 'python' | 'binary' | 'git' | 'system' | 'docker' | 'external'
  prepare: string[]
  install: string[]
  start: string[]
  env: Record<string, string>
}

export interface AppHealthCheckDefinition {
  type: 'http' | 'tcp'
  path: string
  expectedStatus: number[]
  intervalSeconds: number
  timeoutMs: number
  retries: number
}

export interface AppInstallSpec {
  npmPackage?: string
  npmBin?: string
  npmArgs?: string[]
  pythonPackage?: string
  pythonBin?: string
  pythonArgs?: string[]
  gitRepo?: string
  gitBranch?: string
  binaryUrls?: {
    linux_x64?: string
    linux_arm64?: string
    darwin_x64?: string
    darwin_arm64?: string
    win32_x64?: string
    win32_arm64?: string
  }
  binaryName?: string
  binaryArchive?: 'zip' | 'tar.gz' | 'bz2' | 'raw'
  binaryArgs?: string[]
  systemBinary?: string
  systemArgs?: string[]
  installNotes?: string
}

export interface ServiceTemplateInput {
  id: string
  name: string
  description: string
  overview?: string
  features?: string[]
  icon: string
  accentColor?: string
  category: AppCategoryId
  image: string
  ports: string[]
  volumes: string[]
  env_vars: string[]
  command?: string
  version: string
  website: string
  github: string
  docs: string
  runtime: string
  compatibility: CompatibilityLabel
  difficulty: 'easy' | 'medium' | 'hard'
  popularity?: number
  addedAt?: string
  featured?: boolean
  dockerFreeSupported: boolean
  installMethod: InstallMethod
  requirements?: string[]
  dependencies?: string[]
  healthCheckPath?: string
  healthCheck?: Partial<AppHealthCheckDefinition>
  installCommands?: Partial<AppInstallCommands>
  configTemplate?: AppConfigTemplate
  installSpec?: AppInstallSpec
  configInstructions?: string[]
  troubleshooting?: { issue: string; fix: string }[]
  tags: string[]
}

export interface ServiceTemplate extends ServiceTemplateInput {
  overview: string
  features: string[]
  accentColor: string
  defaultPort: number
  popularity: number
  addedAt: string
  featured: boolean
  requirements: string[]
  dependencies: string[]
  healthCheckPath: string
  healthCheck: AppHealthCheckDefinition
  installCommands: AppInstallCommands
  configTemplate: AppConfigTemplate
  configInstructions: string[]
  troubleshooting: { issue: string; fix: string }[]
}

const DEFAULT_CATEGORY_COLORS: Record<AppCategoryId, string> = {
  databases: '#0ea5e9',
  webservers: '#10b981',
  cms: '#6366f1',
  devtools: '#f59e0b',
  business: '#ec4899',
  ai: '#8b5cf6',
  monitoring: '#22c55e',
  media: '#f97316',
  networking: '#06b6d4',
  automation: '#cc482e',
}

function parseEnvRecord(envList: string[], defaultPort: number): Record<string, string> {
  const out: Record<string, string> = {
    PORT: '{PORT}',
    HOST: '127.0.0.1',
    DATA_DIR: '{DATA_DIR}',
  }
  for (const item of envList || []) {
    const idx = item.indexOf('=')
    if (idx > 0) {
      out[item.slice(0, idx).trim()] = item.slice(idx + 1).trim()
    }
  }
  if (!out.PORT) out.PORT = String(defaultPort)
  return out
}

function buildInstallCommands(input: ServiceTemplateInput, defaultPort: number): AppInstallCommands {
  const spec = input.installSpec || {}
  const env = parseEnvRecord(input.env_vars, defaultPort)

  if (input.installCommands?.mode) {
    return {
      mode: input.installCommands.mode,
      prepare: input.installCommands.prepare || [],
      install: input.installCommands.install || [],
      start: input.installCommands.start || [],
      env: input.installCommands.env || env,
    }
  }

  if (input.installMethod === 'npm') {
    const pkg = spec.npmPackage || input.id
    const bin = spec.npmBin || pkg.split('/').pop() || input.id
    const args = (spec.npmArgs || []).join(' ')
    return {
      mode: 'node',
      prepare: ['mkdir -p {DIR}/data', 'npm init -y'],
      install: [`npm install --no-audit --no-fund --omit=dev ${pkg}`],
      start: [`{DIR}/node_modules/.bin/${bin}${args ? ` ${args}` : ''}`],
      env,
    }
  }

  if (input.installMethod === 'python-venv') {
    const pkg = spec.pythonPackage || input.id
    const bin = spec.pythonBin || 'python'
    const args = (spec.pythonArgs || []).join(' ')
    const isWin = process.platform === 'win32'
    const pyCmd = isWin ? 'python' : 'python3'
    const venvBin = isWin ? '{DIR}\\.venv\\Scripts' : '{DIR}/.venv/bin'
    return {
      mode: 'python',
      prepare: [`${pyCmd} -m venv {DIR}/.venv`],
      install: [`${venvBin}/pip install --no-input ${pkg}`],
      start: [`${venvBin}/${bin}${args ? ` ${args}` : ''}`],
      env,
    }
  }

  if (input.installMethod === 'binary-download') {
    const archKey =
      process.platform === 'win32'
        ? 'win32_x64'
        : process.platform === 'darwin'
        ? process.arch === 'arm64'
          ? 'darwin_arm64'
          : 'darwin_x64'
        : process.arch === 'arm64'
        ? 'linux_arm64'
        : 'linux_x64'
    const url =
      spec.binaryUrls?.[archKey] ||
      spec.binaryUrls?.linux_x64 ||
      spec.binaryUrls?.darwin_arm64 ||
      spec.binaryUrls?.win32_x64 ||
      ''
    const archive = url.endsWith('.zip')
      ? 'zip'
      : url.endsWith('.tar.gz') || url.endsWith('.tgz')
      ? 'tar.gz'
      : url.endsWith('.bz2')
      ? 'bz2'
      : spec.binaryArchive || 'raw'
    const binName = spec.binaryName || input.id
    const args = (spec.binaryArgs || []).join(' ')
    const extractStep =
      archive === 'zip'
        ? 'Extract ZIP into {DIR}/bin'
        : archive === 'tar.gz'
        ? 'tar -xzf {DIR}/download.tar.gz -C {DIR}/bin'
        : archive === 'bz2'
        ? 'bzip2 -df {DIR}/download.bz2'
        : `chmod +x {DIR}/bin/${binName} (POSIX)`
    return {
      mode: 'binary',
      prepare: ['mkdir {DIR}/bin', 'mkdir {DATA_DIR}'],
      install: url
        ? [`Download ${url}`, extractStep]
        : [`# Download ${input.name} binary from ${input.github}/releases`],
      start: [`{DIR}/bin/${binName}${args ? ` ${args}` : ''}`],
      env,
    }
  }

  if (input.installMethod === 'git') {
    const repo = spec.gitRepo || input.github
    const branch = spec.gitBranch || 'main'
    return {
      mode: 'git',
      prepare: ['Prepare isolated {DATA_DIR}'],
      install: [`git clone --depth 1 --branch ${branch} ${repo} {DIR}`, 'npm install --no-audit --no-fund --omit=dev'],
      start: [input.command || 'npm run start'],
      env,
    }
  }

  if (input.installMethod === 'system-binary') {
    const bin = spec.systemBinary || input.id
    const args = (spec.systemArgs || []).join(' ')
    return {
      mode: 'system',
      prepare: ['Prepare isolated {DATA_DIR}'],
      install: [`# Ensure ${bin} is installed on PATH for your OS`],
      start: [`${bin}${args ? ` ${args}` : ''}`],
      env,
    }
  }

  if (input.installMethod === 'docker-required' || !input.dockerFreeSupported) {
    return {
      mode: 'docker',
      prepare: ['mkdir -p {DIR}/data'],
      install: [`docker pull ${input.image}`],
      start: [`docker run -d --name ${input.id} -p {PORT}:${defaultPort} ${input.image}`],
      env,
    }
  }

  return {
    mode: 'external',
    prepare: ['mkdir -p {DIR}/data'],
    install: [spec.installNotes || `# Follow official installation docs: ${input.docs}`],
    start: [input.command || `# Launch ${input.name} on port {PORT}`],
    env,
  }
}

function buildHealthCheck(input: ServiceTemplateInput): AppHealthCheckDefinition {
  const tcpOnlyIds = new Set(['postgres', 'mysql', 'mariadb', 'mongodb', 'redis', 'mosquitto', 'duckdb'])
  const isTcp = tcpOnlyIds.has(input.id) || (input.category === 'databases' && input.healthCheckPath === undefined && ['postgres', 'mysql', 'mariadb', 'mongodb', 'redis'].includes(input.id))
  return {
    type: input.healthCheck?.type || (isTcp ? 'tcp' : 'http'),
    path: input.healthCheck?.path || input.healthCheckPath || '/',
    expectedStatus: input.healthCheck?.expectedStatus || [200, 204, 301, 302, 401],
    intervalSeconds: input.healthCheck?.intervalSeconds || 30,
    timeoutMs: input.healthCheck?.timeoutMs || 3000,
    retries: input.healthCheck?.retries || 3,
  }
}

export function hydrateTemplate(input: ServiceTemplateInput, index: number): ServiceTemplate {
  const firstPortRaw = (input.ports?.[0] || '8080:8080').split('/')[0]
  const parsedPort = Number(firstPortRaw.split(':')[0])
  const defaultPort = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 8080

  const envLines = (input.env_vars || []).length
    ? input.env_vars.join('\n')
    : `PORT=${defaultPort}\nHOST=127.0.0.1`

  const defaultRequirements =
    input.requirements && input.requirements.length > 0
      ? input.requirements
      : input.installMethod === 'npm'
      ? ['node >= 18', 'npm']
      : input.installMethod === 'python-venv'
      ? ['python >= 3.10', 'venv', 'pip']
      : input.installMethod === 'git'
      ? ['git', 'node >= 18']
      : input.installMethod === 'binary-download'
      ? ['Windows / macOS / Linux']
      : input.installMethod === 'docker-required'
      ? ['docker', 'docker-compose']
      : [input.runtime]

  const defaultDependencies =
    input.dependencies && input.dependencies.length > 0
      ? input.dependencies
      : input.compatibility === 'External Dependencies'
      ? ['PostgreSQL or external database']
      : ['Self-contained runtime']

  const healthCheck = buildHealthCheck(input)
  const installCommands = buildInstallCommands(input, defaultPort)

  return {
    ...input,
    overview:
      input.overview ||
      `${input.name} is an open-source, self-hosted ${input.category} platform (${input.runtime}). ${input.description}. Runs with isolated application directories, dedicated port allocation, and reverse proxy domain routing.`,
    features:
      input.features && input.features.length > 0
        ? input.features
        : [
            `Dedicated ${input.runtime} runtime configuration`,
            `Automatic port assignment (default ${defaultPort}) and health verification`,
            `Isolated environment variables and persistent local data storage`,
            `Direct local domain & TLS reverse proxy integration`,
          ],
    accentColor: input.accentColor || DEFAULT_CATEGORY_COLORS[input.category] || '#cc482e',
    defaultPort,
    popularity: input.popularity ?? Math.max(40, 96 - Math.floor(index * 0.4)),
    addedAt: input.addedAt || (index < 35 ? '2025-10-01' : '2026-11-21'),
    featured: Boolean(input.featured),
    requirements: defaultRequirements,
    dependencies: defaultDependencies,
    healthCheckPath: healthCheck.path,
    healthCheck,
    installCommands,
    configTemplate: input.configTemplate || {
      filename: '.env',
      format: 'env',
      content: `# ${input.name} Configuration\nPORT={PORT}\nHOST=127.0.0.1\nDATA_DIR={DATA_DIR}\n${envLines}\n`,
    },
    configInstructions:
      input.configInstructions && input.configInstructions.length > 0
        ? input.configInstructions
        : [
            `Review generated .env and configuration files inside the isolated app directory before launch.`,
            `Ensure port ${defaultPort} (or your chosen host port) is free and reachable via KATHAL's reverse proxy.`,
            `Bind custom domains under Domains & Proxy to expose ${input.name} cleanly over HTTPS.`,
          ],
    troubleshooting:
      input.troubleshooting && input.troubleshooting.length > 0
        ? input.troubleshooting
        : [
            {
              issue: 'Port already in use on host',
              fix: 'Leave port blank or pick an alternate port between 9000–64000; the installer auto-allocates a free port.',
            },
            {
              issue: 'Missing runtime or dependency error during preflight',
              fix: `Verify ${defaultRequirements.join(', ')} are installed on the host machine before launching.`,
            },
            {
              issue: 'Health check fails right after launch',
              fix: 'Open Installation & Process Logs to inspect startup stderr output and verify environment variables.',
            },
          ],
  }
}
