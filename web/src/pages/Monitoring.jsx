import { useState, useEffect, useCallback } from 'react'
import { CheckCircle2, AlertTriangle, Clock, KeyRound, History, Copy, Check } from 'lucide-react'
import { apiFetch, apiPost, apiDelete, hasPermission } from '../hooks/useApi'

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
    <div className="bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
      <div className="flex items-center justify-between text-xs text-slate-600 dark:text-slate-400 mb-2">
        <span>{label}</span>
        <span className="tabular-nums font-medium text-slate-900 dark:text-slate-200">
          Latest: {valid[valid.length - 1]?.toFixed(1)}
        </span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-16" preserveAspectRatio="none">
        <polyline fill="none" stroke={color} strokeWidth="2" points={points} />
      </svg>
    </div>
  )
}

export default function Monitoring({ currentUser }) {
  const canCreateServer = hasPermission(currentUser, 'servers.create')
  const canUpdateServer = hasPermission(currentUser, 'servers.update')
  const canDeleteServer = hasPermission(currentUser, 'servers.delete')
  const canReadAudit = hasPermission(currentUser, 'audit.read')

  const [current, setCurrent] = useState(null)
  const [history, setHistory] = useState([])
  const [fleet, setFleet] = useState({ servers: [], summary: { total: 0, online: 0, pending: 0, unreachable: 0 } })
  const [auditEvents, setAuditEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedContainer, setSelectedContainer] = useState(null)
  const [containerLogs, setContainerLogs] = useState('')
  const [logsLoading, setLogsLoading] = useState(false)

  const [showAddServer, setShowAddServer] = useState(false)
  const [serverForm, setServerForm] = useState({ name: '', host: '', port: '22', group: 'production', authMethod: 'ssh-key' })
  const [fleetFeedback, setFleetFeedback] = useState(null)
  const [probingId, setProbingId] = useState(null)

  const [historyModal, setHistoryModal] = useState(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [agentTokenModal, setAgentTokenModal] = useState(null)
  const [copiedToken, setCopiedToken] = useState(false)

  const loadData = useCallback(async () => {
    try {
      const [curr, hist, fleetRes, auditRes] = await Promise.all([
        apiFetch('/monitoring/current'),
        apiFetch('/monitoring/history'),
        apiFetch('/fleet/servers').catch(() => ({ servers: [], summary: { total: 0, online: 0, pending: 0, unreachable: 0 } })),
        canReadAudit ? apiFetch('/audit?limit=30').catch(() => []) : Promise.resolve([]),
      ])
      setCurrent(curr)
      setHistory(Array.isArray(hist) ? hist : [])
      if (fleetRes && Array.isArray(fleetRes.servers)) setFleet(fleetRes)
      if (Array.isArray(auditRes)) setAuditEvents(auditRes)
    } catch {
      // ignore transient error
    } finally {
      setLoading(false)
    }
  }, [canReadAudit])

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

  async function handleAddServer(e) {
    e.preventDefault()
    setFleetFeedback(null)
    try {
      const res = await apiPost('/fleet/servers', {
        name: serverForm.name,
        host: serverForm.host,
        port: Number(serverForm.port) || 22,
        group: serverForm.group,
        authMethod: serverForm.authMethod,
      })
      setShowAddServer(false)
      setServerForm({ name: '', host: '', port: '22', group: 'production', authMethod: 'ssh-key' })
      if (res?.agentToken) {
        setAgentTokenModal({
          serverName: res.name,
          agentId: res.agentId,
          agentToken: res.agentToken,
        })
      }
      setFleetFeedback({ type: 'success', text: 'Server node registered. Run a TCP reachability probe or connect its agent.' })
      loadData()
    } catch (err) {
      setFleetFeedback({ type: 'error', text: err.message || 'Failed to add server' })
    }
  }

  async function handleProbeServer(id) {
    setProbingId(id)
    setFleetFeedback(null)
    try {
      const res = await apiPost(`/fleet/servers/${id}/probe`, {})
      setFleetFeedback({
        type: res.reachable ? 'success' : 'error',
        text: res.reachable
          ? `Server reachable (${res.latencyMs} ms TCP handshake).`
          : `Probe unreachable: ${res.error || 'no response'}`,
      })
      loadData()
    } catch (err) {
      setFleetFeedback({ type: 'error', text: err.message || 'Probe failed' })
    } finally {
      setProbingId(null)
    }
  }

  async function handleRotateAgentToken(srv) {
    setFleetFeedback(null)
    try {
      const res = await apiPost(`/fleet/servers/${srv.id}/agent-token`, {})
      setAgentTokenModal({
        serverName: srv.name,
        agentId: res.agentId,
        agentToken: res.agentToken,
      })
      loadData()
    } catch (err) {
      setFleetFeedback({ type: 'error', text: err.message || 'Failed to issue agent token' })
    }
  }

  async function openServerHistory(srv) {
    setHistoryLoading(true)
    setHistoryModal({ server: srv, history: [] })
    try {
      const res = await apiFetch(`/fleet/servers/${srv.id}/history`)
      setHistoryModal({
        server: res?.server || srv,
        history: Array.isArray(res) ? res : Array.isArray(res?.history) ? res.history : [],
      })
    } catch (err) {
      setFleetFeedback({ type: 'error', text: err.message || 'Failed to load server history' })
      setHistoryModal(null)
    } finally {
      setHistoryLoading(false)
    }
  }

  async function handleDeleteServer(id) {
    setFleetFeedback(null)
    try {
      await apiDelete(`/fleet/servers/${id}`)
      setFleetFeedback({ type: 'success', text: 'Remote server removed from inventory.' })
      loadData()
    } catch (err) {
      setFleetFeedback({ type: 'error', text: err.message || 'Failed to remove server' })
    }
  }

  async function copyAgentToken() {
    if (!agentTokenModal?.agentToken) return
    try {
      await navigator.clipboard?.writeText(agentTokenModal.agentToken)
      setCopiedToken(true)
      setTimeout(() => setCopiedToken(false), 1500)
    } catch {
      // ignore clipboard restrictions
    }
  }

  const cpuPct = current?.cpu?.percent ?? 0
  const memPct = current?.memory?.percent ?? 0
  const diskPct = current?.disk?.percent ?? 0
  const cpuColor = cpuPct >= 85 ? '#ef4444' : cpuPct >= 65 ? '#ca8a04' : '#16a34a'
  const memColor = memPct >= 85 ? '#ef4444' : memPct >= 65 ? '#ca8a04' : '#16a34a'
  const diskColor = diskPct >= 85 ? '#ef4444' : diskPct >= 65 ? '#ca8a04' : '#16a34a'

  return (
    <div className="p-6 sm:p-8 max-w-7xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-slate-900 dark:text-slate-100">
          System Monitoring, Fleet &amp; Audit Trail
        </h1>
        <p className="text-slate-600 dark:text-slate-400 text-sm mt-1">
          Live host telemetry, registered server inventory, agent tokens, and operational audit events
        </p>
      </div>

      {loading && !current ? (
        <div className="text-center py-12 text-slate-500">Connecting to telemetry stream...</div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white dark:bg-[#101A10] border border-slate-200 dark:border-slate-800 rounded-xl p-5">
              <p className="text-xs text-slate-500 dark:text-slate-400">CPU</p>
              <p className="text-2xl font-bold tabular-nums mt-1" style={{ color: cpuColor }}>
                {formatPercent(current?.cpu?.percent)}
              </p>
              <p className="text-xs text-slate-500 mt-1">{current?.cpu?.cores || 0} cores</p>
            </div>
            <div className="bg-white dark:bg-[#101A10] border border-slate-200 dark:border-slate-800 rounded-xl p-5">
              <p className="text-xs text-slate-500 dark:text-slate-400">Memory</p>
              <p className="text-2xl font-bold tabular-nums mt-1" style={{ color: memColor }}>
                {formatPercent(current?.memory?.percent)}
              </p>
              <p className="text-xs text-slate-500 mt-1 tabular-nums">
                {formatBytes(current?.memory?.used)} / {formatBytes(current?.memory?.total)}
              </p>
            </div>
            <div className="bg-white dark:bg-[#101A10] border border-slate-200 dark:border-slate-800 rounded-xl p-5">
              <p className="text-xs text-slate-500 dark:text-slate-400">Disk</p>
              <p className="text-2xl font-bold tabular-nums mt-1" style={{ color: diskColor }}>
                {formatPercent(current?.disk?.percent)}
              </p>
              <p className="text-xs text-slate-500 mt-1 tabular-nums">
                {formatBytes(current?.disk?.used)} / {formatBytes(current?.disk?.total)}
              </p>
            </div>
            <div className="bg-white dark:bg-[#101A10] border border-slate-200 dark:border-slate-800 rounded-xl p-5">
              <p className="text-xs text-slate-500 dark:text-slate-400">Network</p>
              <p className="text-lg font-bold tabular-nums mt-1 text-yellow-600 dark:text-yellow-400">
                {formatBytes(current?.network?.bytesRecv || 0)} ↓ / {formatBytes(current?.network?.bytesSent || 0)} ↑
              </p>
              <p className="text-xs text-slate-500 mt-1">Cumulative I/O</p>
            </div>
          </div>

          {/* Container Stats */}
          <div className="bg-white dark:bg-[#101A10] border border-slate-200 dark:border-slate-800 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-4">
              Running Process &amp; App Resource Usage
            </h2>
            {!current?.containers?.length ? (
              <p className="text-slate-500 text-center py-8 text-sm">No apps or services running</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 text-xs text-slate-500">
                      <th className="text-left py-3 px-3 font-medium">Service</th>
                      <th className="text-left py-3 px-3 font-medium">CPU %</th>
                      <th className="text-left py-3 px-3 font-medium">Memory</th>
                      <th className="text-left py-3 px-3 font-medium">Network</th>
                      <th className="text-left py-3 px-3 font-medium">Block I/O</th>
                      <th className="text-left py-3 px-3 font-medium">PIDs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {current.containers.map((c) => (
                      <tr
                        key={c.id}
                        onClick={() => openContainerLogs(c)}
                        className="border-b border-slate-100 dark:border-slate-800/50 hover:bg-slate-50 dark:hover:bg-slate-800/40 cursor-pointer text-sm"
                      >
                        <td className="py-3 px-3 font-medium text-slate-900 dark:text-slate-200">{c.name}</td>
                        <td className="py-3 px-3 tabular-nums">{c.cpuPercent?.toFixed(1) || 'N/A'}%</td>
                        <td className="py-3 px-3 tabular-nums text-slate-600 dark:text-slate-400">
                          {c.memoryUsage ? formatBytes(c.memoryUsage) : 'N/A'}
                          {c.memoryLimit ? ` / ${formatBytes(c.memoryLimit)}` : ''}
                        </td>
                        <td className="py-3 px-3 tabular-nums text-slate-600 dark:text-slate-400">
                          ↓{formatBytes(c.netIO?.rxBytes)} ↑{formatBytes(c.netIO?.txBytes)}
                        </td>
                        <td className="py-3 px-3 tabular-nums text-slate-600 dark:text-slate-400">
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
            <div className="bg-white dark:bg-[#101A10] border border-slate-200 dark:border-slate-800 rounded-xl p-6">
              <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-4">
                History (last {history.length} samples)
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Sparkline data={history.map((h) => h.cpu?.percent || 0)} color={cpuColor} label="CPU %" />
                <Sparkline data={history.map((h) => h.memory?.percent || 0)} color={memColor} label="Memory %" />
                <Sparkline data={history.map((h) => (h.network?.bytesRecv || 0) / 1024)} color="#16a34a" label="Net Recv KB" />
                <Sparkline data={history.map((h) => (h.network?.bytesSent || 0) / 1024)} color="#ca8a04" label="Net Sent KB" />
              </div>
            </div>
          )}

          {/* Fleet Server Inventory */}
          <div className="bg-white dark:bg-[#101A10] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                  Kathal Fleet Nodes ({fleet.summary?.total || 0})
                </h2>
                <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5 tabular-nums">
                  Control plane host &amp; registered remote nodes ({fleet.summary?.online || 0} online · {fleet.summary?.pending || 0} pending · {fleet.summary?.unreachable || 0} unreachable)
                </p>
              </div>
              {canCreateServer && (
                <button
                  type="button"
                  onClick={() => setShowAddServer(!showAddServer)}
                  className="px-3.5 py-2 bg-kathal-600 hover:bg-kathal-500 text-white rounded-lg text-xs font-medium whitespace-nowrap"
                >
                  {showAddServer ? 'Close Form' : '+ Register Node'}
                </button>
              )}
            </div>

            {fleetFeedback && (
              <div
                className={`p-3 rounded-lg border text-xs ${
                  fleetFeedback.type === 'error'
                    ? 'bg-red-500/10 border-red-500/30 text-red-700 dark:text-red-400'
                    : 'bg-green-500/10 border-green-500/30 text-green-700 dark:text-green-400'
                }`}
              >
                {fleetFeedback.text}
              </div>
            )}

            {showAddServer && canCreateServer && (
              <form
                onSubmit={handleAddServer}
                className="grid grid-cols-1 md:grid-cols-5 gap-3 p-4 rounded-xl bg-slate-50 dark:bg-slate-950/70 border border-slate-200 dark:border-slate-800"
              >
                <input
                  value={serverForm.name}
                  onChange={(e) => setServerForm({ ...serverForm, name: e.target.value })}
                  placeholder="edge-eu-1"
                  required
                  className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-900 dark:text-slate-100"
                />
                <input
                  value={serverForm.host}
                  onChange={(e) => setServerForm({ ...serverForm, host: e.target.value })}
                  placeholder="203.0.113.10 or node.example.com"
                  required
                  className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-100"
                />
                <input
                  type="number"
                  value={serverForm.port}
                  onChange={(e) => setServerForm({ ...serverForm, port: e.target.value })}
                  placeholder="22"
                  className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 text-xs tabular-nums text-slate-900 dark:text-slate-100"
                />
                <select
                  value={serverForm.authMethod}
                  onChange={(e) => setServerForm({ ...serverForm, authMethod: e.target.value })}
                  className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-900 dark:text-slate-100"
                >
                  <option value="ssh-key">SSH Key</option>
                  <option value="agent-token">Agent Token</option>
                </select>
                <button
                  type="submit"
                  className="px-3 py-2 bg-kathal-600 hover:bg-kathal-500 text-white rounded-lg text-xs font-medium"
                >
                  Save Node
                </button>
              </form>
            )}

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-xs text-slate-500">
                    <th className="text-left py-2.5 px-3 font-medium">Node</th>
                    <th className="text-left py-2.5 px-3 font-medium">Endpoint</th>
                    <th className="text-left py-2.5 px-3 font-medium">Role / OS</th>
                    <th className="text-left py-2.5 px-3 font-medium">Status</th>
                    <th className="text-left py-2.5 px-3 font-medium">Telemetry / Latency</th>
                    <th className="text-right py-2.5 px-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {fleet.servers.map((srv) => (
                    <tr key={srv.id} className="border-b border-slate-100 dark:border-slate-800/50 text-xs">
                      <td className="py-2.5 px-3 font-medium text-slate-900 dark:text-slate-100">{srv.name}</td>
                      <td className="py-2.5 px-3 font-mono text-slate-700 dark:text-slate-300">
                        {srv.host}:{srv.port}
                      </td>
                      <td className="py-2.5 px-3 text-slate-600 dark:text-slate-400">
                        {srv.role} · {srv.os}
                      </td>
                      <td className="py-2.5 px-3">
                        <span
                          className={`inline-flex items-center gap-1.5 font-medium ${
                            srv.status === 'online'
                              ? 'text-green-700 dark:text-green-400'
                              : srv.status === 'unreachable'
                              ? 'text-red-600 dark:text-red-400'
                              : 'text-yellow-700 dark:text-yellow-400'
                          }`}
                        >
                          {srv.status === 'online' ? (
                            <CheckCircle2 className="w-3.5 h-3.5" />
                          ) : srv.status === 'unreachable' ? (
                            <AlertTriangle className="w-3.5 h-3.5" />
                          ) : (
                            <Clock className="w-3.5 h-3.5" />
                          )}
                          <span className="capitalize">{srv.status}</span>
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-slate-600 dark:text-slate-400 tabular-nums">
                        {srv.telemetry
                          ? `CPU ${srv.telemetry.cpuPercent}% · RAM ${srv.telemetry.memoryPercent}%`
                          : srv.latencyMs !== null && srv.latencyMs !== undefined
                          ? `${srv.latencyMs} ms`
                          : 'Awaiting agent heartbeat'}
                      </td>
                      <td className="py-2.5 px-3 text-right whitespace-nowrap space-x-1.5">
                        <button
                          type="button"
                          onClick={() => openServerHistory(srv)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          <History className="w-3 h-3" />
                          <span>History</span>
                        </button>
                        {canUpdateServer && !srv.isLocal && (
                          <button
                            type="button"
                            onClick={() => handleRotateAgentToken(srv)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                          >
                            <KeyRound className="w-3 h-3" />
                            <span>Agent Token</span>
                          </button>
                        )}
                        {canUpdateServer && (
                          <button
                            type="button"
                            onClick={() => handleProbeServer(srv.id)}
                            disabled={probingId === srv.id}
                            className="px-2.5 py-1 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded text-slate-800 dark:text-slate-200 disabled:opacity-50"
                          >
                            {probingId === srv.id ? 'Probing...' : 'Probe'}
                          </button>
                        )}
                        {canDeleteServer && !srv.isLocal && (
                          <button
                            type="button"
                            onClick={() => handleDeleteServer(srv.id)}
                            className="px-2.5 py-1 bg-red-500/15 hover:bg-red-600 text-red-700 dark:text-red-400 hover:text-white rounded"
                          >
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Persistent Audit Log (only if user has audit.read) */}
          {canReadAudit && (
            <div className="bg-white dark:bg-[#101A10] border border-slate-200 dark:border-slate-800 rounded-xl p-6">
              <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-3">
                Recent Audit Events
              </h2>
              {auditEvents.length === 0 ? (
                <p className="text-sm text-slate-500 py-6 text-center">No audit events recorded yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                        <th className="text-left py-2 px-3 font-medium">Time</th>
                        <th className="text-left py-2 px-3 font-medium">Actor</th>
                        <th className="text-left py-2 px-3 font-medium">Action</th>
                        <th className="text-left py-2 px-3 font-medium">Target</th>
                        <th className="text-left py-2 px-3 font-medium">Outcome</th>
                      </tr>
                    </thead>
                    <tbody>
                      {auditEvents.map((ev) => (
                        <tr key={ev.id} className="border-b border-slate-100 dark:border-slate-800/50">
                          <td className="py-2 px-3 text-slate-500 tabular-nums whitespace-nowrap">
                            {new Date(ev.timestamp).toLocaleString()}
                          </td>
                          <td className="py-2 px-3 text-slate-800 dark:text-slate-300 font-mono">{ev.actor}</td>
                          <td className="py-2 px-3 text-slate-900 dark:text-slate-200 font-mono">{ev.action}</td>
                          <td className="py-2 px-3 text-slate-600 dark:text-slate-400 truncate max-w-xs">{ev.target}</td>
                          <td className="py-2 px-3">
                            <span
                              className={`font-medium capitalize ${
                                ev.outcome === 'success'
                                  ? 'text-green-700 dark:text-green-400'
                                  : ev.outcome === 'denied'
                                  ? 'text-yellow-700 dark:text-yellow-400'
                                  : 'text-red-600 dark:text-red-400'
                              }`}
                            >
                              {ev.outcome}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
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
            className="bg-white dark:bg-[#101A10] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 max-w-3xl w-full max-h-[80vh] flex flex-col"
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">
                {selectedContainer.name} — Logs
              </h3>
              <button
                type="button"
                onClick={() => setSelectedContainer(null)}
                className="px-3 py-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg text-xs text-slate-700 dark:text-slate-300"
              >
                Close
              </button>
            </div>
            <pre className="flex-1 overflow-auto bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-4 text-xs font-mono text-slate-800 dark:text-slate-300 whitespace-pre-wrap">
              {logsLoading ? 'Loading logs...' : containerLogs}
            </pre>
          </div>
        </div>
      )}

      {/* Fleet Server History Modal */}
      {historyModal && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
          onClick={() => setHistoryModal(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white dark:bg-[#101A10] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 max-w-3xl w-full max-h-[80vh] flex flex-col space-y-4"
          >
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">
                  Node Status History — {historyModal.server?.name}
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 font-mono mt-0.5">
                  {historyModal.server?.host}:{historyModal.server?.port}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setHistoryModal(null)}
                className="px-3 py-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg text-xs text-slate-700 dark:text-slate-300"
              >
                Close
              </button>
            </div>

            <div className="overflow-auto flex-1">
              {historyLoading ? (
                <p className="text-center py-8 text-xs text-slate-500">Loading probe &amp; heartbeat history...</p>
              ) : historyModal.history.length === 0 ? (
                <p className="text-center py-8 text-xs text-slate-500">No status history recorded yet for this node.</p>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                      <th className="text-left py-2 px-3 font-medium">Recorded At</th>
                      <th className="text-left py-2 px-3 font-medium">Status</th>
                      <th className="text-left py-2 px-3 font-medium">Latency</th>
                      <th className="text-left py-2 px-3 font-medium">Telemetry / Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {historyModal.history.map((entry, idx) => (
                      <tr key={entry.id || idx} className="border-b border-slate-100 dark:border-slate-800/50">
                        <td className="py-2 px-3 tabular-nums text-slate-500 whitespace-nowrap">
                          {new Date(entry.checkedAt || entry.recordedAt).toLocaleString()}
                        </td>
                        <td className="py-2 px-3 capitalize font-medium text-slate-900 dark:text-slate-100">
                          {entry.status}
                        </td>
                        <td className="py-2 px-3 tabular-nums text-slate-600 dark:text-slate-400">
                          {entry.latencyMs !== null && entry.latencyMs !== undefined ? `${entry.latencyMs} ms` : '—'}
                        </td>
                        <td className="py-2 px-3 text-slate-600 dark:text-slate-400">
                          {entry.cpuPercent !== null && entry.cpuPercent !== undefined
                            ? `CPU ${entry.cpuPercent}% · RAM ${entry.memoryPercent ?? 0}%`
                            : entry.detail || entry.message || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Fleet Agent Token Modal */}
      {agentTokenModal && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
          onClick={() => setAgentTokenModal(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white dark:bg-[#101A10] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 max-w-xl w-full space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">
                Agent Enrollment Token — {agentTokenModal.serverName}
              </h3>
              <button
                type="button"
                onClick={() => setAgentTokenModal(null)}
                className="px-3 py-1.5 bg-slate-100 dark:bg-slate-800 rounded-lg text-xs text-slate-700 dark:text-slate-300"
              >
                Close
              </button>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              This credential is shown once. Configure your remote node agent with this token to send signed telemetry heartbeats to <code className="font-mono">/api/v1/fleet/agent/heartbeat</code>.
            </p>
            <div className="space-y-2 text-xs">
              <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                <span className="text-slate-500">Agent ID: </span>
                <code className="font-mono text-slate-900 dark:text-slate-100">{agentTokenModal.agentId}</code>
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 font-mono text-slate-900 dark:text-slate-100 truncate">
                  {agentTokenModal.agentToken}
                </code>
                <button
                  type="button"
                  onClick={copyAgentToken}
                  className="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-lg bg-kathal-600 hover:bg-kathal-500 text-white font-medium shrink-0"
                >
                  {copiedToken ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedToken ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}