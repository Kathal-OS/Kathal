import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { Activity, ArrowRight } from 'lucide-react'
import { apiFetch } from '../hooks/useApi'

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i]
}

function getUsageTone(percent) {
  if (percent >= 85) {
    return {
      text: 'text-red-400',
      bar: 'bg-red-500',
      stroke: '#f87171',
      status: 'High Load',
    }
  }
  if (percent >= 65) {
    return {
      text: 'text-amber-400',
      bar: 'bg-amber-400',
      stroke: '#fbbf24',
      status: 'Moderate',
    }
  }
  return {
    text: 'text-green-400',
    bar: 'bg-green-500',
    stroke: '#4ade80',
    status: 'Healthy',
  }
}

function MiniSparkline({ values, stroke }) {
  const valid = (values || []).map((v) => Number(v)).filter((v) => Number.isFinite(v))

  if (valid.length === 0) {
    return <div className="h-10 flex items-center text-xs text-slate-500">Collecting samples...</div>
  }

  const width = 220
  const height = 40
  const pad = 2
  const points = valid.length === 1 ? [valid[0], valid[0]] : valid

  const coords = points.map((val, idx) => {
    const clamped = Math.max(0, Math.min(100, val))
    const x = pad + (idx / (points.length - 1)) * (width - pad * 2)
    const y = height - pad - (clamped / 100) * (height - pad * 2)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full h-10 overflow-visible"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polyline
        fill="none"
        stroke={stroke}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={coords.join(' ')}
      />
    </svg>
  )
}

export default function HostMonitoringWidget() {
  const [current, setCurrent] = useState(null)
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const fetchMetrics = useCallback(async () => {
    try {
      setError(null)
      const [cur, hist] = await Promise.all([
        apiFetch('/monitoring/current'),
        apiFetch('/monitoring/history'),
      ])
      setCurrent(cur)
      setHistory(Array.isArray(hist) ? hist.slice(-30) : [])
    } catch (err) {
      setError(err.message || 'Failed to load host telemetry')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchMetrics()
    const timer = setInterval(fetchMetrics, 2000)
    return () => clearInterval(timer)
  }, [fetchMetrics])

  const cpuPct = Number.isFinite(Number(current?.cpu?.percent)) ? Number(current.cpu.percent) : 0
  const memPct = Number.isFinite(Number(current?.memory?.percent)) ? Number(current.memory.percent) : 0

  const cpuColors = getUsageTone(cpuPct)
  const memColors = getUsageTone(memPct)

  const cpuSeries = history.map((s) => s?.cpu?.percent)
  const memSeries = history.map((s) => s?.memory?.percent)

  const updatedLabel = current?.timestamp ? new Date(current.timestamp).toLocaleTimeString() : '—'

  return (
    <section className="bg-[#111827] border border-slate-800/90 rounded-xl p-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-kathal-400" />
            <h2 className="text-lg font-semibold text-slate-100">Live Server Performance</h2>
          </div>
          <p className="text-xs text-slate-400 mt-0.5 tabular-nums">
            Real-time CPU &amp; memory telemetry · Updated {updatedLabel}
          </p>
        </div>

        <Link
          to="/monitoring"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-xs font-medium text-slate-200 whitespace-nowrap transition-colors"
        >
          <span>Detailed Charts</span>
          <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-xs">
          {error}
        </div>
      )}

      {loading && !current ? (
        <div className="py-6 text-center text-sm text-slate-500">Connecting to telemetry stream...</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 divide-y md:divide-y-0 md:divide-x divide-slate-800/80">
          {/* Host CPU Usage */}
          <div className="space-y-3">
            <div className="flex items-baseline justify-between">
              <div>
                <p className="text-sm font-medium text-slate-200">CPU Utilization</p>
                <p className="text-xs text-slate-400 mt-0.5">
                  {current?.cpu?.cores || 0} cores ·{' '}
                  <span className={cpuColors.text}>{cpuColors.status}</span>
                </p>
              </div>
              <p className={`text-3xl font-bold tabular-nums ${cpuColors.text}`}>
                {cpuPct.toFixed(1)}%
              </p>
            </div>

            <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-300 ${cpuColors.bar}`}
                style={{ width: `${Math.max(0, Math.min(100, cpuPct))}%` }}
              />
            </div>

            <div className="pt-1">
              <MiniSparkline values={cpuSeries} stroke={cpuColors.stroke} />
            </div>
          </div>

          {/* Host Memory Usage */}
          <div className="space-y-3 pt-4 md:pt-0 md:pl-6">
            <div className="flex items-baseline justify-between">
              <div>
                <p className="text-sm font-medium text-slate-200">Memory Utilization</p>
                <p className="text-xs text-slate-400 mt-0.5 tabular-nums">
                  {formatBytes(current?.memory?.used)} / {formatBytes(current?.memory?.total)} ·{' '}
                  <span className={memColors.text}>{memColors.status}</span>
                </p>
              </div>
              <p className={`text-3xl font-bold tabular-nums ${memColors.text}`}>
                {memPct.toFixed(1)}%
              </p>
            </div>

            <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-300 ${memColors.bar}`}
                style={{ width: `${Math.max(0, Math.min(100, memPct))}%` }}
              />
            </div>

            <div className="pt-1">
              <MiniSparkline values={memSeries} stroke={memColors.stroke} />
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
