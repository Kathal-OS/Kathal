import { useState, useEffect } from 'react'
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
  Rocket,
  ExternalLink,
  ArrowRight,
  X,
} from 'lucide-react'
import { apiFetch, apiPost } from '../hooks/useApi'

const CATEGORY_META = {
  databases: { icon: Database, label: 'Databases' },
  webservers: { icon: Globe, label: 'Web Servers' },
  cms: { icon: FileText, label: 'CMS & Blogs' },
  devtools: { icon: Wrench, label: 'Dev Tools' },
  monitoring: { icon: Activity, label: 'Monitoring' },
  media: { icon: Film, label: 'Media' },
  networking: { icon: Shield, label: 'Networking' },
  ai: { icon: Cpu, label: 'AI / LLM' },
}

export default function Templates() {
  const [templates, setTemplates] = useState([])
  const [categories, setCategories] = useState({})
  const [selected, setSelected] = useState(null)
  const [search, setSearch] = useState('')
  const [filterCat, setFilterCat] = useState('')
  const [loading, setLoading] = useState(true)

  const [deployForm, setDeployForm] = useState({ name: '', hostPort: '', domain: '', autoDomain: true })
  const [deploying, setDeploying] = useState(false)
  const [deployResult, setDeployResult] = useState(null)
  const [deployError, setDeployError] = useState(null)

  useEffect(() => {
    loadData()
  }, [filterCat, search])

  async function loadData() {
    setLoading(true)
    try {
      const url = search
        ? `/templates/search?q=${encodeURIComponent(search)}`
        : filterCat
        ? `/templates?category=${filterCat}`
        : '/templates'
      const [data, cats] = await Promise.all([
        apiFetch(url),
        apiFetch('/templates/categories'),
      ])
      setTemplates(data || [])
      setCategories(cats || {})
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  function openTemplate(tmpl) {
    const firstPort = tmpl.ports?.[0] || ''
    const defaultHost = firstPort.split(':')[0] || '8080'
    setSelected(tmpl)
    setDeployForm({
      name: tmpl.id,
      hostPort: defaultHost,
      domain: '',
      autoDomain: true,
    })
    setDeployResult(null)
    setDeployError(null)
  }

  async function handleDeploy(e) {
    e.preventDefault()
    if (!selected) return
    setDeploying(true)
    setDeployError(null)
    setDeployResult(null)
    try {
      const res = await apiPost(`/templates/${selected.id}/deploy`, {
        name: deployForm.name,
        hostPort: Number(deployForm.hostPort) || undefined,
        domain: deployForm.domain,
        autoDomain: deployForm.autoDomain,
      })
      setDeployResult(res)
    } catch (err) {
      setDeployError(err.message || 'Deployment failed')
    } finally {
      setDeploying(false)
    }
  }

  const totalTemplates = Object.values(categories).reduce((a, b) => a + b, 0)
  const SelectedIcon = selected ? CATEGORY_META[selected.category]?.icon || Store : Store

  return (
    <div className="p-6 sm:p-8 max-w-7xl mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-100">App Store &amp; Templates</h1>
          <p className="text-slate-400 text-sm mt-1">
            {totalTemplates} ready-to-run apps — pick one, give it a friendly name, and launch with zero code.
          </p>
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            placeholder="Search apps (e.g. WordPress, Postgres)..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 bg-[#111827] border border-slate-800 rounded-lg text-sm text-slate-200 placeholder:text-slate-500 focus:border-kathal-500 focus:outline-none"
          />
        </div>
      </div>

      {/* Category Tabs */}
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => { setFilterCat(''); setSearch('') }}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium border whitespace-nowrap shrink-0 transition-colors ${
            !filterCat
              ? 'bg-kathal-600 border-kathal-500 text-white'
              : 'bg-[#111827] border-slate-800 text-slate-400 hover:text-slate-200'
          }`}
        >
          All Apps ({totalTemplates})
        </button>
        {Object.entries(CATEGORY_META).map(([key, { icon: Icon, label }]) =>
          categories[key] ? (
            <button
              key={key}
              onClick={() => { setFilterCat(key); setSearch('') }}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border whitespace-nowrap shrink-0 transition-colors ${
                filterCat === key
                  ? 'bg-kathal-600 border-kathal-500 text-white'
                  : 'bg-[#111827] border-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span>{label} ({categories[key]})</span>
            </button>
          ) : null
        )}
      </div>

      {/* Template Grid */}
      {loading ? (
        <div className="bg-[#111827] border border-slate-800/90 rounded-xl p-12 text-center text-slate-400 text-sm">
          Loading app catalog...
        </div>
      ) : templates.length === 0 ? (
        <div className="bg-[#111827] border border-slate-800/90 rounded-xl p-12 text-center space-y-2">
          <Store className="w-10 h-10 text-slate-600 mx-auto" />
          <h2 className="text-lg font-semibold text-slate-200">No Matching Apps</h2>
          <p className="text-sm text-slate-400">Try clearing your search filter or picking another category.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {templates.map((t) => {
            const cat = CATEGORY_META[t.category]
            const Icon = cat?.icon || Store
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => openTemplate(t)}
                className="bg-[#111827] border border-slate-800/90 hover:border-kathal-500/60 rounded-xl p-5 cursor-pointer transition-colors flex flex-col justify-between text-left group"
              >
                <div>
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-10 h-10 rounded-lg bg-slate-800/90 border border-slate-700/80 flex items-center justify-center text-slate-300 group-hover:text-kathal-400 shrink-0 transition-colors">
                      <Icon className="w-5 h-5" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="font-semibold text-slate-100 truncate group-hover:text-kathal-300 transition-colors">
                        {t.name}
                      </h3>
                      <p className="text-xs text-slate-500">
                        {cat?.label || t.category}
                      </p>
                    </div>
                  </div>
                  <p className="text-sm text-slate-400 line-clamp-2 mb-3">{t.description}</p>
                </div>
                <div>
                  {t.tags?.length > 0 && (
                    <p className="text-[11px] text-slate-500 mb-3 truncate">
                      {t.tags.slice(0, 3).join(' · ')}
                    </p>
                  )}
                  <div className="flex items-center justify-between pt-2.5 border-t border-slate-800/80 text-xs">
                    <span className="text-slate-500 font-mono">v{t.version}</span>
                    <span className="inline-flex items-center gap-1 text-kathal-400 font-medium">
                      <span>Launch App</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </span>
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      )}

      {/* Deploy Modal */}
      {selected && (
        <div
          className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          onClick={() => setSelected(null)}
        >
          <div
            className="bg-[#111827] border border-slate-800 rounded-2xl p-6 max-w-lg w-full max-h-[90vh] overflow-y-auto shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 mb-5">
              <div className="flex items-center gap-3.5">
                <div className="w-11 h-11 rounded-xl bg-slate-800 border border-slate-700 flex items-center justify-center text-kathal-400 shrink-0">
                  <SelectedIcon className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-slate-100">{selected.name}</h2>
                  <p className="text-sm text-slate-400 mt-0.5">{selected.description}</p>
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

            <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-4 mb-5 text-xs space-y-1.5">
              <div><span className="text-slate-500">Package Image:</span> <code className="text-slate-200 font-mono">{selected.image}</code></div>
              {selected.ports?.length > 0 && (
                <div><span className="text-slate-500">Default Ports:</span> <span className="text-slate-200 tabular-nums">{selected.ports.join(', ')}</span></div>
              )}
              {selected.volumes?.length > 0 && (
                <div><span className="text-slate-500">Data Folders:</span> <span className="text-slate-200 font-mono">{selected.volumes.join(', ')}</span></div>
              )}
              {selected.env_vars?.length > 0 && (
                <div><span className="text-slate-500">Included Config:</span> <span className="text-slate-200 font-mono">{selected.env_vars.join(', ')}</span></div>
              )}
            </div>

            <form onSubmit={handleDeploy} className="space-y-4">
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
                  <label className="block text-xs text-slate-400 mb-1">Server Port</label>
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
                  placeholder="Leave blank to auto-assign a web address"
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-kathal-500 focus:outline-none"
                />
              </div>

              <label className="flex items-center gap-2.5 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={deployForm.autoDomain}
                  onChange={(e) => setDeployForm({ ...deployForm, autoDomain: e.target.checked })}
                  className="w-4 h-4 accent-kathal-500 rounded"
                />
                <span>Automatically set up web address &amp; HTTPS security</span>
              </label>

              {deployError && (
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-xs">
                  {deployError}
                </div>
              )}

              {deployResult && (
                <div className="p-4 rounded-xl bg-green-500/10 border border-green-500/30 text-xs space-y-2">
                  <p className="font-semibold text-green-400">
                    Launched {deployResult.container?.name} on port {deployResult.app?.port}
                  </p>
                  {deployResult.proxyRoute && (
                    <p className="text-slate-300">
                      Web Address: <code className="text-green-300 font-mono">{deployResult.proxyRoute.domain}</code> → {deployResult.proxyRoute.target}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Link to="/containers" className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200">
                      Open Running Apps →
                    </Link>
                    <Link to="/proxy" className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200">
                      Open Domains →
                    </Link>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                {selected.website && (
                  <a
                    href={selected.website}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm text-slate-300 mr-auto"
                  >
                    <span>Website</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm text-slate-300"
                >
                  Close
                </button>
                <button
                  type="submit"
                  disabled={deploying}
                  className="inline-flex items-center gap-2 px-5 py-2 bg-kathal-600 hover:bg-kathal-500 text-white rounded-lg text-sm font-medium disabled:opacity-50"
                >
                  <Rocket className="w-4 h-4" />
                  <span>{deploying ? 'Launching...' : 'Launch App'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
