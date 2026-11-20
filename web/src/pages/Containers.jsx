import { useState, useEffect, useCallback } from 'react'
import {
  Play,
  Pause,
  Square,
  RotateCw,
  FileText,
  Trash2,
  Plus,
  RefreshCw,
  Box,
} from 'lucide-react'
import { useApi, apiFetch, apiPost, apiDelete } from '../hooks/useApi'

const DEPLOY_PRESETS = [
  { label: 'Website (Nginx)', name: 'my-website', image: 'nginx:alpine', containerPort: '80' },
  { label: 'PostgreSQL DB', name: 'my-postgres', image: 'postgres:16-alpine', containerPort: '5432' },
  { label: 'Redis Cache', name: 'my-redis', image: 'redis:7-alpine', containerPort: '6379' },
]

function ContainerRow({ container, onRefresh, onViewLogs }) {
  const [loading, setLoading] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const action = async (fn) => {
    setLoading(true)
    try {
      await fn()
    } catch {
      // handled by refresh
    }
    setLoading(false)
    onRefresh()
  }

  const stateColor = {
    running: 'bg-green-500',
    exited: 'bg-slate-500',
    paused: 'bg-amber-400',
  }

  const stateText = {
    running: 'text-green-400',
    paused: 'text-amber-400',
    exited: 'text-slate-400',
  }

  return (
    <tr className="border-b border-slate-800/80 hover:bg-slate-800/30 transition-colors">
      <td className="py-3.5 px-4">
        <div className="flex items-center gap-3">
          <span
            className={`w-2.5 h-2.5 rounded-full shrink-0 ${stateColor[container.state] || 'bg-slate-500'}`}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="font-semibold text-slate-100 truncate">{container.name || container.id}</p>
            <p className="text-xs text-slate-400 font-mono truncate">{container.image}</p>
          </div>
        </div>
      </td>
      <td className="py-3.5 px-4 whitespace-nowrap">
        <span className={`text-xs font-semibold capitalize ${stateText[container.state] || 'text-slate-400'}`}>
          {container.state}
        </span>
        {container.status && (
          <p className="text-xs text-slate-500 tabular-nums mt-0.5">{container.status}</p>
        )}
      </td>
      <td className="py-3.5 px-4">
        {container.ports?.length ? (
          <div className="text-xs font-mono text-slate-300 tabular-nums space-y-0.5">
            {container.ports.map((p, i) => (
              <div key={i}>
                :{p.hostPort} → {p.containerPort}
              </div>
            ))}
          </div>
        ) : (
          <span className="text-xs text-slate-500">—</span>
        )}
      </td>
      <td className="py-3.5 px-4 text-right whitespace-nowrap">
        <div className="inline-flex items-center justify-end gap-1.5">
          {container.state !== 'running' && (
            <button
              onClick={() => action(() => apiPost(`/containers/${container.id}/start`, {}))}
              disabled={loading}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-green-600 hover:bg-green-500 text-white rounded-md text-xs font-medium transition-colors disabled:opacity-50"
            >
              <Play className="w-3 h-3" />
              <span>Start</span>
            </button>
          )}
          {container.state === 'running' && (
            <>
              <button
                onClick={() => action(() => apiPost(`/containers/${container.id}/pause`, {}))}
                disabled={loading}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-amber-400 rounded-md text-xs font-medium transition-colors disabled:opacity-50"
              >
                <Pause className="w-3 h-3" />
                <span>Pause</span>
              </button>
              <button
                onClick={() => action(() => apiPost(`/containers/${container.id}/stop`, {}))}
                disabled={loading}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded-md text-xs font-medium transition-colors disabled:opacity-50"
              >
                <Square className="w-3 h-3" />
                <span>Stop</span>
              </button>
              <button
                onClick={() => action(() => apiPost(`/containers/${container.id}/restart`, {}))}
                disabled={loading}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-md text-xs font-medium transition-colors disabled:opacity-50"
              >
                <RotateCw className="w-3 h-3" />
                <span>Restart</span>
              </button>
            </>
          )}
          <button
            onClick={() => onViewLogs(container)}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 rounded-md text-xs font-medium transition-colors"
          >
            <FileText className="w-3 h-3" />
            <span>Logs</span>
          </button>
          {confirmDelete ? (
            <>
              <button
                onClick={() => action(() => apiDelete(`/containers/${container.id}/delete`))}
                disabled={loading}
                className="px-2.5 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded-md text-xs font-medium disabled:opacity-50"
              >
                Confirm
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="px-2 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-md text-xs"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              disabled={loading}
              aria-label={`Delete ${container.name}`}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-red-500/15 hover:bg-red-600 text-red-400 hover:text-white rounded-md text-xs font-medium transition-colors disabled:opacity-50"
            >
              <Trash2 className="w-3 h-3" />
              <span>Delete</span>
            </button>
          )}
        </div>
      </td>
    </tr>
  )
}

export default function Containers() {
  const { data: status } = useApi('/status')
  const [containers, setContainers] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterState, setFilterState] = useState('all')

  const [showDeployModal, setShowDeployModal] = useState(false)
  const [deployForm, setDeployForm] = useState({
    name: '',
    image: 'nginx:alpine',
    hostPort: '',
    containerPort: '80',
    domain: '',
    autoDomain: true,
  })
  const [deploying, setDeploying] = useState(false)
  const [feedback, setFeedback] = useState(null)

  const [logsTarget, setLogsTarget] = useState(null)
  const [logsText, setLogsText] = useState('')
  const [logsLoading, setLogsLoading] = useState(false)

  const fetchContainers = useCallback(async () => {
    try {
      const data = await apiFetch('/containers?all=true')
      if (Array.isArray(data)) {
        setContainers(data)
      } else if (data?.containers) {
        setContainers(data.containers)
      } else {
        setContainers([])
      }
    } catch {
      setContainers([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchContainers()
  }, [fetchContainers])

  async function handleDeploy(e) {
    e.preventDefault()
    setDeploying(true)
    setFeedback(null)
    try {
      const res = await apiPost('/containers', {
        name: deployForm.name,
        image: deployForm.image,
        hostPort: deployForm.hostPort ? Number(deployForm.hostPort) : undefined,
        containerPort: deployForm.containerPort ? Number(deployForm.containerPort) : 80,
        domain: deployForm.domain,
        autoDomain: deployForm.autoDomain,
      })
      setShowDeployModal(false)
      setDeployForm({ name: '', image: 'nginx:alpine', hostPort: '', containerPort: '80', domain: '', autoDomain: true })
      setFeedback({
        type: 'success',
        text: `App "${res.container?.name}" is running on port ${res.app?.port}${
          res.proxyRoute ? ` · Web domain: ${res.proxyRoute.domain}` : ''
        }`,
      })
      fetchContainers()
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to deploy app' })
    } finally {
      setDeploying(false)
    }
  }

  async function handleViewLogs(container) {
    setLogsTarget(container)
    setLogsLoading(true)
    setLogsText('')
    try {
      const data = await apiFetch(`/containers/${container.id}/logs`)
      setLogsText(data?.logs || 'No logs available')
    } catch (err) {
      setLogsText(`Failed to load logs: ${err.message}`)
    } finally {
      setLogsLoading(false)
    }
  }

  const dockerAvailable = status?.dockerAvailable ?? true

  const filteredContainers = containers.filter((c) => {
    const matchesSearch =
      !search ||
      (c.name || '').toLowerCase().includes(search.toLowerCase()) ||
      (c.image || '').toLowerCase().includes(search.toLowerCase())
    const matchesState =
      filterState === 'all' ||
      (filterState === 'stopped' ? c.state !== 'running' && c.state !== 'paused' : c.state === filterState)
    return matchesSearch && matchesState
  })

  return (
    <div className="p-6 sm:p-8 max-w-7xl mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-100">Running Apps &amp; Containers</h1>
          <p className="text-slate-400 text-sm mt-1">
            {dockerAvailable
              ? `${containers.length} app container${containers.length === 1 ? '' : 's'} — start, stop, restart, or read live logs with one click`
              : 'Docker engine not available'}
          </p>
        </div>
        {dockerAvailable && (
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={fetchContainers}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-sm font-medium text-slate-200 whitespace-nowrap transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
              <span>Refresh</span>
            </button>
            <button
              onClick={() => setShowDeployModal(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-kathal-600 hover:bg-kathal-500 text-white rounded-lg text-sm font-medium whitespace-nowrap transition-colors"
            >
              <Plus className="w-4 h-4" />
              <span>Deploy App</span>
            </button>
          </div>
        )}
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

      {/* Search & Filter */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 bg-[#111827] border border-slate-800 p-1 rounded-lg">
          {['all', 'running', 'paused', 'stopped'].map((st) => (
            <button
              key={st}
              onClick={() => setFilterState(st)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium capitalize whitespace-nowrap transition-colors ${
                filterState === st
                  ? 'bg-kathal-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {st}
            </button>
          ))}
        </div>
        <input
          type="search"
          placeholder="Search apps by name or image..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="px-3 py-2 bg-[#111827] border border-slate-800 rounded-lg text-sm text-slate-200 focus:border-kathal-500 focus:outline-none w-full sm:w-64"
        />
      </div>

      {loading ? (
        <div className="bg-[#111827] border border-slate-800/90 rounded-xl p-12 text-center text-slate-500">
          Loading apps...
        </div>
      ) : filteredContainers.length === 0 ? (
        <div className="bg-[#111827] border border-slate-800/90 rounded-xl p-12 text-center">
          <Box className="w-10 h-10 text-slate-500 mx-auto mb-3" />
          <h2 className="text-lg font-semibold text-slate-100 mb-1">No Apps Found</h2>
          <p className="text-sm text-slate-400 mb-4">
            Launch a ready-made app from the App Store or deploy one here in seconds.
          </p>
          <button
            onClick={() => setShowDeployModal(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-kathal-600 hover:bg-kathal-500 text-white rounded-lg text-sm font-medium"
          >
            <Plus className="w-4 h-4" />
            <span>Deploy First App</span>
          </button>
        </div>
      ) : (
        <div className="bg-[#111827] border border-slate-800/90 rounded-xl overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead className="bg-slate-800/50 border-b border-slate-800">
              <tr>
                <th className="py-3 px-4 text-xs font-medium uppercase tracking-wider text-slate-400">App / Container</th>
                <th className="py-3 px-4 text-xs font-medium uppercase tracking-wider text-slate-400">Status</th>
                <th className="py-3 px-4 text-xs font-medium uppercase tracking-wider text-slate-400">Ports</th>
                <th className="py-3 px-4 text-xs font-medium uppercase tracking-wider text-slate-400 text-right">Controls</th>
              </tr>
            </thead>
            <tbody>
              {filteredContainers.map((c) => (
                <ContainerRow
                  key={c.id}
                  container={c}
                  onRefresh={fetchContainers}
                  onViewLogs={handleViewLogs}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Deploy Container Modal */}
      {showDeployModal && (
        <div
          className="fixed inset-0 bg-black/75 backdrop-blur-xs flex items-center justify-center z-50 p-4"
          onClick={() => setShowDeployModal(false)}
        >
          <form
            onSubmit={handleDeploy}
            onClick={(e) => e.stopPropagation()}
            className="bg-[#111827] border border-slate-800 rounded-2xl p-6 max-w-md w-full space-y-4"
          >
            <div>
              <h2 className="text-xl font-bold text-slate-100">Deploy New App</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Pick a preset or enter a custom container image below
              </p>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {DEPLOY_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() =>
                    setDeployForm((prev) => ({
                      ...prev,
                      name: prev.name || preset.name,
                      image: preset.image,
                      containerPort: preset.containerPort,
                    }))
                  }
                  className="px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs text-slate-200"
                >
                  {preset.label}
                </button>
              ))}
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">App Name</label>
              <input
                type="text"
                placeholder="my-web-app"
                value={deployForm.name}
                onChange={(e) => setDeployForm({ ...deployForm, name: e.target.value })}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-kathal-500 focus:outline-none"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Container Image</label>
              <input
                type="text"
                placeholder="nginx:alpine"
                value={deployForm.image}
                onChange={(e) => setDeployForm({ ...deployForm, image: e.target.value })}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm font-mono text-slate-100 focus:border-kathal-500 focus:outline-none"
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Host Port (auto if empty)</label>
                <input
                  type="number"
                  placeholder="Auto"
                  value={deployForm.hostPort}
                  onChange={(e) => setDeployForm({ ...deployForm, hostPort: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm tabular-nums text-slate-100 focus:border-kathal-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">App Port</label>
                <input
                  type="number"
                  placeholder="80"
                  value={deployForm.containerPort}
                  onChange={(e) => setDeployForm({ ...deployForm, containerPort: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm tabular-nums text-slate-100 focus:border-kathal-500 focus:outline-none"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Custom Domain (optional)</label>
              <input
                type="text"
                placeholder="app.kathal.local"
                value={deployForm.domain}
                onChange={(e) => setDeployForm({ ...deployForm, domain: e.target.value })}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-kathal-500 focus:outline-none"
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={deployForm.autoDomain}
                onChange={(e) => setDeployForm({ ...deployForm, autoDomain: e.target.checked })}
                className="w-4 h-4 accent-kathal-500"
              />
              Auto-create a friendly web address if domain is left blank
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowDeployModal(false)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm text-slate-300"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={deploying}
                className="px-4 py-2 bg-kathal-600 hover:bg-kathal-500 text-white rounded-lg text-sm font-medium disabled:opacity-50"
              >
                {deploying ? 'Deploying...' : 'Launch App'}
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
                <h3 className="text-lg font-bold text-slate-100">{logsTarget.name} Logs</h3>
                <p className="text-xs text-slate-400 font-mono">{logsTarget.image}</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleViewLogs(logsTarget)}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-xs text-slate-200"
                >
                  Refresh
                </button>
                <button
                  onClick={() => setLogsTarget(null)}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-xs text-slate-200"
                >
                  Close
                </button>
              </div>
            </div>
            <pre className="flex-1 overflow-auto bg-slate-950 border border-slate-800 rounded-xl p-4 text-xs font-mono text-slate-300 whitespace-pre-wrap">
              {logsLoading ? 'Loading container logs...' : logsText}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}
