import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  hydrateTemplate,
  type AppCategoryId,
  type CompatibilityLabel,
  type ServiceTemplate,
  type ServiceTemplateInput,
} from './templateTypes.ts'
import { CATALOG_PART_1 } from './catalogPart1.ts'
import { CATALOG_PART_2 } from './catalogPart2.ts'
import { CATALOG_PART_3 } from './catalogPart3.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const REGISTRY_PATH = path.resolve(__dirname, '../data/registry.json')
export const APP_REGISTRY_PATH = REGISTRY_PATH

export interface CategoryDefinition {
  label: string
  description: string
  previewImage: string
}

export interface CentralAppRegistry {
  schemaVersion: string
  updatedAt: string
  totalApps: number
  categories: Record<AppCategoryId, CategoryDefinition>
  compatibilityLabels: CompatibilityLabel[]
  applications: ServiceTemplate[]
}

export const DEFAULT_CATEGORY_DEFINITIONS: Record<AppCategoryId, CategoryDefinition> = {
  databases: {
    label: 'Databases & Search',
    description: 'Relational, NoSQL, analytical, vector, and full-text search engines',
    previewImage: '/previews/database.jpg',
  },
  webservers: {
    label: 'Web Servers & Proxies',
    description: 'Reverse proxies, TLS termination, and high-throughput web servers',
    previewImage: '/previews/monitoring.jpg',
  },
  cms: {
    label: 'CMS & Knowledge',
    description: 'Headless CMS, blogs, documentation portals, and team wikis',
    previewImage: '/previews/devtools.jpg',
  },
  devtools: {
    label: 'Developer Tools',
    description: 'Git forges, API clients, docs generators, IDEs, and code quality tools',
    previewImage: '/previews/devtools.jpg',
  },
  business: {
    label: 'Business & Productivity',
    description: 'CRM, project management, low-code platforms, notes, and finance tools',
    previewImage: '/previews/devtools.jpg',
  },
  ai: {
    label: 'AI & LLM',
    description: 'Local LLM runtimes, RAG workspaces, agent builders, and inference UIs',
    previewImage: '/previews/ai.jpg',
  },
  monitoring: {
    label: 'Monitoring & Analytics',
    description: 'Metrics, uptime status pages, error tracking, alerts, and web analytics',
    previewImage: '/previews/monitoring.jpg',
  },
  media: {
    label: 'Media & Storage',
    description: 'Media servers, S3 object storage, backups, bookmarks, and file managers',
    previewImage: '/previews/database.jpg',
  },
  networking: {
    label: 'Networking & Security',
    description: 'Mesh VPNs, DNS blockers, certificate authorities, and identity providers',
    previewImage: '/previews/monitoring.jpg',
  },
  automation: {
    label: 'Automation & IoT',
    description: 'Workflow engines, orchestrators, smart home hubs, and headless browsers',
    previewImage: '/previews/ai.jpg',
  },
}

export const DEFAULT_COMPATIBILITY_LABELS: CompatibilityLabel[] = [
  'Native',
  'Node.js',
  'Python',
  'Go Binary',
  'Java',
  'PHP',
  'External Dependencies',
  'Advanced Installation',
]

function buildSeedApplications(): ServiceTemplate[] {
  const combined: ServiceTemplateInput[] = [
    ...CATALOG_PART_1,
    ...CATALOG_PART_2,
    ...CATALOG_PART_3,
  ]
  const seenIds = new Set<string>()
  const seenNames = new Set<string>()
  const applications: ServiceTemplate[] = []

  for (const item of combined) {
    const idKey = item.id.trim().toLowerCase()
    const nameKey = item.name.trim().toLowerCase()
    if (seenIds.has(idKey) || seenNames.has(nameKey)) continue
    seenIds.add(idKey)
    seenNames.add(nameKey)
    applications.push(hydrateTemplate(item, applications.length))
  }
  return applications
}

function buildInitialRegistryPayload(): CentralAppRegistry {
  const applications = buildSeedApplications()
  return {
    schemaVersion: '1.0.0',
    updatedAt: new Date().toISOString(),
    totalApps: applications.length,
    categories: DEFAULT_CATEGORY_DEFINITIONS,
    compatibilityLabels: DEFAULT_COMPATIBILITY_LABELS,
    applications,
  }
}

export function writeRegistryToDisk(registry: CentralAppRegistry): void {
  fs.mkdirSync(path.dirname(APP_REGISTRY_PATH), { recursive: true })
  const payload: CentralAppRegistry = {
    ...registry,
    totalApps: registry.applications.length,
    updatedAt: registry.updatedAt || new Date().toISOString(),
  }
  fs.writeFileSync(APP_REGISTRY_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

let cachedRegistry: { mtimeMs: number; data: CentralAppRegistry } | null = null

export function ensureCentralRegistryFile(): CentralAppRegistry {
  if (!fs.existsSync(APP_REGISTRY_PATH)) {
    const initial = buildInitialRegistryPayload()
    writeRegistryToDisk(initial)
    const stat = fs.statSync(APP_REGISTRY_PATH)
    cachedRegistry = { mtimeMs: stat.mtimeMs, data: initial }
    return initial
  }
  return loadCentralRegistry()
}

export function loadCentralRegistry(forceReload = false): CentralAppRegistry {
  if (!fs.existsSync(APP_REGISTRY_PATH)) {
    return ensureCentralRegistryFile()
  }

  const stat = fs.statSync(APP_REGISTRY_PATH)
  if (!forceReload && cachedRegistry && cachedRegistry.mtimeMs === stat.mtimeMs) {
    return cachedRegistry.data
  }

  const rawText = fs.readFileSync(APP_REGISTRY_PATH, 'utf8')
  const parsed = JSON.parse(rawText) as Partial<CentralAppRegistry>
  const rawApps = Array.isArray(parsed.applications) ? parsed.applications : []

  // Normalize & deduplicate any entries loaded from JSON so malformed edits stay safe
  const seenIds = new Set<string>()
  const seenNames = new Set<string>()
  const applications: ServiceTemplate[] = []
  for (const entry of rawApps) {
    if (!entry || !entry.id || !entry.name) continue
    const idKey = String(entry.id).trim().toLowerCase()
    const nameKey = String(entry.name).trim().toLowerCase()
    if (seenIds.has(idKey) || seenNames.has(nameKey)) continue
    seenIds.add(idKey)
    seenNames.add(nameKey)
    applications.push(hydrateTemplate(entry as ServiceTemplateInput, applications.length))
  }

  const normalized: CentralAppRegistry = {
    schemaVersion: parsed.schemaVersion || '1.0.0',
    updatedAt: parsed.updatedAt || new Date(stat.mtimeMs).toISOString(),
    totalApps: applications.length,
    categories: (parsed.categories as Record<AppCategoryId, CategoryDefinition>) || DEFAULT_CATEGORY_DEFINITIONS,
    compatibilityLabels:
      Array.isArray(parsed.compatibilityLabels) && parsed.compatibilityLabels.length > 0
        ? (parsed.compatibilityLabels as CompatibilityLabel[])
        : DEFAULT_COMPATIBILITY_LABELS,
    applications,
  }

  cachedRegistry = { mtimeMs: stat.mtimeMs, data: normalized }
  return normalized
}

export function reloadCentralRegistry(): CentralAppRegistry {
  return loadCentralRegistry(true)
}

export function getRegistryApplications(): ServiceTemplate[] {
  return loadCentralRegistry().applications
}

export function getRegistryCategories(): Record<AppCategoryId, CategoryDefinition> {
  return loadCentralRegistry().categories
}

export function getRegistryAppById(id: string): ServiceTemplate | undefined {
  return loadCentralRegistry().applications.find((app) => app.id === id)
}

// Bootstrap /data/app-registry.json if missing on first import
if (!fs.existsSync(APP_REGISTRY_PATH)) {
  ensureCentralRegistryFile()
}
