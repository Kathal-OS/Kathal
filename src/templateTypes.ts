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
      ? ['python3 >= 3.10', 'python3-venv', 'pip']
      : input.installMethod === 'git'
      ? ['git', 'node >= 18']
      : input.installMethod === 'binary-download'
      ? ['linux-x64 / arm64', 'curl']
      : input.installMethod === 'docker-required'
      ? ['docker', 'docker-compose']
      : [input.runtime]

  const defaultDependencies =
    input.dependencies && input.dependencies.length > 0
      ? input.dependencies
      : input.compatibility === 'External Dependencies'
      ? ['PostgreSQL or external database']
      : ['Self-contained runtime']

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
    healthCheckPath: input.healthCheckPath || '/',
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
