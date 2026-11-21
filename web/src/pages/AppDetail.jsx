import { useState, useEffect, useCallback } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  ExternalLink,
  BookOpen,
  Code2,
  Star,
  Download,
  Play,
  Square,
  RotateCw,
  Trash2,
  Activity,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Terminal,
  Wrench,
  Layers,
  Globe,
  ShieldCheck,
} from 'lucide-react'
import { apiFetch, apiPost, apiPut, apiDelete } from '../hooks/useApi'

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

const PREVIEW_BY_CATEGORY = {
  databases: '/previews/database.jpg',
  media: '/previews/database.jpg',
  ai: '/previews/ai.jpg',
  automation: '/previews/ai.jpg',
  monitoring: '/previews/monitoring.jpg',
  webservers: '/previews/monitoring.jpg',
  networking: '/previews/monitoring.jpg',
  devtools: '/previews/devtools.jpg',
  business: '/previews/devtools.jpg',
  cms: '/previews/devtools.jpg',
}

export default function AppDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [app, setApp] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [imgFailed, setImgFailed] = useState(false)
  const [favorites, setFavorites] = useState(readFavorites)

  const [installForm, setInstallForm] = useState({
    name: '',
    hostPort: '',
    domain: '',
    autoDomain: true,
    overwrite: false,
  })
  const [envText, setEnvText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [actionMsg, setActionMsg] = useState('')
  const [actionErr, setActionErr] = useState('')
  const [keepDataOnUninstall, setKeepDataOnUninstall] = useState(true)
  const [healthLoading, setHealthLoading] = useState(false)

  const loadApp = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setError('')
    try {
      const data = await apiFetch(`/templates/${encodeURIComponent(id)}`)
      setApp(data)
      if (!silent) {
        setInstallForm((prev) => ({
          ...prev,
          name: prev.name || data.id,
          hostPort: prev.hostPort || String(data.defaultPort || 8080),
        }))
        if (data.installation?.env) {
          setEnvText(
            Object.entries(data.installation.env)
              .map(([k, v]) => `${k}=${v}`)
              .join('\n')
          )
        } else {
          setEnvText((data.env_vars || []).join('\n'))
        }
      }
    } catch (err) {
      setError(err.message || 'Application not found')
    } finally {
      if (!silent) setLoading(false)
    }
  }, [id])

  useEffect(() => {
    setImgFailed(false)
    loadApp(false)
  }, [loadApp])

  // Poll installation progress while installing
  useEffect(() => {
    if (!app?.installation || app.installation.installStatus !== 'installing') return
    const timer = setInterval(async () => {
      try {
        const inst = await apiFetch(`/installations/${app.installation.id}`)
        setApp((prev) => (prev ? { ...prev, installation: inst } : prev))
        if (inst.installStatus !== 'installing') {
          loadApp(true)
        }
      } catch {
        // ignore transient poll error
      }
    }, 1200)
    return () => clearInterval(timer)
  }, [app?.installation?.id, app?.installation?.installStatus, loadApp])

  function toggleFavorite() {
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

  async function handleInstall(e) {
    e.preventDefault()
    if (!app) return
    setSubmitting(true)
    setActionErr('')
    setActionMsg('')
    try {
      const envLines = envText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#') && l.includes('='))
      const res = await apiPost(`/templates/${app.id}/install`, {
        name: installForm.name || app.id,
        hostPort: Number(installForm.hostPort) || undefined,
        domain: installForm.domain.trim(),
        autoDomain: installForm.autoDomain,
        overwrite: installForm.overwrite,
        env: envLines,
      })
      setApp((prev) => (prev ? { ...prev, installation: res.installation } : prev))
      setActionMsg(`Installation started for ${app.name} on port ${res.installation.port}.`)
    } catch (err) {
      setActionErr(err.message || 'Installation failed')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleLifecycle(action) {
    if (!app?.installation) return
    setSubmitting(true)
    setActionErr('')
    setActionMsg('')
    try {
      const res = await apiPost(`/installations/${app.installation.id}/${action}`, {})
      setApp((prev) => (prev ? { ...prev, installation: res.installation } : prev))
      setActionMsg(`${app.name} ${res.status}.`)
    } catch (err) {
      setActionErr(err.message || `Failed to ${action}`)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleHealthCheck() {
    if (!app?.installation) return
    setHealthLoading(true)
    try {
      const health = await apiPost(`/installations/${app.installation.id}/health`, {})
      setApp((prev) =>
        prev && prev.installation
          ? { ...prev, installation: { ...prev.installation, lastHealth: health } }
          : prev
      )
    } catch (err) {
      setActionErr(err.message || 'Health probe failed')
    } finally {
      setHealthLoading(false)
    }
  }

  async function handleSaveEnv() {
    if (!app?.installation) return
    setSubmitting(true)
    setActionErr('')
    setActionMsg('')
    try {
      const envLines = envText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#') && l.includes('='))
      const res = await apiPut(`/installations/${app.installation.id}/env`, { env: envLines })
      setApp((prev) => (prev ? { ...prev, installation: res.installation } : prev))
      setActionMsg('Environment configuration saved to .env. Restart app to apply changes.')
    } catch (err) {
      setActionErr(err.message || 'Failed to update environment variables')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleUninstall() {
    if (!app?.installation) return
    setSubmitting(true)
    setActionErr('')
    setActionMsg('')
    try {
      const res = await apiDelete(
        `/installations/${app.installation.id}?keepData=${keepDataOnUninstall ? 'true' : 'false'}`
      )
      setActionMsg(
        res.keptDataDir
          ? `Uninstalled ${app.name}. Data preserved at ${res.keptDataDir}.`
          : `Uninstalled ${app.name} cleanly.`
      )
      await loadApp(true)
    } catch (err) {
      setActionErr(err.message || 'Uninstall failed')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="p-6 sm:p-8 max-w-7xl mx-auto">
        <div className="bg-[#111827] border border-slate-800 rounded-xl p-12 text-center text-slate-400 text-sm">
          Loading application details...
        </div>
      </div>
    )
  }

  if (error || !app) {
    return (
      <div className="p-6 sm:p-8 max-w-4xl mx-auto space-y-4">
        <button
          type="button"
          onClick={() => navigate('/templates')}
          className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-slate-100"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to App Store</span>
        </button>
        <div className="bg-[#111827] border border-red-500/30 rounded-xl p-8 text-center">
          <h1 className="text-xl font-semibold text-slate-100">Application Not Found</h1>
          <p className="text-sm text-slate-400 mt-2">{error || 'This application template does not exist.'}</p>
        </div>
      </div>
    )
  }

  const inst = app.installation
  const preflight = app.preflight
  const isFav = favorites.includes(app.id)
  const previewSrc = PREVIEW_BY_CATEGORY[app.category] || '/previews/devtools.jpg'

  return (
    <div className="p-6 sm:p-8 max-w-7xl mx-auto space-y-6">
      {/* Top Breadcrumb */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          to="/templates"
          className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-slate-100 transition-colors whitespace-nowrap"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>App Store</span>
          <span aria-hidden="true" className="text-slate-600">/</span>
          <span className="capitalize text-slate-300">{app.category}</span>
          <span aria-hidden="true" className="text-slate-600">/</span>
          <span className="text-slate-100 font-medium">{app.name}</span>
        </Link>

        <button
          type="button"
          onClick={toggleFavorite}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium whitespace-nowrap transition-colors ${
            isFav
              ? 'bg-amber-500/10 border-amber-500/40 text-amber-300'
              : 'bg-[#111827] border-slate-800 text-slate-300 hover:border-slate-700'
          }`}
        >
          <Star className={`w-3.5 h-3.5 ${isFav ? 'fill-amber-400 text-amber-400' : ''}`} />
          <span>{isFav ? 'Favorited' : 'Add to Favorites'}</span>
        </button>
      </div>

      {/* Hero Header */}
      <div className="bg-[#111827] border border-slate-800/90 rounded-2xl p-6 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6">
        <div className="flex items-start gap-4 min-w-0">
          <div
            className="w-16 h-16 rounded-2xl border border-slate-700/80 flex items-center justify-center text-3xl shrink-0"
            style={{ backgroundColor: `${app.accentColor}18` }}
          >
            <span aria-hidden="true">{app.icon}</span>
          </div>
          <div className="min-w-0 space-y-1.5">
            <h1 className="text-2xl sm:text-3xl font-bold text-slate-100">{app.name}</h1>
            <p className="text-sm text-slate-300 max-w-2xl">{app.description}</p>
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 pt-1">
              <span>{app.runtime}</span>
              <span aria-hidden="true">·</span>
              <span className="text-slate-200 font-medium">{app.compatibility}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">v{app.version}</span>
              <span aria-hidden="true">·</span>
              <span className="capitalize">{app.difficulty} setup</span>
              <span aria-hidden="true">·</span>
              <span className={app.dockerFreeSupported ? 'text-emerald-400' : 'text-amber-400'}>
                {app.dockerFreeSupported ? 'Docker-Free Supported' : 'Requires Docker'}
              </span>
            </div>
          </div>
        </div>

        {/* Official Links & Primary Controls */}
        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <a
            href={app.website}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-900 border border-slate-800 hover:border-slate-700 text-xs font-medium text-slate-200 whitespace-nowrap"
          >
            <Globe className="w-3.5 h-3.5 text-slate-400" />
            <span>Official Site</span>
            <ExternalLink className="w-3 h-3 text-slate-500" />
          </a>
          <a
            href={app.github}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-900 border border-slate-800 hover:border-slate-700 text-xs font-medium text-slate-200 whitespace-nowrap"
          >
            <Code2 className="w-3.5 h-3.5 text-slate-400" />
            <span>Repository</span>
            <ExternalLink className="w-3 h-3 text-slate-500" />
          </a>
          <a
            href={app.docs}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-900 border border-slate-800 hover:border-slate-700 text-xs font-medium text-slate-200 whitespace-nowrap"
          >
            <BookOpen className="w-3.5 h-3.5 text-slate-400" />
            <span>Documentation</span>
            <ExternalLink className="w-3 h-3 text-slate-500" />
          </a>
          {inst?.state === 'running' && (
            <a
              href={inst.liveUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white whitespace-nowrap"
            >
              <span>Launch App</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}
        </div>
      </div>

      {/* Main Split Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        {/* Left Content Column */}
        <div className="lg:col-span-2 space-y-6">
          {/* Active Installation Telemetry / Logs */}
          {inst && (
            <div className="bg-[#111827] border border-slate-800/90 rounded-2xl p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-slate-100">
                    Installation &amp; Runtime Status
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5 tabular-nums">
                    Port {inst.port} · {inst.pid ? `PID ${inst.pid}` : 'Stopped'} · {inst.appDir}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {inst.state === 'running' ? (
                    <>
                      <button
                        type="button"
                        onClick={handleHealthCheck}
                        disabled={healthLoading}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 whitespace-nowrap"
                      >
                        <Activity className="w-3.5 h-3.5" />
                        <span>{healthLoading ? 'Checking...' : 'Health Check'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleLifecycle('restart')}
                        disabled={submitting}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 whitespace-nowrap"
                      >
                        <RotateCw className="w-3.5 h-3.5" />
                        <span>Restart</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleLifecycle('stop')}
                        disabled={submitting}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-600/20 hover:bg-amber-600/30 border border-amber-500/30 text-xs font-medium text-amber-300 whitespace-nowrap"
                      >
                        <Square className="w-3.5 h-3.5" />
                        <span>Stop</span>
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleLifecycle('start')}
                      disabled={submitting || inst.installStatus === 'installing'}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-medium text-white whitespace-nowrap disabled:opacity-50"
                    >
                      <Play className="w-3.5 h-3.5" />
                      <span>Start</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Progress Bar */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-300 capitalize">
                    Phase: {inst.phase.replace('_', ' ')} ({inst.installStatus})
                  </span>
                  <span className="font-mono tabular-nums text-slate-300">{inst.progress}%</span>
                </div>
                <div className="h-2 w-full rounded-full bg-slate-900 overflow-hidden border border-slate-800">
                  <div
                    className={`h-full transition-all duration-300 ${
                      inst.installStatus === 'failed'
                        ? 'bg-red-500'
                        : inst.installStatus === 'installed'
                        ? 'bg-emerald-500'
                        : 'bg-kathal-500'
                    }`}
                    style={{ width: `${inst.progress}%` }}
                  />
                </div>
              </div>

              {inst.errorMessage && (
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-300">
                  {inst.errorMessage}
                </div>
              )}

              {inst.lastHealth && (
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs px-3 py-2 rounded-lg bg-slate-900/80 border border-slate-800">
                  <span className={inst.lastHealth.ok ? 'text-emerald-400 font-medium' : 'text-amber-400 font-medium'}>
                    Health Check: {inst.lastHealth.ok ? `Healthy (HTTP ${inst.lastHealth.statusCode})` : inst.lastHealth.error || 'Unreachable'}
                  </span>
                  <span className="text-slate-500 font-mono tabular-nums">
                    {inst.lastHealth.latencyMs}ms · {new Date(inst.lastHealth.checkedAt).toLocaleTimeString()}
                  </span>
                </div>
              )}

              {/* Logs */}
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 text-xs font-medium text-slate-300">
                  <Terminal className="w-3.5 h-3.5 text-slate-400" />
                  <span>Installation &amp; Runtime Logs</span>
                </div>
                <pre className="bg-[#070B12] border border-slate-800 rounded-xl p-3.5 text-xs font-mono text-slate-300 max-h-64 overflow-y-auto whitespace-pre-wrap">
                  {(inst.logs || []).length > 0
                    ? inst.logs.map((l) => `${l.timestamp.slice(11, 19)} [${l.stream}] ${l.content}`).join('\n')
                    : 'Waiting for output...'}
                </pre>
              </div>
            </div>
          )}

          {/* Overview & Features */}
          <div className="bg-[#111827] border border-slate-800/90 rounded-2xl p-6 space-y-5">
            <div>
              <h2 className="text-lg font-semibold text-slate-100">Overview</h2>
              <p className="text-sm text-slate-300 leading-relaxed mt-2">{app.overview}</p>
            </div>

            <div className="pt-4 border-t border-slate-800/80">
              <h3 className="text-sm font-semibold text-slate-200 mb-3">Key Capabilities</h3>
              <ul className="space-y-2">
                {(app.features || []).map((feat, idx) => (
                  <li key={idx} className="flex items-start gap-2.5 text-sm text-slate-300">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                    <span>{feat}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Screenshots / Workspace Preview */}
          <div className="bg-[#111827] border border-slate-800/90 rounded-2xl p-6 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-lg font-semibold text-slate-100">Interface &amp; Architecture Preview</h2>
              <span className="text-xs text-slate-400 capitalize">{app.category} workspace</span>
            </div>
            <div className="rounded-xl overflow-hidden border border-slate-800 bg-slate-950 aspect-video relative">
              {!imgFailed ? (
                <img
                  src={previewSrc}
                  alt={`${app.name} self-hosted interface preview`}
                  referrerPolicy="no-referrer"
                  onError={() => setImgFailed(true)}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center p-6 text-center bg-gradient-to-br from-slate-900 to-slate-950">
                  <span className="text-4xl mb-2" aria-hidden="true">{app.icon}</span>
                  <p className="text-sm font-semibold text-slate-200">{app.name} Self-Hosted Console</p>
                  <p className="text-xs text-slate-400 mt-1">{app.runtime} · Port {app.defaultPort}</p>
                </div>
              )}
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent p-4 flex items-end justify-between gap-4">
                <div>
                  <p className="text-xs font-medium text-white">{app.name} Self-Hosted Workspace</p>
                  <p className="text-[11px] text-slate-300">
                    Runs isolated on 127.0.0.1:{inst?.port || app.defaultPort} · Reverse proxy ready
                  </p>
                </div>
                <a
                  href={app.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-kathal-300 hover:text-kathal-200 whitespace-nowrap"
                >
                  Official Gallery →
                </a>
              </div>
            </div>
          </div>

          {/* Configuration Instructions & Template */}
          <div className="bg-[#111827] border border-slate-800/90 rounded-2xl p-6 space-y-4">
            <div className="flex items-center gap-2">
              <Wrench className="w-4 h-4 text-slate-400" />
              <h2 className="text-lg font-semibold text-slate-100">Configuration Instructions</h2>
            </div>

            <ol className="space-y-2 list-decimal list-inside text-sm text-slate-300">
              {(app.configInstructions || []).map((step, i) => (
                <li key={i} className="leading-relaxed">{step}</li>
              ))}
            </ol>

            {app.configTemplate && (
              <div className="pt-2 space-y-1.5">
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span>Generated Template ({app.configTemplate.filename})</span>
                  <span className="font-mono uppercase">{app.configTemplate.format}</span>
                </div>
                <pre className="bg-[#070B12] border border-slate-800 rounded-xl p-3.5 text-xs font-mono text-slate-300 overflow-x-auto">
                  {app.configTemplate.content}
                </pre>
              </div>
            )}
          </div>

          {/* Troubleshooting */}
          <div className="bg-[#111827] border border-slate-800/90 rounded-2xl p-6 space-y-4">
            <h2 className="text-lg font-semibold text-slate-100">Troubleshooting</h2>
            <div className="divide-y divide-slate-800/80">
              {(app.troubleshooting || []).map((item, idx) => (
                <div key={idx} className="py-3 first:pt-0 last:pb-0">
                  <p className="text-sm font-medium text-slate-200">{item.issue}</p>
                  <p className="text-xs text-slate-400 mt-1 leading-relaxed">{item.fix}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right Sidebar: Requirements, Specs & One-Click Installer */}
        <div className="space-y-6">
          {/* System Specifications */}
          <div className="bg-[#111827] border border-slate-800/90 rounded-2xl p-5 space-y-4">
            <h2 className="text-base font-semibold text-slate-100">System Specifications</h2>
            <dl className="space-y-2.5 text-xs">
              <div className="flex justify-between gap-3">
                <dt className="text-slate-400">Compatibility</dt>
                <dd className="text-slate-100 font-medium text-right">{app.compatibility}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-400">Runtime</dt>
                <dd className="text-slate-200 text-right">{app.runtime}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-400">Install Method</dt>
                <dd className="font-mono text-slate-200 text-right">{app.installMethod}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-400">Default Port</dt>
                <dd className="font-mono tabular-nums text-slate-200 text-right">{app.defaultPort}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-400">Difficulty</dt>
                <dd className="capitalize text-slate-200 text-right">{app.difficulty}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-400">Docker-Free</dt>
                <dd className={app.dockerFreeSupported ? 'text-emerald-400 font-medium' : 'text-amber-400 font-medium'}>
                  {app.dockerFreeSupported ? 'Yes' : 'No (Requires Docker)'}
                </dd>
              </div>
            </dl>

            <div className="pt-3 border-t border-slate-800/80 space-y-2">
              <div className="flex items-center gap-1.5 text-xs font-medium text-slate-300">
                <Layers className="w-3.5 h-3.5 text-slate-400" />
                <span>Dependencies</span>
              </div>
              <p className="text-xs text-slate-400">{(app.dependencies || []).join(' · ')}</p>
            </div>
          </div>

          {/* Host Preflight Readiness */}
          <div className="bg-[#111827] border border-slate-800/90 rounded-2xl p-5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-slate-100">System Requirements</h2>
              {preflight?.installable ? (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-400">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  <span>Ready</span>
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-400">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  <span>Missing Deps</span>
                </span>
              )}
            </div>

            <ul className="space-y-2">
              {(preflight?.checks || []).map((chk, idx) => (
                <li key={idx} className="text-xs flex items-start gap-2">
                  {chk.ok ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                  ) : (
                    <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
                  )}
                  <div>
                    <p className="text-slate-200 font-medium">{chk.label}</p>
                    <p className="text-slate-400">{chk.detail}</p>
                  </div>
                </li>
              ))}
            </ul>

            {(preflight?.remediation || []).length > 0 && (
              <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/25 text-xs text-amber-200 space-y-1">
                {preflight.remediation.map((tip, idx) => (
                  <p key={idx}>{tip}</p>
                ))}
              </div>
            )}
          </div>

          {/* Install / Manage Panel */}
          <div className="bg-[#111827] border border-slate-800/90 rounded-2xl p-5 space-y-4">
            <h2 className="text-base font-semibold text-slate-100">
              {inst ? 'Manage Installation' : 'One-Click Installation'}
            </h2>

            {actionErr && (
              <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-300">
                {actionErr}
              </div>
            )}
            {actionMsg && (
              <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-300">
                {actionMsg}
              </div>
            )}

            <form onSubmit={handleInstall} className="space-y-3">
              {!inst && (
                <>
                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">Instance Name</label>
                      <input
                        type="text"
                        value={installForm.name}
                        onChange={(e) => setInstallForm({ ...installForm, name: e.target.value })}
                        required
                        className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 focus:border-kathal-500 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">Port</label>
                      <input
                        type="number"
                        value={installForm.hostPort}
                        onChange={(e) => setInstallForm({ ...installForm, hostPort: e.target.value })}
                        className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 tabular-nums focus:border-kathal-500 focus:outline-none"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Custom Domain (optional)</label>
                    <input
                      type="text"
                      value={installForm.domain}
                      onChange={(e) => setInstallForm({ ...installForm, domain: e.target.value })}
                      placeholder={`${app.id}.local`}
                      className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-kathal-500 focus:outline-none"
                    />
                  </div>
                  <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={installForm.autoDomain}
                      onChange={(e) => setInstallForm({ ...installForm, autoDomain: e.target.checked })}
                      className="w-3.5 h-3.5 accent-kathal-500 rounded"
                    />
                    <span>Auto-assign local reverse proxy route</span>
                  </label>
                  {preflight?.alreadyExists && (
                    <label className="flex items-start gap-2 text-xs text-amber-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={installForm.overwrite}
                        onChange={(e) => setInstallForm({ ...installForm, overwrite: e.target.checked })}
                        className="w-3.5 h-3.5 accent-amber-500 rounded mt-0.5"
                      />
                      <span>Folder already exists. Confirm reinstall (preserves user data/)</span>
                    </label>
                  )}
                </>
              )}

              <div>
                <label className="block text-xs text-slate-400 mb-1">Environment Variables (.env)</label>
                <textarea
                  rows={4}
                  value={envText}
                  onChange={(e) => setEnvText(e.target.value)}
                  placeholder="KEY=VALUE"
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-2 text-xs font-mono text-slate-200 focus:border-kathal-500 focus:outline-none"
                />
              </div>

              {!inst ? (
                <button
                  type="submit"
                  disabled={submitting || !preflight?.installable}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-kathal-600 hover:bg-kathal-500 text-white text-sm font-medium disabled:opacity-45 disabled:cursor-not-allowed transition-colors"
                >
                  <Download className="w-4 h-4" />
                  <span>
                    {submitting
                      ? 'Starting Installer...'
                      : preflight?.installable
                      ? `Install ${app.name}`
                      : 'Missing Required Runtime'}
                  </span>
                </button>
              ) : (
                <div className="space-y-2.5 pt-1">
                  <button
                    type="button"
                    onClick={handleSaveEnv}
                    disabled={submitting}
                    className="w-full px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200"
                  >
                    Save Environment (.env)
                  </button>
                  <div className="pt-2 border-t border-slate-800 space-y-2">
                    <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={keepDataOnUninstall}
                        onChange={(e) => setKeepDataOnUninstall(e.target.checked)}
                        className="w-3.5 h-3.5 accent-kathal-500 rounded"
                      />
                      <span>Preserve user data folder during uninstall</span>
                    </label>
                    <button
                      type="button"
                      onClick={handleUninstall}
                      disabled={submitting}
                      className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-red-600/15 hover:bg-red-600/25 border border-red-500/30 text-xs font-medium text-red-300"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Uninstall {app.name}</span>
                    </button>
                  </div>
                </div>
              )}
            </form>
          </div>
        </div>
      </div>
    </div>
  )
}
