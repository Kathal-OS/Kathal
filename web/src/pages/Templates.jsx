import { useState, useEffect, useMemo, useCallback } from 'react'
import { Link } from 'react-router-dom'
import {
  Database,
  Globe,
  FileText,
  Wrench,
  Activity,
  Film,
  Shield,
  Cpu,
  Store,
  Search,
  Download,
  ExternalLink,
  Star,
  BookOpen,
  Code2,
  Trash2,
  Briefcase,
  Workflow,
  CheckCircle2,
  AlertTriangle,
  X,
  ArrowUpRight,
  RefreshCw,
  Terminal,
} from 'lucide-react'
import { apiFetch, apiPost, apiDelete } from '../hooks/useApi'

const FAVORITES_KEY = 'kathal_appstore_favorites'

function readFavorites() {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

const CATEGORY_ICONS = {
  databases: Database,
  webservers: Globe,
  cms: FileText,
  devtools: Wrench,
  business: Briefcase,
  ai: Cpu,
  monitoring: Activity,
  media: Film,
  networking: Shield,
  automation: Workflow,
}

export default function Templates() {
  const [templates, setTemplates] = useState([])
  const [categories, setCategories] = useState({})
  const [categoryDefs, setCategoryDefs] = useState({})
  const [compatibilityLabels, setCompatibilityLabels] = useState([])
  const [registryMeta, setRegistryMeta] = useState({ schemaVersion: '1.0.0', updatedAt: null })
  const [reloadingRegistry, setReloadingRegistry] = useState(false)
  const [totalCount, setTotalCount] = useState(0)
  const [installations, setInstallations] = useState([])
  const [runtimes, setRuntimes] = useState(null)
  const [loading, setLoading] = useState(true)

  const [search, setSearch] = useState('')
  const [filterCat, setFilterCat] = useState('')
  const [filterCompat, setFilterCompat] = useState('All Runtimes')
  const [filterDifficulty, setFilterDifficulty] = useState('')
  const [quickTab, setQuickTab] = useState('all') // all | featured | recent | dockerfree | favorites | installed
  const [sortBy, setSortBy] = useState('popular') // popular | alpha | recent
  const [favorites, setFavorites] = useState(readFavorites)

  // Modal install state
  const [selected, setSelected] = useState(null)
  const [preflight, setPreflight] = useState(null)
  const [preflightLoading, setPreflightLoading] = useState(false)
  const [deployForm, setDeployForm] = useState({ name: '', hostPort: '', domain: '', autoDomain: true, overwrite: false })
  const [deploying, setDeploying] = useState(false)
  const [activeInstall, setActiveInstall] = useState(null)
  const [deployError, setDeployError] = useState(null)

  const loadCatalog = useCallback(async () => {
    setLoading(true)
    try {
      const [registryResp, instList, rtReport] = await Promise.all([
        apiFetch('/registry'),
        apiFetch('/installations'),
        apiFetch('/runtimes'),
      ])
      const apps = registryResp?.applications || []
      setTemplates(apps)
      setCategories(registryResp?.categoryCounts || {})
      setCategoryDefs(registryResp?.categories || {})
      setCompatibilityLabels(registryResp?.compatibilityLabels || [])
      setRegistryMeta({
        schemaVersion: registryResp?.schemaVersion || '1.0.0',
        updatedAt: registryResp?.updatedAt || null,
      })
      setTotalCount(registryResp?.totalApps || apps.length)
      setInstallations(instList || [])
      setRuntimes(rtReport || null)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [])

  async function handleReloadRegistry() {
    setReloadingRegistry(true)
    try {
      await apiPost('/registry/reload', {})
      await loadCatalog()
    } catch (e) {
      console.error(e)
    } finally {
      setReloadingRegistry(false)
    }
  }

  useEffect(() => {
    loadCatalog()
  }, [loadCatalog])

  // Poll active modal installation progress
  useEffect(() => {
    if (!activeInstall || activeInstall.installStatus !== 'installing') return
    const timer = setInterval(async () => {
      try {
        const updated = await apiFetch(`/installations/${activeInstall.id}`)
        setActiveInstall(updated)
        if (updated.installStatus !== 'installing') {
          const instList = await apiFetch('/installations')
          setInstallations(instList || [])
        }
      } catch {
        // ignore transient poll errors
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [activeInstall?.id, activeInstall?.installStatus])

  const installationByTemplate = useMemo(() => {
    const map = new Map()
    for (const inst of installations) {
      map.set(inst.templateId, inst)
    }
    return map
  }, [installations])

  const filteredTemplates = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = templates.filter((t) => {
      if (filterCat && t.category !== filterCat) return false
      if (filterCompat !== 'All Runtimes' && t.compatibility !== filterCompat) return false
      if (filterDifficulty && t.difficulty !== filterDifficulty) return false
      if (quickTab === 'featured' && !t.featured) return false
      if (quickTab === 'recent' && t.addedAt < '2026-01-01') return false
      if (quickTab === 'dockerfree' && !t.dockerFreeSupported) return false
      if (quickTab === 'favorites' && !favorites.includes(t.id)) return false
      if (quickTab === 'installed' && !installationByTemplate.has(t.id)) return false
      if (q) {
        const matches =
          t.name.toLowerCase().includes(q) ||
          t.id.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          t.category.toLowerCase().includes(q) ||
          t.runtime.toLowerCase().includes(q) ||
          t.compatibility.toLowerCase().includes(q) ||
          (t.tags || []).some((tag) => tag.toLowerCase().includes(q))
        if (!matches) return false
      }
      return true
    })

    const sorted = [...list]
    if (sortBy === 'alpha') {
      sorted.sort((a, b) => a.name.localeCompare(b.name))
    } else if (sortBy === 'recent') {
      sorted.sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || '') || (b.popularity || 0) - (a.popularity || 0))
    } else {
      sorted.sort((a, b) => (b.popularity || 0) - (a.popularity || 0) || a.name.localeCompare(b.name))
    }
    return sorted
  }, [templates, filterCat, filterCompat, filterDifficulty, quickTab, favorites, installationByTemplate, search, sortBy])

  function toggleFavorite(e, id) {
    e.preventDefault()
    e.stopPropagation()
    const next = favorites.includes(id)
      ? favorites.filter((x) => x !== id)
      : [...favorites, id]
    setFavorites(next)
    try {
      localStorage.setItem(FAVORITES_KEY, JSON.stringify(next))
    } catch {
      // ignore storage errors
    }
  }

  async function openInstallModal(tmpl) {
    setSelected(tmpl)
    setDeployForm({
      name: tmpl.id,
      hostPort: String(tmpl.defaultPort || 8080),
      domain: '',
      autoDomain: true,
      overwrite: false,
    })
    setDeployError(null)
    setActiveInstall(installationByTemplate.get(tmpl.id) || null)
    setPreflight(null)
    setPreflightLoading(true)
    try {
      const pf = await apiFetch(`/templates/${tmpl.id}/preflight`)
      setPreflight(pf)
    } catch (err) {
      setDeployError(err.message || 'Preflight check failed')
    } finally {
      setPreflightLoading(false)
    }
  }

  async function handleInstallSubmit(e) {
    e.preventDefault()
    if (!selected) return
    setDeploying(true)
    setDeployError(null)
    try {
      const res = await apiPost(`/templates/${selected.id}/install`, {
        name: deployForm.name,
        hostPort: Number(deployForm.hostPort) || undefined,
        domain: deployForm.domain.trim(),
        autoDomain: deployForm.autoDomain,
        overwrite: deployForm.overwrite,
      })
      setActiveInstall(res.installation)
      const instList = await apiFetch('/installations')
      setInstallations(instList || [])
    } catch (err) {
      setDeployError(err.message || 'Installation failed')
    } finally {
      setDeploying(false)
    }
  }

  async function handleQuickUninstall(instId) {
    try {
      await apiDelete(`/installations/${instId}?keepData=false`)
      setActiveInstall(null)
      const instList = await apiFetch('/installations')
      setInstallations(instList || [])
      if (selected) {
        const pf = await apiFetch(`/templates/${selected.id}/preflight`)
        setPreflight(pf)
      }
    } catch (err) {
      setDeployError(err.message || 'Uninstall failed')
    }
  }

  const hostRuntimes = runtimes?.runtimes || {}
  const compatOptions = ['All Runtimes', ...(compatibilityLabels || [])]

  return (
    <div className="p-6 sm:p-8 max-w-7xl mx-auto space-y-6">
      {/* Header & Search */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-100">App Store &amp; Templates</h1>
          <p className="text-slate-400 text-sm mt-1">
            {totalCount} open-source applications loaded from the central JSON registry (schema v{registryMeta.schemaVersion}) with installation commands and health checks.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative w-full sm:w-72">
            <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              placeholder="Search 100+ apps, runtimes, tags..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2 bg-[#111827] border border-slate-800 rounded-lg text-sm text-slate-200 placeholder:text-slate-500 focus:border-kathal-500 focus:outline-none"
            />
          </div>

          <select
            aria-label="Sort applications"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            className="bg-[#111827] border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:border-kathal-500 focus:outline-none"
          >
            <option value="popular">Sort: Popularity</option>
            <option value="alpha">Sort: Alphabetical (A–Z)</option>
            <option value="recent">Sort: Recently Added</option>
          </select>

          <button
            type="button"
            onClick={handleReloadRegistry}
            disabled={reloadingRegistry}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-[#111827] hover:bg-slate-800 border border-slate-800 rounded-lg text-xs text-slate-300 whitespace-nowrap"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${reloadingRegistry ? 'animate-spin' : ''}`} />
            <span>Reload Registry</span>
          </button>
        </div>
      </div>

      {/* Host Runtime Readiness Bar */}
      {runtimes && (
        <div className="bg-[#111827] border border-slate-800/90 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <span className="text-slate-400 font-medium">Host Runtimes ({runtimes.platform}/{runtimes.arch}):</span>
            {['node', 'npm', 'python3', 'pythonVenv', 'git', 'curl', 'docker', 'java', 'php'].map((key) => {
              const item = hostRuntimes[key]
              if (!item) return null
              return (
                <span key={key} className="inline-flex items-center gap-1.5 whitespace-nowrap">
                  {item.available ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                  ) : (
                    <AlertTriangle className="w-3.5 h-3.5 text-slate-500" />
                  )}
                  <span className={item.available ? 'text-slate-200' : 'text-slate-500'}>{item.label}</span>
                </span>
              )
            })}
          </div>
          <span className="text-slate-500 tabular-nums">
            Showing {filteredTemplates.length} of {totalCount} apps
          </span>
        </div>
      )}

      {/* Quick Collection Tabs + Runtime & Difficulty Filters */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 bg-[#111827] border border-slate-800 rounded-lg flex-wrap">
          {[
            { id: 'all', label: 'All Apps' },
            { id: 'featured', label: 'Featured' },
            { id: 'recent', label: 'Recently Added' },
            { id: 'dockerfree', label: 'Docker-Free' },
            { id: 'favorites', label: `Favorites (${favorites.length})` },
            { id: 'installed', label: `Installed (${installations.length})` },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setQuickTab(tab.id)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
                quickTab === tab.id
                  ? 'bg-kathal-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Filter by runtime compatibility"
            value={filterCompat}
            onChange={(e) => setFilterCompat(e.target.value)}
            className="bg-[#111827] border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-200 focus:border-kathal-500 focus:outline-none"
          >
            {compatOptions.map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>

          <select
            aria-label="Filter by installation difficulty"
            value={filterDifficulty}
            onChange={(e) => setFilterDifficulty(e.target.value)}
            className="bg-[#111827] border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-200 focus:border-kathal-500 focus:outline-none"
          >
            <option value="">All Difficulty</option>
            <option value="easy">Difficulty: Easy</option>
            <option value="medium">Difficulty: Medium</option>
            <option value="hard">Difficulty: Hard</option>
          </select>
        </div>
      </div>

      {/* Category Filter Buttons */}
      <div className="flex gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => setFilterCat('')}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium border whitespace-nowrap shrink-0 transition-colors ${
            !filterCat
              ? 'bg-kathal-600 border-kathal-500 text-white'
              : 'bg-[#111827] border-slate-800 text-slate-400 hover:text-slate-200'
          }`}
        >
          All Categories ({totalCount})
        </button>
        {Object.entries(categoryDefs).map(([key, def]) => {
          const Icon = CATEGORY_ICONS[key] || Store
          const count = categories[key] || 0
          return count ? (
            <button
              key={key}
              type="button"
              onClick={() => setFilterCat(key)}
              title={def.description}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border whitespace-nowrap shrink-0 transition-colors ${
                filterCat === key
                  ? 'bg-kathal-600 border-kathal-500 text-white'
                  : 'bg-[#111827] border-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span>{def.label} ({count})</span>
            </button>
          ) : null
        })}
      </div>

      {/* App Grid */}
      {loading ? (
        <div className="bg-[#111827] border border-slate-800/90 rounded-xl p-12 text-center text-slate-400 text-sm">
          Loading {totalCount || '100+'} applications...
        </div>
      ) : filteredTemplates.length === 0 ? (
        <div className="bg-[#111827] border border-slate-800/90 rounded-xl p-12 text-center space-y-3">
          <Store className="w-10 h-10 text-slate-600 mx-auto" />
          <h2 className="text-lg font-semibold text-slate-200">No Matching Applications</h2>
          <p className="text-sm text-slate-400">Clear your filters or search query to browse all {totalCount} apps.</p>
          <button
            type="button"
            onClick={() => {
              setSearch('')
              setFilterCat('')
              setFilterCompat('All Runtimes')
              setFilterDifficulty('')
              setQuickTab('all')
            }}
            className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200"
          >
            Reset All Filters
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filteredTemplates.map((t) => {
            const cat = categoryDefs[t.category]
            const inst = installationByTemplate.get(t.id)
            const isFav = favorites.includes(t.id)

            return (
              <div
                key={t.id}
                className="bg-[#111827] border border-slate-800/90 hover:border-slate-700 rounded-xl p-5 flex flex-col justify-between transition-colors"
              >
                <div className="space-y-3">
                  {/* Top Row: Icon + Title + Favorite */}
                  <div className="flex items-start justify-between gap-3">
                    <Link to={`/templates/${t.id}`} className="flex items-center gap-3 min-w-0 group">
                      <div
                        className="w-11 h-11 rounded-xl border border-slate-700/80 flex items-center justify-center text-xl shrink-0"
                        style={{ backgroundColor: `${t.accentColor || '#cc482e'}18` }}
                      >
                        <span aria-hidden="true">{t.icon}</span>
                      </div>
                      <div className="min-w-0">
                        <h3 className="font-semibold text-slate-100 group-hover:text-kathal-300 truncate transition-colors">
                          {t.name}
                        </h3>
                        <p className="text-xs text-slate-400 truncate">
                          {cat?.label || t.category} · v{t.version}
                        </p>
                      </div>
                    </Link>

                    <button
                      type="button"
                      onClick={(e) => toggleFavorite(e, t.id)}
                      aria-label={isFav ? `Remove ${t.name} from favorites` : `Add ${t.name} to favorites`}
                      className="p-1.5 rounded-lg text-slate-500 hover:text-amber-400 hover:bg-slate-800/80 shrink-0"
                    >
                      <Star className={`w-4 h-4 ${isFav ? 'fill-amber-400 text-amber-400' : ''}`} />
                    </button>
                  </div>

                  {/* Description */}
                  <p className="text-sm text-slate-300 line-clamp-2 leading-relaxed">{t.description}</p>

                  {/* Unboxed Metadata Line */}
                  <div className="text-xs text-slate-400 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-slate-200 font-medium">{t.compatibility}</span>
                      <span aria-hidden="true">·</span>
                      <span>{t.runtime}</span>
                      <span aria-hidden="true">·</span>
                      <span className={t.dockerFreeSupported ? 'text-emerald-400' : 'text-amber-400'}>
                        {t.dockerFreeSupported ? 'Docker-Free' : 'Requires Docker'}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-500 truncate">
                      Requires: {(t.requirements || []).join(', ')}
                    </p>
                  </div>
                </div>

                {/* Footer Links & Action Buttons */}
                <div className="pt-4 mt-4 border-t border-slate-800/80 space-y-3">
                  <div className="flex items-center justify-between gap-2 text-xs text-slate-400">
                    <div className="flex items-center gap-3 min-w-0">
                      <a
                        href={t.website}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 hover:text-slate-200 whitespace-nowrap"
                      >
                        <Globe className="w-3 h-3" />
                        <span>Site</span>
                      </a>
                      <a
                        href={t.github}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 hover:text-slate-200 whitespace-nowrap"
                      >
                        <Code2 className="w-3 h-3" />
                        <span>GitHub</span>
                      </a>
                      <a
                        href={t.docs}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 hover:text-slate-200 whitespace-nowrap"
                      >
                        <BookOpen className="w-3 h-3" />
                        <span>Docs</span>
                      </a>
                    </div>
                    <Link
                      to={`/templates/${t.id}`}
                      className="inline-flex items-center gap-0.5 text-slate-300 hover:text-white font-medium whitespace-nowrap"
                    >
                      <span>Details</span>
                      <ArrowUpRight className="w-3.5 h-3.5" />
                    </Link>
                  </div>

                  <div className="flex items-center gap-2">
                    {inst ? (
                      <>
                        {inst.state === 'running' ? (
                          <a
                            href={inst.liveUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white whitespace-nowrap"
                          >
                            <span>Launch</span>
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                        ) : (
                          <button
                            type="button"
                            onClick={() => openInstallModal(t)}
                            className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 whitespace-nowrap"
                          >
                            <span>Manage</span>
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleQuickUninstall(inst.id)}
                          className="inline-flex items-center justify-center gap-1 px-3 py-2 rounded-lg bg-red-600/15 hover:bg-red-600/25 border border-red-500/30 text-xs font-medium text-red-300 whitespace-nowrap"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>Uninstall</span>
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => openInstallModal(t)}
                        className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-kathal-600 hover:bg-kathal-500 text-xs font-semibold text-white whitespace-nowrap transition-colors"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>{t.dockerFreeSupported ? 'Install' : 'Requirements'}</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Install & Preflight Modal */}
      {selected && (
        <div
          className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          onClick={() => setSelected(null)}
        >
          <div
            className="bg-[#111827] border border-slate-800 rounded-2xl p-6 max-w-xl w-full max-h-[90vh] overflow-y-auto shadow-2xl space-y-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3.5">
                <div className="w-11 h-11 rounded-xl bg-slate-800 border border-slate-700 flex items-center justify-center text-2xl shrink-0">
                  <span aria-hidden="true">{selected.icon}</span>
                </div>
                <div>
                  <h2 className="text-xl font-bold text-slate-100">{selected.name}</h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {selected.compatibility} · {selected.runtime} · v{selected.version}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelected(null)}
                aria-label="Close modal"
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Real Preflight Check Results */}
            <div className="bg-slate-900/75 border border-slate-800 rounded-xl p-4 space-y-2.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-slate-200">Runtime &amp; Dependency Preflight</span>
                {preflightLoading ? (
                  <span className="text-slate-400">Checking host...</span>
                ) : preflight?.installable ? (
                  <span className="text-emerald-400 font-medium">Ready to Install</span>
                ) : (
                  <span className="text-amber-400 font-medium">Blocked: Missing Requirements</span>
                )}
              </div>

              {(preflight?.checks || []).map((c, idx) => (
                <div key={idx} className="flex items-start gap-2">
                  {c.ok ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                  ) : (
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                  )}
                  <div>
                    <span className="text-slate-200">{c.label}: </span>
                    <span className="text-slate-400">{c.detail}</span>
                  </div>
                </div>
              ))}

              {(preflight?.remediation || []).length > 0 && (
                <div className="pt-2 border-t border-slate-800 text-amber-300 space-y-1">
                  {preflight.remediation.map((msg, i) => (
                    <p key={i}>{msg}</p>
                  ))}
                </div>
              )}
            </div>

            {selected.installCommands && (
              <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3.5 text-[11px] space-y-1.5">
                <div className="flex items-center justify-between text-slate-300">
                  <span className="inline-flex items-center gap-1.5 font-medium">
                    <Terminal className="w-3.5 h-3.5 text-slate-400" />
                    <span>Registry Recipe ({selected.installCommands.mode})</span>
                  </span>
                  {selected.healthCheck && (
                    <span className="font-mono text-slate-400">
                      Health: {selected.healthCheck.type.toUpperCase()} {selected.healthCheck.path}
                    </span>
                  )}
                </div>
                <pre className="font-mono text-slate-400 overflow-x-auto whitespace-pre-wrap">
                  {[...(selected.installCommands.install || []), ...(selected.installCommands.start || [])].join('\n')}
                </pre>
              </div>
            )}

            {deployError && (
              <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-xs">
                {deployError}
              </div>
            )}

            {activeInstall ? (
              <div className="space-y-3 bg-slate-900/70 border border-slate-800 rounded-xl p-4">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-slate-200 capitalize">
                    Status: {activeInstall.phase} ({activeInstall.installStatus})
                  </span>
                  <span className="font-mono tabular-nums text-slate-300">{activeInstall.progress}%</span>
                </div>
                <div className="h-2 w-full rounded-full bg-slate-950 overflow-hidden">
                  <div
                    className={`h-full transition-all duration-300 ${
                      activeInstall.installStatus === 'failed'
                        ? 'bg-red-500'
                        : activeInstall.installStatus === 'installed'
                        ? 'bg-emerald-500'
                        : 'bg-kathal-500'
                    }`}
                    style={{ width: `${activeInstall.progress}%` }}
                  />
                </div>
                <pre className="bg-[#070B12] border border-slate-800 rounded-lg p-3 text-[11px] font-mono text-slate-300 max-h-44 overflow-y-auto whitespace-pre-wrap">
                  {(activeInstall.logs || []).map((l) => l.content).join('\n') || 'Starting...'}
                </pre>
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <Link
                    to={`/templates/${selected.id}`}
                    className="text-xs text-kathal-400 hover:text-kathal-300 font-medium"
                  >
                    Open Full Details Page →
                  </Link>
                  <div className="flex items-center gap-2">
                    {activeInstall.state === 'running' && (
                      <a
                        href={activeInstall.liveUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-medium text-white"
                      >
                        <span>Launch App</span>
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={() => handleQuickUninstall(activeInstall.id)}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-red-600/20 hover:bg-red-600/30 text-xs font-medium text-red-300"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Uninstall</span>
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <form onSubmit={handleInstallSubmit} className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">App Name</label>
                    <input
                      type="text"
                      value={deployForm.name}
                      onChange={(e) => setDeployForm({ ...deployForm, name: e.target.value })}
                      className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-kathal-500 focus:outline-none"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Local Port</label>
                    <input
                      type="number"
                      value={deployForm.hostPort}
                      onChange={(e) => setDeployForm({ ...deployForm, hostPort: e.target.value })}
                      className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 tabular-nums focus:border-kathal-500 focus:outline-none"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-slate-400 mb-1">Custom Domain (optional)</label>
                  <input
                    type="text"
                    value={deployForm.domain}
                    onChange={(e) => setDeployForm({ ...deployForm, domain: e.target.value })}
                    placeholder={`${selected.id}.local`}
                    className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-kathal-500 focus:outline-none"
                  />
                </div>

                <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={deployForm.autoDomain}
                    onChange={(e) => setDeployForm({ ...deployForm, autoDomain: e.target.checked })}
                    className="w-4 h-4 accent-kathal-500 rounded"
                  />
                  <span>Connect local reverse proxy route automatically</span>
                </label>

                {preflight?.alreadyExists && (
                  <label className="flex items-center gap-2 text-xs text-amber-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={deployForm.overwrite}
                      onChange={(e) => setDeployForm({ ...deployForm, overwrite: e.target.checked })}
                      className="w-4 h-4 accent-amber-500 rounded"
                    />
                    <span>Directory already exists — confirm reinstall (preserves user data/)</span>
                  </label>
                )}

                <div className="flex items-center justify-between gap-2 pt-2">
                  <Link
                    to={`/templates/${selected.id}`}
                    className="text-xs text-slate-300 hover:text-white underline-offset-4 hover:underline"
                  >
                    Full App Details &amp; Docs →
                  </Link>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setSelected(null)}
                      className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm text-slate-300"
                    >
                      Close
                    </button>
                    <button
                      type="submit"
                      disabled={deploying || preflightLoading || !preflight?.installable}
                      className="inline-flex items-center gap-2 px-5 py-2 bg-kathal-600 hover:bg-kathal-500 text-white rounded-lg text-sm font-medium disabled:opacity-45 disabled:cursor-not-allowed"
                    >
                      <Download className="w-4 h-4" />
                      <span>{deploying ? 'Installing...' : 'Install App'}</span>
                    </button>
                  </div>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
