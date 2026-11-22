import { useState, useEffect, useCallback } from 'react'
import {
  Play,
  Square,
  RotateCw,
  FileText,
  Trash2,
  Plus,
  RefreshCw,
  Box,
  ExternalLink,
  Globe,
} from 'lucide-react'
import { apiFetch, apiPost, apiDelete } from '../hooks/useApi'

const RUNTIME_PRESETS = [
  { label: 'Static Website', runtime: 'static', defaultName: 'my-website' },
  { label: 'Blog & CMS', runtime: 'cms', defaultName: 'my-blog' },
  { label: 'Node.js App', runtime: 'node', defaultName: 'node-app' },
  { label: 'Python 3 App', runtime: 'python', defaultName: 'python-app' },
  { label: 'SQLite Studio', runtime: 'sqlite', defaultName: 'sqlite-db' },
  { label: 'Uptime Monitor', runtime: 'monitor', defaultName: 'status-monitor' },
  { label: 'Git Repository', runtime: 'git', defaultName: 'git-app' },
  { label: 'Native Binary', runtime: 'binary', defaultName: 'custom-binary' },
]

function ContainerRow({ container, onRefresh, onViewLogs, onConnectDomain }) {
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
  }

  const stateText = {
    running: 'text-green-400',
    exited: 'text-slate-400',
  }

  const port = container.port || container.ports?.[0]?.hostPort

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
            <p className="text-xs text-slate-400 font-mono truncate">
              {container.runtimeLabel || container.image}
              {container.pid ? ` · PID ${container.pid}` : ''}
            </p>
            {container.command && (
              <p className="text-[11px] text-slate-500 font-mono truncate mt-0.5">
                {container.command}
              </p>
            )}
            {container.domains?.length > 0 && (
              <p className="text-xs text-kathal-400 font-mono truncate mt-0.5">
                {container.domains.map((d) => d.domain).join(', ')}
              </p>
            )}
          </div>
        </div>
      </td>
      <td className="py-3.5 px-4 whitespace-nowrap">
        <span className={`text-xs font-semibold capitalize ${stateText[container.state] || 'text-slate-400'}`}>
          {container.state === 'running' ? 'Running' : 'Stopped'}
        </span>
        {container.status && (
          <p className="text-xs text-slate-500 tabular-nums mt-0.5">{container.status}</p>
        )}
      </td>
      <td className="py-3.5 px-4 whitespace-nowrap">
        {port ? (
          <div className="text-xs font-mono text-slate-300 tabular-nums">
            127.0.0.1:{port}
          </div>
        ) : (
          <span className="text-xs text-slate-500">—</span>
        )}
      </td>
      <td className="py-3.5 px-4 text-right whitespace-nowrap">
        <div className="inline-flex items-center justify-end gap-1.5">
          {container.state === 'running' && container.liveUrl && (
            <a
              href={container.liveUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-green-600/20 hover:bg-green-600 border border-green-500/30 text-green-300 hover:text-white rounded-md text-xs font-medium transition-colors"
            >
              <span>Open App</span>
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
          <button
            type="button"
            onClick={() => onConnectDomain(container)}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 rounded-md text-xs font-medium transition-colors"
          >
            <Globe className="w-3 h-3" />
            <span>Domain</span>
          </button>
          {container.state !== 'running' ? (
            <button
              onClick={() => action(() => apiPost(`/containers/${container.id}/start`, {}))}
              disabled={loading}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-green-600 hover:bg-green-500 text-white rounded-md text-xs font-medium transition-colors disabled:opacity-50"
            >
              <Play className="w-3 h-3" />
              <span>Start</span>
            </button>
          ) : (
            <>
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
  const [containers, setContainers] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterState, setFilterState] = useState('all')

  const [showDeployModal, setShowDeployModal] = useState(false)
  const [deployForm, setDeployForm] = useState({
    name: '',
    runtime: 'static',
    repoUrl: '',
    branch: 'main',
    executable: 'python3',
    args: '-m http.server {PORT} --bind 127.0.0.1',
    workingDir: '',
    hostPort: '',
    domain: '',
    autoDomain: false,
  })
  const [deploying, setDeploying] = useState(false)
  const [feedback, setFeedback] = useState(null)

  const [domainTarget, setDomainTarget] = useState(null)
  const [domainInput, setDomainInput] = useState('')
  const [savingDomain, setSavingDomain] = useState(false)

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
      const payload = {
        name: deployForm.name,
        runtime: deployForm.runtime,
        hostPort: deployForm.hostPort ? Number(deployForm.hostPort) : undefined,
        domain: deployForm.domain,
        autoDomain: deployForm.autoDomain,
      }
      if (deployForm.runtime === 'git') {
        payload.repoUrl = deployForm.repoUrl.trim()
        payload.branch = deployForm.branch.trim() || 'main'
      }
      if (deployForm.runtime === 'binary') {
        payload.executable = deployForm.executable.trim()
        payload.args = deployForm.args
        if (deployForm.workingDir.trim()) {
          payload.workingDir = deployForm.workingDir.trim()
        }
      }
      const res = await apiPost('/deploy', payload)
      setShowDeployModal(false)
      setDeployForm({
        name: '',
        runtime: 'static',
        repoUrl: '',
        branch: 'main',
        executable: 'python3',
        args: '-m http.server {PORT} --bind 127.0.0.1',
        workingDir: '',
        hostPort: '',
        domain: '',
        autoDomain: false,
      })
      setFeedback({
        type: 'success',
        text: `App "${res.app?.name}" is running live on port ${res.app?.port}${
          res.proxyRoute ? ` · Domain: ${res.proxyRoute.domain}` : ''
        }`,
        liveUrl: res.liveUrl,
      })
      fetchContainers()
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to deploy local app' })
    } finally {
      setDeploying(false)
    }
  }

  async function handleSaveDomain(e) {
    e.preventDefault()
    if (!domainTarget) return
    setSavingDomain(true)
    setFeedback(null)
    try {
      await apiPost(`/apps/${domainTarget.id}/domain`, { domain: domainInput.trim() })
      setFeedback({
        type: 'success',
        text: `Connected domain "${domainInput.trim()}" to ${domainTarget.name} (127.0.0.1:${domainTarget.port}).`,
        liveUrl: domainTarget.liveUrl,
      })
      setDomainTarget(null)
      setDomainInput('')
      fetchContainers()
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Could not connect domain' })
    } finally {
      setSavingDomain(false)
    }
  }

  async function handleViewLogs(container) {
    setLogsTarget(container)
    setLogsLoading(true)
    setLogsText('')
    try {
      const data = await apiFetch(`/containers/${container.id}/logs`)
      setLogsText(data?.logs || 'No logs captured yet')
    } catch (err) {
      setLogsText(`Failed to load logs: ${err.message}`)
    } finally {
      setLogsLoading(false)
    }
  }

  const filteredContainers = containers.filter((c) => {
    const matchesSearch =
      !search ||
      (c.name || '').toLowerCase().includes(search.toLowerCase()) ||
      (c.runtimeLabel || c.image || '').toLowerCase().includes(search.toLowerCase())
    const matchesState =
      filterState === 'all' ||
      (filterState === 'stopped' ? c.state !== 'running' : c.state === filterState)
    return matchesSearch && matchesState
  })

  return (
    <div className="p-6 sm:p-8 max-w-7xl mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-100">Running Local Apps</h1>
          <p className="text-slate-400 text-sm mt-1">
            {containers.length} local app{containers.length === 1 ? '' : 's'} running directly on host processes (Node.js / Python / Git) — zero Docker required.
          </p>
        </div>
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
            <span>Install Local App</span>
          </button>
        </div>
      </div>

      {feedback && (
        <div
          className={`p-3 rounded-lg border text-sm flex flex-wrap items-center justify-between gap-2 ${
            feedback.type === 'error'
              ? 'bg-red-500/10 border-red-500/30 text-red-400'
              : 'bg-green-500/10 border-green-500/30 text-green-400'
          }`}
        >
          <span>{feedback.text}</span>
          {feedback.liveUrl && (
            <a
              href={feedback.liveUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-green-600 hover:bg-green-500 text-white text-xs font-medium"
            >
              <span>Open Live App</span>
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
      )}

      {/* Search & Filter */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 bg-[#101A10] border border-slate-800 p-1 rounded-lg">
          {['all', 'running', 'stopped'].map((st) => (
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
          placeholder="Search apps by name or runtime..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="px-3 py-2 bg-[#101A10] border border-slate-800 rounded-lg text-sm text-slate-200 focus:border-kathal-500 focus:outline-none w-full sm:w-64"
        />
      </div>

      {loading ? (
        <div className="bg-[#101A10] border border-slate-800/90 rounded-xl p-12 text-center text-slate-500">
          Loading local apps...
        </div>
      ) : filteredContainers.length === 0 ? (
        <div className="bg-[#101A10] border border-slate-800/90 rounded-xl p-12 text-center">
          <Box className="w-10 h-10 text-slate-500 mx-auto mb-3" />
          <h2 className="text-lg font-semibold text-slate-100 mb-1">No Local Apps Running</h2>
          <p className="text-sm text-slate-400 mb-4">
            Install a real website, Node.js/Python app, SQLite studio, or Git repository right on this host.
          </p>
          <button
            onClick={() => setShowDeployModal(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-kathal-600 hover:bg-kathal-500 text-white rounded-lg text-sm font-medium"
          >
            <Plus className="w-4 h-4" />
            <span>Install First Local App</span>
          </button>
        </div>
      ) : (
        <div className="bg-[#101A10] border border-slate-800/90 rounded-xl overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead className="bg-slate-800/50 border-b border-slate-800">
              <tr>
                <th className="py-3 px-4 text-xs font-medium uppercase tracking-wider text-slate-400">App / Process</th>
                <th className="py-3 px-4 text-xs font-medium uppercase tracking-wider text-slate-400">Status</th>
                <th className="py-3 px-4 text-xs font-medium uppercase tracking-wider text-slate-400">Local Address</th>
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
                  onConnectDomain={(item) => {
                    setDomainTarget(item)
                    setDomainInput(item.domains?.[0]?.domain || '')
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Deploy Local App Modal */}
      {showDeployModal && (
        <div
          className="fixed inset-0 bg-black/75 backdrop-blur-xs flex items-center justify-center z-50 p-4"
          onClick={() => setShowDeployModal(false)}
        >
          <form
            onSubmit={handleDeploy}
            onClick={(e) => e.stopPropagation()}
            className="bg-[#101A10] border border-slate-800 rounded-2xl p-6 max-w-md w-full space-y-4"
          >
            <div>
              <h2 className="text-xl font-bold text-slate-100">Install &amp; Run Local App</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Choose a native runtime or Git repository — no Docker needed
              </p>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {RUNTIME_PRESETS.map((preset) => (
                <button
                  key={preset.runtime}
                  type="button"
                  onClick={() =>
                    setDeployForm((prev) => ({
                      ...prev,
                      name: prev.name || preset.defaultName,
                      runtime: preset.runtime,
                    }))
                  }
                  className={`px-2.5 py-1 rounded-md border text-xs transition-colors ${
                    deployForm.runtime === preset.runtime
                      ? 'bg-kathal-600/20 border-kathal-500 text-kathal-300 font-medium'
                      : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-200'
                  }`}
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

            {deployForm.runtime === 'git' && (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Public HTTPS Git URL</label>
                  <input
                    type="url"
                    placeholder="https://github.com/user/repo.git"
                    value={deployForm.repoUrl}
                    onChange={(e) => setDeployForm({ ...deployForm, repoUrl: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm font-mono text-slate-100 focus:border-kathal-500 focus:outline-none"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Branch</label>
                  <input
                    type="text"
                    placeholder="main"
                    value={deployForm.branch}
                    onChange={(e) => setDeployForm({ ...deployForm, branch: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-kathal-500 focus:outline-none"
                  />
                </div>
              </div>
            )}

            {deployForm.runtime === 'binary' && (
              <div className="space-y-3 p-3 rounded-xl bg-slate-900/70 border border-slate-800">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Binary Executable (e.g. node, python3, npx)
                  </label>
                  <input
                    type="text"
                    placeholder="python3"
                    value={deployForm.executable}
                    onChange={(e) => setDeployForm({ ...deployForm, executable: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm font-mono text-slate-100 focus:border-kathal-500 focus:outline-none"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Arguments (<code className="text-slate-400">{'{PORT}'}</code> injects assigned port)
                  </label>
                  <input
                    type="text"
                    placeholder="-m http.server {PORT} --bind 127.0.0.1"
                    value={deployForm.args}
                    onChange={(e) => setDeployForm({ ...deployForm, args: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm font-mono text-slate-100 focus:border-kathal-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Working Directory (optional)
                  </label>
                  <input
                    type="text"
                    placeholder="Auto workspace subfolder"
                    value={deployForm.workingDir}
                    onChange={(e) => setDeployForm({ ...deployForm, workingDir: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm font-mono text-slate-100 focus:border-kathal-500 focus:outline-none"
                  />
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Port (auto if blank)</label>
                <input
                  type="number"
                  placeholder="Auto (9000+)"
                  value={deployForm.hostPort}
                  onChange={(e) => setDeployForm({ ...deployForm, hostPort: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm tabular-nums text-slate-100 focus:border-kathal-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Custom Domain (optional)</label>
                <input
                  type="text"
                  placeholder="app.example.com"
                  value={deployForm.domain}
                  onChange={(e) => setDeployForm({ ...deployForm, domain: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-kathal-500 focus:outline-none"
                />
              </div>
            </div>

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
                {deploying ? 'Installing...' : 'Install & Launch'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Connect Domain Modal */}
      {domainTarget && (
        <div
          className="fixed inset-0 bg-black/75 backdrop-blur-xs flex items-center justify-center z-50 p-4"
          onClick={() => setDomainTarget(null)}
        >
          <form
            onSubmit={handleSaveDomain}
            onClick={(e) => e.stopPropagation()}
            className="bg-[#101A10] border border-slate-800 rounded-2xl p-6 max-w-md w-full space-y-4"
          >
            <div>
              <h2 className="text-lg font-bold text-slate-100">Connect Domain to {domainTarget.name}</h2>
              <p className="text-xs text-slate-400 mt-1">
                Point your domain&apos;s DNS <code className="text-slate-300">A</code> record to this server&apos;s IP. KATHAL routes incoming traffic automatically to <code className="text-slate-300">127.0.0.1:{domainTarget.port}</code>.
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Domain Name</label>
              <input
                type="text"
                value={domainInput}
                onChange={(e) => setDomainInput(e.target.value)}
                placeholder="myapp.example.com"
                required
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-kathal-500 focus:outline-none"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDomainTarget(null)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm text-slate-300"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingDomain}
                className="px-4 py-2 bg-kathal-600 hover:bg-kathal-500 text-white rounded-lg text-sm font-medium disabled:opacity-50"
              >
                {savingDomain ? 'Connecting...' : 'Connect Domain'}
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
            className="bg-[#101A10] border border-slate-800 rounded-2xl p-6 max-w-3xl w-full max-h-[80vh] flex flex-col"
          >
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-lg font-bold text-slate-100">{logsTarget.name} Process Logs</h3>
                <p className="text-xs text-slate-400 font-mono">
                  {logsTarget.runtimeLabel || logsTarget.image}
                  {logsTarget.pid ? ` · PID ${logsTarget.pid}` : ''}
                </p>
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
              {logsLoading ? 'Loading process logs...' : logsText}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}
