import { useState, useEffect, useCallback } from 'react'
import {
  Cpu,
  MemoryStick,
  Clock,
  Activity,
  Terminal,
  Play,
  Square,
  RotateCw,
  FileText,
  Trash2,
  Plus,
  RefreshCw,
  ExternalLink,
} from 'lucide-react'
import { apiFetch, apiPost, apiDelete } from '../hooks/useApi'

export default function NativeProcesses() {
  const [processes, setProcesses] = useState([])
  const [summary, setSummary] = useState(null)
  const [host, setHost] = useState(null)
  const [loading, setLoading] = useState(true)

  const [runningOnly, setRunningOnly] = useState(true)
  const [sourceFilter, setSourceFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [feedback, setFeedback] = useState(null)

  const [showModal, setShowModal] = useState(false)
  const [form, setForm] = useState({
    name: '',
    executable: 'node',
    args: '-e "const h=require(\'http\');h.createServer((q,s)=>s.end(\'OK\')).listen(process.env.PORT,\'127.0.0.1\')"',
    workingDir: '',
    port: '',
    domain: '',
  })
  const [spawning, setSpawning] = useState(false)

  const [logsTarget, setLogsTarget] = useState(null)
  const [logsText, setLogsText] = useState('')
  const [logsLoading, setLogsLoading] = useState(false)

  const loadProcesses = useCallback(async () => {
    try {
      const qs = new URLSearchParams({
        running: runningOnly ? 'true' : 'false',
        source: sourceFilter,
      })
      const data = await apiFetch(`/native-processes?${qs.toString()}`)
      setProcesses(Array.isArray(data?.processes) ? data.processes : [])
      setSummary(data?.summary || null)
      setHost(data?.host || null)
    } catch {
      setProcesses([])
    } finally {
      setLoading(false)
    }
  }, [runningOnly, sourceFilter])

  useEffect(() => {
    loadProcesses()
  }, [loadProcesses])

  useEffect(() => {
    if (!autoRefresh) return undefined
    const timer = setInterval(loadProcesses, 2000)
    return () => clearInterval(timer)
  }, [autoRefresh, loadProcesses])

  async function handleAction(proc, actionName) {
    setBusyId(proc.id)
    setFeedback(null)
    try {
      if (actionName === 'delete') {
        await apiDelete(`/containers/${proc.id}/delete`)
        setConfirmDeleteId(null)
        setFeedback({ type: 'success', text: `Removed native process "${proc.name}".` })
      } else {
        await apiPost(`/containers/${proc.id}/${actionName}`, {})
      }
      await loadProcesses()
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || `Failed to ${actionName} process` })
    } finally {
      setBusyId(null)
    }
  }

  async function handleSpawn(e) {
    e.preventDefault()
    setSpawning(true)
    setFeedback(null)
    try {
      const payload = {
        name: form.name.trim(),
        executable: form.executable.trim(),
        args: form.args,
        workingDir: form.workingDir.trim() || undefined,
        port: form.port ? Number(form.port) : undefined,
        domain: form.domain.trim() || undefined,
      }
      const res = await apiPost('/processes', payload)
      setShowModal(false)
      setForm({
        name: '',
        executable: 'python3',
        args: '-m http.server {PORT} --bind 127.0.0.1',
        workingDir: '',
        port: '',
        domain: '',
      })
      setFeedback({
        type: 'success',
        text: `Spawned "${res.process?.name}" (PID ${res.process?.pid}) on port ${res.process?.port}.`,
      })
      await loadProcesses()
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Could not start binary process' })
    } finally {
      setSpawning(false)
    }
  }

  async function handleViewLogs(proc) {
    setLogsTarget(proc)
    setLogsLoading(true)
    setLogsText('')
    try {
      const data = await apiFetch(`/containers/${proc.id}/logs`)
      setLogsText(data?.logs || 'No output captured yet')
    } catch (err) {
      setLogsText(`Failed to read logs: ${err.message}`)
    } finally {
      setLogsLoading(false)
    }
  }

  const filtered = processes.filter((p) => {
    if (!search.trim()) return true
    const q = search.toLowerCase()
    return (
      (p.name || '').toLowerCase().includes(q) ||
      (p.command || '').toLowerCase().includes(q) ||
      String(p.pid || '').includes(q) ||
      String(p.port || '').includes(q)
    )
  })

  return (
    <div className="p-6 sm:p-8 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-100">Native Host Processes</h1>
          <p className="text-slate-400 text-sm mt-1">
            Live OS-level processes running directly on the host with real-time PID, CPU, memory, and uptime telemetry.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setAutoRefresh((v) => !v)}
            className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-medium whitespace-nowrap transition-colors ${
              autoRefresh
                ? 'bg-green-500/10 border-green-500/30 text-green-300'
                : 'bg-slate-800 border-slate-700 text-slate-300'
            }`}
          >
            <Activity className="w-3.5 h-3.5" />
            <span>{autoRefresh ? 'Live Poll: 2s' : 'Live Poll: Paused'}</span>
          </button>
          <button
            type="button"
            onClick={loadProcesses}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-sm font-medium text-slate-200 whitespace-nowrap transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            <span>Refresh</span>
          </button>
          <button
            type="button"
            onClick={() => setShowModal(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-kathal-600 hover:bg-kathal-500 text-white rounded-lg text-sm font-medium whitespace-nowrap transition-colors"
          >
            <Plus className="w-4 h-4" />
            <span>Run Binary Process</span>
          </button>
        </div>
      </div>

      {/* Telemetry Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-[#111827] border border-slate-800/90 rounded-xl p-5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-slate-400">Running Processes</span>
            <Terminal className="w-4 h-4 text-slate-500" />
          </div>
          <p className="text-2xl font-bold text-slate-100 tabular-nums">
            {summary?.totalRunning ?? 0}
          </p>
          <p className="text-xs text-slate-500 mt-1 tabular-nums">
            {summary?.customBinaries ?? 0} binary · {summary?.managedApps ?? 0} managed apps
          </p>
        </div>

        <div className="bg-[#111827] border border-slate-800/90 rounded-xl p-5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-slate-400">Process CPU Usage</span>
            <Cpu className="w-4 h-4 text-slate-500" />
          </div>
          <p className="text-2xl font-bold text-slate-100 tabular-nums">
            {(summary?.totalCpuPercent ?? 0).toFixed(1)}%
          </p>
          <p className="text-xs text-slate-500 mt-1 tabular-nums">
            {host?.cpuCores ?? 1} host cores · load {host?.load1 ?? '0.00'}
          </p>
        </div>

        <div className="bg-[#111827] border border-slate-800/90 rounded-xl p-5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-slate-400">Process Memory (RSS)</span>
            <MemoryStick className="w-4 h-4 text-slate-500" />
          </div>
          <p className="text-2xl font-bold text-slate-100 tabular-nums">
            {(summary?.totalMemoryMb ?? 0).toFixed(1)} MB
          </p>
          <p className="text-xs text-slate-500 mt-1 tabular-nums">
            {(summary?.totalMemoryPercent ?? 0).toFixed(2)}% of {host?.totalMemoryMb ?? 0} MB host RAM
          </p>
        </div>

        <div className="bg-[#111827] border border-slate-800/90 rounded-xl p-5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-slate-400">Execution Mode</span>
            <Clock className="w-4 h-4 text-slate-500" />
          </div>
          <p className="text-lg font-bold text-green-400 mt-0.5">Direct Host OS</p>
          <p className="text-xs text-slate-500 mt-1 font-mono">
            {host?.platform || 'linux'} ({host?.arch || 'x64'})
          </p>
        </div>
      </div>

      {feedback && (
        <div
          className={`p-3 rounded-lg border text-sm ${
            feedback.type === 'error'
              ? 'bg-red-500/10 border-red-500/30 text-red-400'
              : 'bg-green-500/10 border-green-500/30 text-green-400'
          }`}
        >
          {feedback.text}
        </div>
      )}

      {/* Filter & Search Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 bg-[#111827] border border-slate-800 p-1 rounded-lg">
            {[
              { id: 'all', label: 'All Native' },
              { id: 'binary', label: 'Custom Binaries' },
              { id: 'local-app', label: 'Managed Apps' },
            ].map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setSourceFilter(item.id)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
                  sourceFilter === item.id
                    ? 'bg-kathal-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1 bg-[#111827] border border-slate-800 p-1 rounded-lg">
            <button
              type="button"
              onClick={() => setRunningOnly(true)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
                runningOnly ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Running Only
            </button>
            <button
              type="button"
              onClick={() => setRunningOnly(false)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
                !runningOnly ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Include Stopped
            </button>
          </div>
        </div>

        <input
          type="search"
          placeholder="Filter by name, PID, command, or port..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="px-3 py-2 bg-[#111827] border border-slate-800 rounded-lg text-sm text-slate-200 focus:border-kathal-500 focus:outline-none w-full sm:w-72"
        />
      </div>

      {/* Process Table */}
      {loading ? (
        <div className="bg-[#111827] border border-slate-800/90 rounded-xl p-6 space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-11 bg-slate-900/60 rounded-lg animate-pulse" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-[#111827] border border-slate-800/90 rounded-xl p-12 text-center space-y-3">
          <Terminal className="w-10 h-10 text-slate-500 mx-auto" />
          <h2 className="text-lg font-semibold text-slate-100">No Running Native Processes</h2>
          <p className="text-sm text-slate-400 max-w-md mx-auto">
            Launch any native binary command (Node.js, Python, Go, or custom executable) to inspect its live PID, CPU, memory usage, and uptime here.
          </p>
          <button
            type="button"
            onClick={() => setShowModal(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-kathal-600 hover:bg-kathal-500 text-white rounded-lg text-sm font-medium"
          >
            <Plus className="w-4 h-4" />
            <span>Run First Binary Process</span>
          </button>
        </div>
      ) : (
        <div className="bg-[#111827] border border-slate-800/90 rounded-xl overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead className="bg-slate-800/50 border-b border-slate-800">
              <tr>
                <th className="py-3 px-4 text-xs font-medium uppercase tracking-wider text-slate-400">Process &amp; Command</th>
                <th className="py-3 px-4 text-xs font-medium uppercase tracking-wider text-slate-400 text-right">PID</th>
                <th className="py-3 px-4 text-xs font-medium uppercase tracking-wider text-slate-400 text-right">CPU %</th>
                <th className="py-3 px-4 text-xs font-medium uppercase tracking-wider text-slate-400 text-right">Memory (RSS)</th>
                <th className="py-3 px-4 text-xs font-medium uppercase tracking-wider text-slate-400 text-right">Uptime</th>
                <th className="py-3 px-4 text-xs font-medium uppercase tracking-wider text-slate-400 text-right">Port</th>
                <th className="py-3 px-4 text-xs font-medium uppercase tracking-wider text-slate-400 text-right">Controls</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((proc) => {
                const isRunning = proc.state === 'running'
                const busy = busyId === proc.id
                return (
                  <tr
                    key={proc.id}
                    className="border-b border-slate-800/80 hover:bg-slate-800/30 transition-colors"
                  >
                    <td className="py-3 px-4 max-w-xs">
                      <div className="flex items-center gap-2.5">
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 ${
                            isRunning ? 'bg-green-500' : 'bg-slate-600'
                          }`}
                          aria-hidden="true"
                        />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="font-semibold text-sm text-slate-100 truncate">{proc.name}</p>
                            <span className="text-[11px] text-slate-400 shrink-0">
                              {proc.source === 'binary' ? 'Binary' : 'App'}
                            </span>
                          </div>
                          <p className="text-xs text-slate-400 font-mono truncate" title={proc.command}>
                            {proc.command || proc.runtimeLabel}
                          </p>
                        </div>
                      </div>
                    </td>

                    <td className="py-3 px-4 text-right font-mono text-xs text-slate-200 tabular-nums whitespace-nowrap">
                      {proc.pid ? proc.pid : '—'}
                    </td>

                    <td className="py-3 px-4 text-right font-mono text-xs text-slate-200 tabular-nums whitespace-nowrap">
                      {isRunning ? `${Number(proc.cpuPercent || 0).toFixed(1)}%` : '0.0%'}
                    </td>

                    <td className="py-3 px-4 text-right font-mono text-xs text-slate-200 tabular-nums whitespace-nowrap">
                      {isRunning ? (
                        <div>
                          <span>{Number(proc.memoryMb || 0).toFixed(1)} MB</span>
                          <span className="text-slate-500 ml-1">
                            ({Number(proc.memoryPercent || 0).toFixed(1)}%)
                          </span>
                        </div>
                      ) : (
                        '—'
                      )}
                    </td>

                    <td className="py-3 px-4 text-right font-mono text-xs text-slate-300 tabular-nums whitespace-nowrap">
                      {proc.uptimeLabel || proc.status}
                    </td>

                    <td className="py-3 px-4 text-right font-mono text-xs text-slate-300 tabular-nums whitespace-nowrap">
                      {proc.port ? `:${proc.port}` : '—'}
                    </td>

                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center justify-end gap-1.5">
                        {isRunning && proc.liveUrl && (
                          <a
                            href={proc.liveUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-green-600/20 hover:bg-green-600 text-green-300 hover:text-white border border-green-500/30 transition-colors"
                          >
                            <span>Open</span>
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                        {isRunning ? (
                          <>
                            <button
                              type="button"
                              onClick={() => handleAction(proc, 'stop')}
                              disabled={busy}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-amber-600 hover:bg-amber-500 text-white disabled:opacity-50"
                            >
                              <Square className="w-3 h-3" />
                              <span>Stop</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => handleAction(proc, 'restart')}
                              disabled={busy}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50"
                            >
                              <RotateCw className="w-3 h-3" />
                              <span>Restart</span>
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleAction(proc, 'start')}
                            disabled={busy}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-green-600 hover:bg-green-500 text-white disabled:opacity-50"
                          >
                            <Play className="w-3 h-3" />
                            <span>Start</span>
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleViewLogs(proc)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200"
                        >
                          <FileText className="w-3 h-3" />
                          <span>Logs</span>
                        </button>
                        {confirmDeleteId === proc.id ? (
                          <>
                            <button
                              type="button"
                              onClick={() => handleAction(proc, 'delete')}
                              disabled={busy}
                              className="px-2.5 py-1 rounded-md text-xs font-medium bg-red-600 hover:bg-red-500 text-white"
                            >
                              Confirm
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(null)}
                              className="px-2 py-1 rounded-md text-xs bg-slate-800 hover:bg-slate-700 text-slate-300"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(proc.id)}
                            disabled={busy}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-red-500/15 hover:bg-red-600 text-red-400 hover:text-white"
                          >
                            <Trash2 className="w-3 h-3" />
                            <span>Delete</span>
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Run Binary Process Modal */}
      {showModal && (
        <div
          className="fixed inset-0 bg-black/75 backdrop-blur-xs flex items-center justify-center z-50 p-4"
          onClick={() => setShowModal(false)}
        >
          <form
            onSubmit={handleSpawn}
            onClick={(e) => e.stopPropagation()}
            className="bg-[#111827] border border-slate-800 rounded-2xl p-6 max-w-lg w-full space-y-4 shadow-2xl"
          >
            <div>
              <h2 className="text-xl font-bold text-slate-100">Launch Native Binary Process</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Executes directly on the host OS without shell interpolation or Docker containers.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Process Name</label>
                <input
                  type="text"
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="my-worker"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-kathal-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Executable Binary</label>
                <input
                  type="text"
                  required
                  value={form.executable}
                  onChange={(e) => setForm({ ...form, executable: e.target.value })}
                  placeholder="python3"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm font-mono text-slate-100 focus:border-kathal-500 focus:outline-none"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Command Arguments (<code className="text-slate-400">{'{PORT}'}</code> injects assigned port)
              </label>
              <input
                type="text"
                value={form.args}
                onChange={(e) => setForm({ ...form, args: e.target.value })}
                placeholder="-m http.server {PORT} --bind 127.0.0.1"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm font-mono text-slate-100 focus:border-kathal-500 focus:outline-none"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Port (auto if blank)</label>
                <input
                  type="number"
                  min={1024}
                  max={65535}
                  value={form.port}
                  onChange={(e) => setForm({ ...form, port: e.target.value })}
                  placeholder="Auto"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm tabular-nums text-slate-100 focus:border-kathal-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Working Dir</label>
                <input
                  type="text"
                  value={form.workingDir}
                  onChange={(e) => setForm({ ...form, workingDir: e.target.value })}
                  placeholder="Auto workspace"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm font-mono text-slate-100 focus:border-kathal-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Domain (optional)</label>
                <input
                  type="text"
                  value={form.domain}
                  onChange={(e) => setForm({ ...form, domain: e.target.value })}
                  placeholder="app.local"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-kathal-500 focus:outline-none"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowModal(false)}
                className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm text-slate-300"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={spawning}
                className="px-4 py-2 rounded-lg bg-kathal-600 hover:bg-kathal-500 text-white text-sm font-medium disabled:opacity-50"
              >
                {spawning ? 'Starting...' : 'Spawn Process'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Logs Modal */}
      {logsTarget && (
        <div
          className="fixed inset-0 bg-black/75 backdrop-blur-xs flex items-center justify-center z-50 p-4"
          onClick={() => setLogsTarget(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-[#111827] border border-slate-800 rounded-2xl p-6 max-w-3xl w-full max-h-[80vh] flex flex-col"
          >
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-lg font-bold text-slate-100">{logsTarget.name} Process Output</h3>
                <p className="text-xs text-slate-400 font-mono">
                  PID {logsTarget.pid || '—'} · {logsTarget.command}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleViewLogs(logsTarget)}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-xs text-slate-200"
                >
                  Refresh
                </button>
                <button
                  type="button"
                  onClick={() => setLogsTarget(null)}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-xs text-slate-200"
                >
                  Close
                </button>
              </div>
            </div>
            <pre className="flex-1 overflow-auto bg-slate-950 border border-slate-800 rounded-xl p-4 text-xs font-mono text-slate-300 whitespace-pre-wrap">
              {logsLoading ? 'Loading process logs...' : logsText}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}
