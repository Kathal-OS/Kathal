import { useState } from 'react'
import { Link } from 'react-router-dom'
import { X, Globe, Database, Activity, BarChart3, Layers, CheckCircle2, ArrowRight, Sparkles } from 'lucide-react'
import { apiPost } from '../hooks/useApi'

const APP_CHOICES = [
  {
    id: 'website',
    title: 'Website or Landing Page',
    desc: 'Fast Nginx web server ready for static sites or proxies.',
    defaultName: 'my-website',
    image: 'nginx:alpine',
    port: 80,
    icon: Globe,
  },
  {
    id: 'postgres',
    title: 'PostgreSQL Database',
    desc: 'Reliable SQL database for apps, dashboards, and analytics.',
    defaultName: 'app-database',
    image: 'postgres:16-alpine',
    port: 5432,
    icon: Database,
  },
  {
    id: 'uptime-kuma',
    title: 'Uptime Status Monitor',
    desc: 'Track website uptime and get notified when anything goes down.',
    defaultName: 'status-monitor',
    image: 'louislam/uptime-kuma:latest',
    port: 3001,
    icon: Activity,
  },
  {
    id: 'grafana',
    title: 'Analytics & Charts (Grafana)',
    desc: 'Visual dashboards for server metrics and databases.',
    defaultName: 'analytics-board',
    image: 'grafana/grafana:latest',
    port: 3000,
    icon: BarChart3,
  },
  {
    id: 'redis',
    title: 'Redis Cache & Queue',
    desc: 'High-speed memory cache for sessions and background jobs.',
    defaultName: 'fast-cache',
    image: 'redis:7-alpine',
    port: 6379,
    icon: Layers,
  },
  {
    id: 'custom',
    title: 'Custom Container Image',
    desc: 'Enter any Docker Hub or private registry image name.',
    defaultName: 'custom-app',
    image: 'nginx:alpine',
    port: 80,
    icon: Sparkles,
  },
]

export default function QuickLaunchModal({ open, onClose, onDeployed }) {
  const [selectedChoice, setSelectedChoice] = useState(APP_CHOICES[0])
  const [appName, setAppName] = useState(APP_CHOICES[0].defaultName)
  const [customImage, setCustomImage] = useState(APP_CHOICES[0].image)
  const [port, setPort] = useState(String(APP_CHOICES[0].port))
  const [autoDomain, setAutoDomain] = useState(true)
  const [deploying, setDeploying] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)

  if (!open) return null

  function choosePreset(choice) {
    setSelectedChoice(choice)
    setAppName(choice.defaultName)
    setCustomImage(choice.image)
    setPort(String(choice.port))
    setError('')
    setResult(null)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setDeploying(true)
    setError('')
    try {
      const res = await apiPost('/deploy', {
        name: appName.trim(),
        image: selectedChoice.id === 'custom' ? customImage.trim() : selectedChoice.image,
        containerPort: Number(port) || selectedChoice.port,
        autoDomain,
        source: 'zero-code-launcher',
      })
      setResult(res)
      if (onDeployed) onDeployed(res)
    } catch (err) {
      setError(err.message || 'Could not launch app')
    } finally {
      setDeploying(false)
    }
  }

  function resetAndClose() {
    setResult(null)
    setError('')
    onClose()
  }

  return (
    <div
      className="fixed inset-0 bg-black/75 backdrop-blur-xs flex items-center justify-center z-50 p-4"
      onClick={resetAndClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-[#111827] border border-slate-800 rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto shadow-2xl"
      >
        <div className="px-6 py-5 border-b border-slate-800 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-slate-100">Launch an App</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Zero code required — pick an app, name it, and we configure ports and web routing automatically.
            </p>
          </div>
          <button
            type="button"
            onClick={resetAndClose}
            aria-label="Close launcher"
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {result ? (
          <div className="p-6 space-y-5">
            <div className="p-4 rounded-xl bg-green-500/10 border border-green-500/30 flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-green-400 shrink-0 mt-0.5" />
              <div>
                <h3 className="text-base font-semibold text-green-300">
                  {result.app?.name} is live and running
                </h3>
                <p className="text-xs text-slate-300 mt-1">
                  Running on host port <span className="font-mono text-white">{result.app?.port}</span>
                  {result.proxyRoute && (
                    <>
                      {' '}· Web domain{' '}
                      <span className="font-mono text-white">{result.proxyRoute.domain}</span>
                    </>
                  )}
                </p>
              </div>
            </div>

            <div className="bg-slate-950/70 border border-slate-800 rounded-xl p-4">
              <p className="text-xs font-medium text-slate-400 mb-2">What we configured for you</p>
              <ul className="space-y-1.5 text-xs text-slate-300 font-mono">
                {(result.logs || []).map((line, idx) => (
                  <li key={idx}>{line}</li>
                ))}
              </ul>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setResult(null)}
                className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm text-slate-200"
              >
                Launch Another
              </button>
              <Link
                to="/containers"
                onClick={resetAndClose}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-kathal-600 hover:bg-kathal-500 text-white text-sm font-medium"
              >
                <span>Open Running Apps</span>
                <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="p-6 space-y-5">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-2">
                1. Choose what you want to run
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {APP_CHOICES.map((choice) => {
                  const Icon = choice.icon
                  const active = selectedChoice.id === choice.id
                  return (
                    <button
                      key={choice.id}
                      type="button"
                      onClick={() => choosePreset(choice)}
                      className={`p-3.5 rounded-xl border text-left transition-colors flex items-start gap-3 ${
                        active
                          ? 'bg-kathal-600/15 border-kathal-500 text-slate-100'
                          : 'bg-slate-900/60 border-slate-800 text-slate-300 hover:border-slate-700'
                      }`}
                    >
                      <Icon
                        className={`w-5 h-5 shrink-0 mt-0.5 ${
                          active ? 'text-kathal-400' : 'text-slate-400'
                        }`}
                      />
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-100">{choice.title}</p>
                        <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">{choice.desc}</p>
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  2. Give your app a name
                </label>
                <input
                  type="text"
                  value={appName}
                  onChange={(e) => setAppName(e.target.value)}
                  placeholder="my-website"
                  required
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm text-slate-100 focus:border-kathal-500 focus:outline-none"
                />
              </div>

              {selectedChoice.id === 'custom' ? (
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Container Image Name
                  </label>
                  <input
                    type="text"
                    value={customImage}
                    onChange={(e) => setCustomImage(e.target.value)}
                    placeholder="nginx:alpine or ghcr.io/org/app:v1"
                    required
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm font-mono text-slate-100 focus:border-kathal-500 focus:outline-none"
                  />
                </div>
              ) : (
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    App Port (auto-assigned safely if busy)
                  </label>
                  <input
                    type="number"
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm tabular-nums text-slate-100 focus:border-kathal-500 focus:outline-none"
                  />
                </div>
              )}
            </div>

            <label className="flex items-center gap-2.5 text-xs text-slate-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={autoDomain}
                onChange={(e) => setAutoDomain(e.target.checked)}
                className="w-4 h-4 accent-kathal-500 rounded"
              />
              <span>
                Automatically create a friendly web domain (e.g.{' '}
                <span className="font-mono text-slate-200">{appName || 'my-app'}.apps.kathal.local</span>)
              </span>
            </label>

            {error && (
              <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-400">
                {error}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-800">
              <Link
                to="/templates"
                onClick={resetAndClose}
                className="text-xs text-slate-400 hover:text-kathal-400"
              >
                Looking for WordPress, Ghost, or more? Browse App Store →
              </Link>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={resetAndClose}
                  className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={deploying || !appName.trim()}
                  className="px-5 py-2 rounded-lg bg-kathal-600 hover:bg-kathal-500 text-white text-sm font-medium disabled:opacity-50"
                >
                  {deploying ? 'Launching...' : 'Launch App Now'}
                </button>
              </div>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
