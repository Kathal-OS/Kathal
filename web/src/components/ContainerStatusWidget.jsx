import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { Box, RefreshCw, ArrowRight } from 'lucide-react'
import { apiFetch } from '../hooks/useApi'

function normalizeState(container) {
  const raw = String(container?.state || container?.status || '').toLowerCase()
  if (raw === 'running' || raw.startsWith('up')) {
    return raw.includes('paused') ? 'paused' : 'running'
  }
  if (raw === 'paused') return 'paused'
  return 'stopped'
}

const STATE_STYLES = {
  running: {
    bar: 'bg-green-500',
    text: 'text-green-400',
    label: 'Running',
  },
  paused: {
    bar: 'bg-amber-400',
    text: 'text-amber-400',
    label: 'Paused',
  },
  stopped: {
    bar: 'bg-slate-500',
    text: 'text-slate-400',
    label: 'Stopped',
  },
}

export default function ContainerStatusWidget({ dockerAvailable, refreshKey = 0 }) {
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
      setError(err.message || 'Failed to load apps')
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
    { running: 0, paused: 0, stopped: 0 }
  )

  const total = containers.length
  const pct = (count) => (total > 0 ? Math.round((count / total) * 100) : 0)

  return (
    <section className="bg-[#111827] border border-slate-800/90 rounded-xl p-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <div className="flex items-center gap-2">
            <Box className="w-4 h-4 text-kathal-400" />
            <h2 className="text-lg font-semibold text-slate-100">Running Apps Overview</h2>
          </div>
          <p className="text-xs text-slate-400 mt-0.5 tabular-nums">
            {dockerAvailable === false
              ? 'Container engine unavailable — system-only mode'
              : `${total} total app${total === 1 ? '' : 's'} · ${counts.running} running · ${counts.paused} paused · ${counts.stopped} stopped`}
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

      {/* Clean horizontal KPI strip without nested cards */}
      <div className="grid grid-cols-3 gap-4 pb-4 border-b border-slate-800/80 mb-4">
        {(['running', 'paused', 'stopped']).map((key) => {
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
          {counts.paused > 0 && (
            <div
              className="bg-amber-400 h-full transition-all duration-300"
              style={{ width: `${(counts.paused / total) * 100}%` }}
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

      {/* Compact container rows */}
      {loading && total === 0 ? (
        <div className="text-sm text-slate-500 py-4 text-center">Loading apps...</div>
      ) : total === 0 ? (
        <div className="text-sm text-slate-500 py-4 text-center">No apps deployed yet.</div>
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
                  <p className="text-xs text-slate-500 font-mono truncate">{c.image}</p>
                </div>
                <div className="flex items-center gap-3 shrink-0 ml-3 text-xs">
                  {c.status && (
                    <span className="hidden md:inline text-slate-400 tabular-nums">{c.status}</span>
                  )}
                  <span className={`font-medium capitalize ${style.text}`}>
                    {c.state || style.label}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
