import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { Activity, Cpu, MemoryStick, HardDrive, ArrowRight, RefreshCw, Pause, Play } from 'lucide-react'
import { apiFetch } from '../hooks/useApi'

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}

function formatUptime(seconds) {
  if (!seconds || seconds < 0) return '0m'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function getUsageTone(percent) {
  if (percent >= 85) {
    return {
      text: 'text-red-400',
      bar: 'bg-red-500',
      stroke: '#ef4444',
      status: 'High Load',
    }
  }
  if (percent >= 65) {
    return {
      text: 'text-yellow-400',
      bar: 'bg-yellow-500',
      stroke: '#eab308',
      status: 'Moderate',
    }
  }
  return {
    text: 'text-green-400',
    bar: 'bg-green-500',
    stroke: '#22c55e',
    status: 'Healthy',
  }
}

function MiniSparkline({ values, stroke }) {
  const valid = (values || []).map((v) => Number(v)).filter((v) => Number.isFinite(v))

  if (valid.length === 0) {
    return <div className="h-9 flex items-center text-xs text-slate-500">Collecting samples...</div>
  }

  const width = 220
  const height = 36
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
      className="w-full h-9 overflow-visible"
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

export default function SystemMonitor() {
  const [snapshot, setSnapshot] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [live, setLive] = useState(true)
  const [error, setError] = useState(null)

  const fetchSnapshot = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true)
    try {
      setError(null)
      const data = await apiFetch('/system/monitor')
      setSnapshot(data)
    } catch (err) {
      setError(err.message || 'Unable to read host system metrics')
    } finally {
      setLoading(false)
      if (manual) setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    fetchSnapshot(false)
  }, [fetchSnapshot])

  useEffect(() => {
    if (!live) return undefined
    const timer = setInterval(() => {
      fetchSnapshot(false)
    }, 2000)
    return () => clearInterval(timer)
  }, [live, fetchSnapshot])

  const cpuPct = Number(snapshot?.cpu?.percent ?? 0)
  const memPct = Number(snapshot?.memory?.percent ?? 0)
  const diskPct = Number(snapshot?.disk?.percent ?? 0)

  const cpuTone = getUsageTone(cpuPct)
  const memTone = getUsageTone(memPct)
  const diskTone = getUsageTone(diskPct)

  const history = Array.isArray(snapshot?.history) ? snapshot.history : []
  const cpuSeries = history.map((p) => p.cpuPercent)
  const memSeries = history.map((p) => p.memoryPercent)
  const diskSeries = history.map((p) => p.diskPercent)

  const host = snapshot?.host
  const updatedLabel = snapshot?.timestamp ? new Date(snapshot.timestamp).toLocaleTimeString() : '—'

  return (
    <section
      aria-label="System Monitor"
      className="bg-[#101A10] border border-slate-800/90 rounded-xl p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-kathal-400" />
            <h2 className="text-lg font-semibold text-slate-100">System Monitor</h2>
          </div>
          <p className="text-xs text-slate-400 mt-0.5 tabular-nums">
            {host
              ? `${host.hostname} · ${host.platform} ${host.arch} · Uptime ${formatUptime(host.uptimeSeconds)} · Updated ${updatedLabel}`
              : 'Real-time CPU, memory, and disk utilization'}
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setLive((v) => !v)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-xs font-medium text-slate-200 whitespace-nowrap transition-colors"
          >
            {live ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            <span>{live ? 'Pause Live' : 'Resume Live'}</span>
          </button>

          <button
            type="button"
            onClick={() => fetchSnapshot(true)}
            disabled={refreshing}
            aria-label="Refresh system metrics"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-xs font-medium text-slate-200 whitespace-nowrap transition-colors disabled:opacity-60"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>

          <Link
            to="/monitoring"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-xs font-medium text-slate-200 whitespace-nowrap transition-colors"
          >
            <span>Detailed Charts</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-xs">
          {error}
        </div>
      )}

      {loading && !snapshot ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-32 rounded-lg bg-slate-900/50 animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 divide-y lg:divide-y-0 lg:divide-x divide-slate-800/80">
          {/* CPU Utilization */}
          <div className="space-y-3">
            <div className="flex items-baseline justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <Cpu className={`w-3.5 h-3.5 shrink-0 ${cpuTone.text}`} />
                  <p className="text-sm font-medium text-slate-200">CPU Usage</p>
                </div>
                <p className="text-xs text-slate-400 mt-0.5 tabular-nums truncate">
                  {snapshot?.cpu?.cores || 1} cores · Load {snapshot?.cpu?.loadAvg?.load1?.toFixed(2) || '0.00'} ·{' '}
                  <span className={cpuTone.text}>{cpuTone.status}</span>
                </p>
              </div>
              <p className={`text-2xl sm:text-3xl font-bold tabular-nums shrink-0 ${cpuTone.text}`}>
                {cpuPct.toFixed(1)}%
              </p>
            </div>

            <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-300 ${cpuTone.bar}`}
                style={{ width: `${Math.max(0, Math.min(100, cpuPct))}%` }}
              />
            </div>

            <div className="pt-1">
              <MiniSparkline values={cpuSeries} stroke={cpuTone.stroke} />
            </div>
          </div>

          {/* Memory Utilization */}
          <div className="space-y-3 pt-4 lg:pt-0 lg:pl-6">
            <div className="flex items-baseline justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <MemoryStick className={`w-3.5 h-3.5 shrink-0 ${memTone.text}`} />
                  <p className="text-sm font-medium text-slate-200">Memory Usage</p>
                </div>
                <p className="text-xs text-slate-400 mt-0.5 tabular-nums truncate">
                  {formatBytes(snapshot?.memory?.usedBytes)} / {formatBytes(snapshot?.memory?.totalBytes)} ·{' '}
                  <span className={memTone.text}>{memTone.status}</span>
                </p>
              </div>
              <p className={`text-2xl sm:text-3xl font-bold tabular-nums shrink-0 ${memTone.text}`}>
                {memPct.toFixed(1)}%
              </p>
            </div>

            <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-300 ${memTone.bar}`}
                style={{ width: `${Math.max(0, Math.min(100, memPct))}%` }}
              />
            </div>

            <div className="pt-1">
              <MiniSparkline values={memSeries} stroke={memTone.stroke} />
            </div>
          </div>

          {/* Disk Utilization */}
          <div className="space-y-3 pt-4 lg:pt-0 lg:pl-6">
            <div className="flex items-baseline justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <HardDrive className={`w-3.5 h-3.5 shrink-0 ${diskTone.text}`} />
                  <p className="text-sm font-medium text-slate-200">Disk Usage ({snapshot?.disk?.mount || '/'})</p>
                </div>
                <p className="text-xs text-slate-400 mt-0.5 tabular-nums truncate">
                  {formatBytes(snapshot?.disk?.usedBytes)} / {formatBytes(snapshot?.disk?.totalBytes)} · {formatBytes(snapshot?.disk?.freeBytes)} free ·{' '}
                  <span className={diskTone.text}>{diskTone.status}</span>
                </p>
              </div>
              <p className={`text-2xl sm:text-3xl font-bold tabular-nums shrink-0 ${diskTone.text}`}>
                {diskPct > 0 && diskPct < 0.1 ? diskPct.toFixed(2) : diskPct.toFixed(1)}%
              </p>
            </div>

            <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-300 ${diskTone.bar}`}
                style={{ width: `${Math.max(0, Math.min(100, diskPct))}%` }}
              />
            </div>

            <div className="pt-1">
              <MiniSparkline values={diskSeries} stroke={diskTone.stroke} />
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
