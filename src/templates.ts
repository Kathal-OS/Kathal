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

export type {
  AppCategoryId,
  AppConfigTemplate,
  AppInstallSpec,
  CompatibilityLabel,
  InstallMethod,
  ServiceTemplate,
} from './templateTypes.ts'

export const CATEGORY_DEFINITIONS: Record<AppCategoryId, { label: string; description: string; previewImage: string }> = {
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

const RAW_COMBINED: ServiceTemplateInput[] = [
  ...CATALOG_PART_1,
  ...CATALOG_PART_2,
  ...CATALOG_PART_3,
]

const seenIds = new Set<string>()
const seenNames = new Set<string>()
const hydrated: ServiceTemplate[] = []

for (const item of RAW_COMBINED) {
  const idKey = item.id.trim().toLowerCase()
  const nameKey = item.name.trim().toLowerCase()
  if (seenIds.has(idKey) || seenNames.has(nameKey)) {
    continue
  }
  seenIds.add(idKey)
  seenNames.add(nameKey)
  hydrated.push(hydrateTemplate(item, hydrated.length))
}

export const SERVICE_TEMPLATES: ServiceTemplate[] = hydrated

export const COMPATIBILITY_LABELS: CompatibilityLabel[] = [
  'Native',
  'Node.js',
  'Python',
  'Go Binary',
  'Java',
  'PHP',
  'External Dependencies',
  'Advanced Installation',
]

export function getTemplateById(id: string): ServiceTemplate | undefined {
  return SERVICE_TEMPLATES.find((t) => t.id === id)
}
