import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../hooks/useApi'

function formatBytes(bytes) {
  if (!bytes) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

function formatPercent(p) {
  return Number.isFinite(Number(p)) ? Number(p).toFixed(1) + '%' : 'N/A'
}

function Sparkline({ data, color, label }) {
  const valid = (data || []).map((v) => Number(v)).filter((v) => Number.isFinite(v))
  if (!valid.length) return null
  const max = Math.max(...valid)
  const min = Math.min(...valid)
  const span = max - min || 1
  const height = 60
  const width = 300
  const points = (valid.length === 1 ? [valid[0], valid[0]] : valid)
    .map((v, i, arr) => {
      const x = (i / (arr.length - 1)) * width
      const y = height - ((v - min) / span) * (height - 8) - 4
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  return (
    <div className="bg-gray-950/60 border border-gray-800 rounded-xl p-4">
      <div className="flex items-center justify-between text-xs text-gray-400 mb-2">
        <span>{label}</span>
        <span className="tabular-nums font-medium text-gray-200">Latest: {valid[valid.length - 1]?.toFixed(1)}</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-16" preserveAspectRatio="none">
        <polyline fill="none" stroke={color} strokeWidth="2" points={points} />
      </svg>
    </div>
  )
}

export default function Monitoring() {
  const [current, setCurrent] = useState(null)
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedContainer, setSelectedContainer] = useState(null)
  const [containerLogs, setContainerLogs] = useState('')
  const [logsLoading, setLogsLoading] = useState(false)

  const loadData = useCallback(async () => {
    try {
      const [curr, hist] = await Promise.all([
        apiFetch('/monitoring/current'),
        apiFetch('/monitoring/history'),
      ])
      setCurrent(curr)
      setHistory(Array.isArray(hist) ? hist : [])
    } catch {
      // ignore transient error
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
    const interval = setInterval(loadData, 2000)
    return () => clearInterval(interval)
  }, [loadData])

  async function openContainerLogs(container) {
    setSelectedContainer(container)
    setLogsLoading(true)
    setContainerLogs('')
    try {
      const res = await apiFetch(`/containers/${container.id}/logs`)
      setContainerLogs(res?.logs || 'No logs available')
    } catch (err) {
      setContainerLogs(`Failed to load logs: ${err.message}`)
    } finally {
      setLogsLoading(false)
    }
  }

  const cpuPct = current?.cpu?.percent ?? 0
  const memPct = current?.memory?.percent ?? 0
  const diskPct = current?.disk?.percent ?? 0
  const cpuColor = cpuPct >= 85 ? '#ef4444' : cpuPct >= 65 ? '#eab308' : '#22c55e'
  const memColor = memPct >= 85 ? '#ef4444' : memPct >= 65 ? '#eab308' : '#22c55e'
  const diskColor = diskPct >= 85 ? '#ef4444' : diskPct >= 65 ? '#eab308' : '#22c55e'

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold">System Monitoring</h1>
        <p className="text-gray-400 mt-1">Live host telemetry and per-container resource consumption</p>
      </div>

      {loading && !current ? (
        <div className="text-center py-12 text-gray-500">Connecting to telemetry stream...</div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <p className="text-xs text-gray-400">CPU</p>
              <p className="text-2xl font-bold tabular-nums mt-1" style={{ color: cpuColor }}>
                {formatPercent(current?.cpu?.percent)}
              </p>
              <p className="text-xs text-gray-500 mt-1">{current?.cpu?.cores || 0} cores</p>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <p className="text-xs text-gray-400">Memory</p>
              <p className="text-2xl font-bold tabular-nums mt-1" style={{ color: memColor }}>
                {formatPercent(current?.memory?.percent)}
              </p>
              <p className="text-xs text-gray-500 mt-1">
                {formatBytes(current?.memory?.used)} / {formatBytes(current?.memory?.total)}
              </p>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <p className="text-xs text-gray-400">Disk</p>
              <p className="text-2xl font-bold tabular-nums mt-1" style={{ color: diskColor }}>
                {formatPercent(current?.disk?.percent)}
              </p>
              <p className="text-xs text-gray-500 mt-1">
                {formatBytes(current?.disk?.used)} / {formatBytes(current?.disk?.total)}
              </p>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <p className="text-xs text-gray-400">Network</p>
              <p className="text-lg font-bold tabular-nums mt-1 text-yellow-400">
                {formatBytes(current?.network?.bytesRecv || 0)} ↓ / {formatBytes(current?.network?.bytesSent || 0)} ↑
              </p>
              <p className="text-xs text-gray-500 mt-1">Cumulative I/O</p>
            </div>
          </div>

          {/* Container Stats */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-6">
            <h2 className="text-lg font-semibold mb-4">Container Resource Usage</h2>
            {!current?.containers?.length ? (
              <p className="text-gray-500 text-center py-8 text-sm">No containers running</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase">
                      <th className="text-left py-3 px-3">Container</th>
                      <th className="text-left py-3 px-3">CPU %</th>
                      <th className="text-left py-3 px-3">Memory</th>
                      <th className="text-left py-3 px-3">Network</th>
                      <th className="text-left py-3 px-3">Block I/O</th>
                      <th className="text-left py-3 px-3">PIDs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {current.containers.map((c) => (
                      <tr
                        key={c.id}
                        onClick={() => openContainerLogs(c)}
                        className="border-b border-gray-800/50 hover:bg-gray-800/40 cursor-pointer text-sm"
                      >
                        <td className="py-3 px-3 font-medium text-gray-200">{c.name}</td>
                        <td className="py-3 px-3 tabular-nums">{c.cpuPercent?.toFixed(1) || 'N/A'}%</td>
                        <td className="py-3 px-3 tabular-nums text-gray-400">
                          {c.memoryUsage ? formatBytes(c.memoryUsage) : 'N/A'}
                          {c.memoryLimit ? ` / ${formatBytes(c.memoryLimit)}` : ''}
                        </td>
                        <td className="py-3 px-3 tabular-nums text-gray-400">
                          ↓{formatBytes(c.netIO?.rxBytes)} ↑{formatBytes(c.netIO?.txBytes)}
                        </td>
                        <td className="py-3 px-3 tabular-nums text-gray-400">
                          R:{formatBytes(c.blockIO?.readBytes)} W:{formatBytes(c.blockIO?.writeBytes)}
                        </td>
                        <td className="py-3 px-3 tabular-nums">{c.pids || 'N/A'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {history.length > 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
              <h2 className="text-lg font-semibold mb-4">History (last {history.length} samples)</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Sparkline data={history.map((h) => h.cpu?.percent || 0)} color={cpuColor} label="CPU %" />
                <Sparkline data={history.map((h) => h.memory?.percent || 0)} color={memColor} label="Memory %" />
                <Sparkline data={history.map((h) => (h.network?.bytesRecv || 0) / 1024)} color="#22c55e" label="Net Recv KB" />
                <Sparkline data={history.map((h) => (h.network?.bytesSent || 0) / 1024)} color="#eab308" label="Net Sent KB" />
              </div>
            </div>
          )}
        </>
      )}

      {/* Container Logs Modal */}
      {selectedContainer && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
          onClick={() => setSelectedContainer(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-gray-900 border border-gray-800 rounded-2xl p-6 max-w-3xl w-full max-h-[80vh] flex flex-col"
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold">{selectedContainer.name} — Logs</h3>
              <button
                onClick={() => setSelectedContainer(null)}
                className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded-lg text-xs text-gray-300"
              >
                Close
              </button>
            </div>
            <pre className="flex-1 overflow-auto bg-gray-950 border border-gray-800 rounded-xl p-4 text-xs font-mono text-gray-300 whitespace-pre-wrap">
              {logsLoading ? 'Loading logs...' : containerLogs}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}