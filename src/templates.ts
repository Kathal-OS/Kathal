import {
  loadCentralRegistry,
  getRegistryApplications,
  getRegistryCategories,
  getRegistryAppById,
  reloadCentralRegistry,
  APP_REGISTRY_PATH,
} from './appRegistry.ts'

export type {
  AppCategoryId,
  AppConfigTemplate,
  AppHealthCheckDefinition,
  AppInstallCommands,
  AppInstallSpec,
  CompatibilityLabel,
  InstallMethod,
  ServiceTemplate,
} from './templateTypes.ts'

export {
  loadCentralRegistry,
  getRegistryApplications,
  getRegistryCategories,
  getRegistryAppById,
  reloadCentralRegistry,
  APP_REGISTRY_PATH,
}

const initialRegistry = loadCentralRegistry()

export const CATEGORY_DEFINITIONS = initialRegistry.categories
export const SERVICE_TEMPLATES = initialRegistry.applications
export const COMPATIBILITY_LABELS = initialRegistry.compatibilityLabels

export function getTemplateById(id: string) {
  return getRegistryAppById(id)
}
