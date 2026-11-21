import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { Box, RefreshCw, ArrowRight, ExternalLink } from 'lucide-react'
import { apiFetch } from '../hooks/useApi'

function normalizeState(container) {
  const raw = String(container?.state || container?.status || '').toLowerCase()
  if (raw === 'running' || raw.startsWith('up')) return 'running'
  return 'stopped'
}

const STATE_STYLES = {
  running: {
    bar: 'bg-green-500',
    text: 'text-green-400',
    label: 'Running',
  },
  stopped: {
    bar: 'bg-slate-500',
    text: 'text-slate-400',
    label: 'Stopped',
  },
}

export default function ContainerStatusWidget({ refreshKey = 0 }) {
  const [containers, setContainers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const fetchContainers = useCallback(async () => {
    try {
      setError(null)
      const data = await apiFetch('/containers?all=true')
      const list = Array.isArray(data) ? data : (data?.containers || [])
      setContainers(list)
    } catch (err) {
      setError(err.message || 'Failed to load local apps')
      setContainers([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchContainers()
    const timer = setInterval(fetchContainers, 10000)
    return () => clearInterval(timer)
  }, [fetchContainers, refreshKey])

  const counts = containers.reduce(
    (acc, c) => {
      const state = normalizeState(c)
      acc[state] += 1
      return acc
    },
    { running: 0, stopped: 0 }
  )

  const total = containers.length
  const pct = (count) => (total > 0 ? Math.round((count / total) * 100) : 0)

  return (
    <section className="bg-[#111827] border border-slate-800/90 rounded-xl p-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <div className="flex items-center gap-2">
            <Box className="w-4 h-4 text-kathal-400" />
            <h2 className="text-lg font-semibold text-slate-100">Running Local Apps</h2>
          </div>
          <p className="text-xs text-slate-400 mt-0.5 tabular-nums">
            Local Native Runtime (No Docker) · {total} installed · {counts.running} running · {counts.stopped} stopped
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={fetchContainers}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-xs text-slate-200 whitespace-nowrap transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
          <Link
            to="/containers"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-kathal-600/20 hover:bg-kathal-600/30 border border-kathal-600/30 rounded-lg text-xs font-medium text-kathal-400 whitespace-nowrap transition-colors"
          >
            <span>Manage All</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-xs">
          {error}
        </div>
      )}

      {/* Clean horizontal KPI strip */}
      <div className="grid grid-cols-2 gap-4 pb-4 border-b border-slate-800/80 mb-4">
        {(['running', 'stopped']).map((key) => {
          const style = STATE_STYLES[key]
          const count = counts[key]
          return (
            <div key={key}>
              <p className="text-xs text-slate-400 flex items-center justify-between">
                <span>{style.label}</span>
                <span className="tabular-nums text-slate-500">{pct(count)}%</span>
              </p>
              <p className={`text-2xl font-bold mt-1 tabular-nums ${style.text}`}>{count}</p>
            </div>
          )
        })}
      </div>

      {/* Distribution bar */}
      {total > 0 && (
        <div
          className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden flex mb-4"
          aria-label="App status distribution"
        >
          {counts.running > 0 && (
            <div
              className="bg-green-500 h-full transition-all duration-300"
              style={{ width: `${(counts.running / total) * 100}%` }}
            />
          )}
          {counts.stopped > 0 && (
            <div
              className="bg-slate-500 h-full transition-all duration-300"
              style={{ width: `${(counts.stopped / total) * 100}%` }}
            />
          )}
        </div>
      )}

      {/* Real local process rows */}
      {loading && total === 0 ? (
        <div className="text-sm text-slate-500 py-4 text-center">Loading local apps...</div>
      ) : total === 0 ? (
        <div className="text-sm text-slate-500 py-4 text-center">
          No local apps installed yet. Click &quot;Launch App&quot; above to install and run one directly on this host.
        </div>
      ) : (
        <div className="divide-y divide-slate-800/70">
          {containers.map((c) => {
            const stateKey = normalizeState(c)
            const style = STATE_STYLES[stateKey]
            return (
              <div
                key={c.id}
                className="flex items-center justify-between py-2.5 text-sm hover:bg-slate-800/30 px-2 -mx-2 rounded-lg transition-colors"
              >
                <div className="min-w-0">
                  <p className="font-medium text-slate-100 truncate">{c.name || c.id}</p>
                  <p className="text-xs text-slate-500 font-mono truncate">
                    {c.runtimeLabel || c.image}
                    {c.port ? ` · 127.0.0.1:${c.port}` : ''}
                    {c.pid ? ` · PID ${c.pid}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-3 shrink-0 ml-3 text-xs">
                  {c.status && (
                    <span className="hidden md:inline text-slate-400 tabular-nums">{c.status}</span>
                  )}
                  <span className={`font-medium capitalize ${style.text}`}>
                    {style.label}
                  </span>
                  {c.state === 'running' && c.liveUrl && (
                    <a
                      href={c.liveUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 px-2 py-1 rounded bg-green-600/20 hover:bg-green-600 text-green-300 hover:text-white border border-green-500/30 transition-colors"
                    >
                      <span>Open</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
