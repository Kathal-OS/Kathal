import { useState, useEffect, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Play, Square, RotateCw, FileCode2, Trash2, Plus, ScanSearch } from 'lucide-react'
import { apiFetch, apiPost, apiPut, apiDelete } from '../hooks/useApi'

const COMPOSE_PLACEHOLDER = `version: '3.8'
services:
  web:
    image: nginx:alpine
    ports:
      - "8085:80"`

const VISUAL_SERVICE_PRESETS = [
  { label: 'Web Server (Nginx)', defaultName: 'web', image: 'nginx:alpine', hostPort: '8085', containerPort: '80' },
  { label: 'PostgreSQL Database', defaultName: 'db', image: 'postgres:16-alpine', hostPort: '5432', containerPort: '5432' },
  { label: 'Redis Cache', defaultName: 'cache', image: 'redis:7-alpine', hostPort: '6379', containerPort: '6379' },
  { label: 'Grafana Dashboard', defaultName: 'analytics', image: 'grafana/grafana:latest', hostPort: '3002', containerPort: '3000' },
]

function buildComposeYaml(services) {
  const lines = ["version: '3.8'", 'services:']
  for (const svc of services) {
    const cleanName = (svc.name || 'app').trim().replace(/[^a-zA-Z0-9_-]/g, '-')
    lines.push(`  ${cleanName}:`)
    lines.push(`    image: ${svc.image || 'nginx:alpine'}`)
    if (svc.hostPort && svc.containerPort) {
      lines.push('    ports:')
      lines.push(`      - "${svc.hostPort}:${svc.containerPort}"`)
    }
  }
  return lines.join('\n')
}

function formatUpdatedAt(iso) {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function getStackHealth(project) {
  if (project.health) return project.health
  const defs = project.serviceDefs || []
  const total = defs.length || project.services?.length || 0
  if (project.status === 'running' && total > 0) {
    return { status: 'healthy', label: 'Healthy', runningServices: total, totalServices: total }
  }
  return { status: 'down', label: 'Down', runningServices: 0, totalServices: total }
}

const HEALTH_DOT = {
  healthy: 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]',
  degraded: 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.5)]',
  down: 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]',
}

const HEALTH_TEXT = {
  healthy: 'text-green-400',
  degraded: 'text-amber-400',
  down: 'text-red-400',
}

const SERVICE_DOT = {
  running: 'bg-green-500',
  paused: 'bg-amber-400',
  exited: 'bg-red-500',
  down: 'bg-red-500',
}

export default function Compose() {
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [actionBusy, setActionBusy] = useState(null)
  const [confirmDeleteName, setConfirmDeleteName] = useState(null)

  const [showAdd, setShowAdd] = useState(false)
  const [addMode, setAddMode] = useState('visual')
  const [visualServices, setVisualServices] = useState([
    { name: 'web', image: 'nginx:alpine', hostPort: '8085', containerPort: '80' },
  ])
  const [showEdit, setShowEdit] = useState(false)
  const [selectedProject, setSelectedProject] = useState(null)
  const [form, setForm] = useState({ name: '', config: '' })
  const [validationMsg, setValidationMsg] = useState(null)
  const [feedback, setFeedback] = useState(null)

  const loadProjects = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiFetch('/compose')
      setProjects(Array.isArray(data) ? data : [])
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to load Compose stacks' })
      setProjects([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadProjects()
  }, [loadProjects])

  async function handleScan() {
    setScanning(true)
    setFeedback(null)
    try {
      const data = await apiPost('/compose/scan', {})
      const list = Array.isArray(data) ? data : []
      setProjects(list)
      setFeedback({
        type: 'success',
        text: `Scanned system files and parsed ${list.length} Compose stack(s).`,
      })
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to scan Compose files' })
    } finally {
      setScanning(false)
    }
  }

  async function handleValidate(yamlText) {
    setValidationMsg(null)
    try {
      const res = await apiPost('/compose/validate', { config: yamlText })
      setValidationMsg(
        res.valid
          ? {
              type: 'success',
              text: `Valid configuration (${res.services.length} service(s): ${res.services.join(', ')})`,
            }
          : { type: 'error', text: 'No services found under "services:" block.' }
      )
    } catch (err) {
      setValidationMsg({ type: 'error', text: err.message || 'Validation error' })
    }
  }

  async function handleAdd(e) {
    e.preventDefault()
    setFeedback(null)
    const configToSave = addMode === 'visual' ? buildComposeYaml(visualServices) : form.config
    try {
      await apiPost('/compose', { name: form.name, config: configToSave })
      setShowAdd(false)
      setForm({ name: '', config: '' })
      setValidationMsg(null)
      setFeedback({
        type: 'success',
        text: `Created stack "${form.name}". Click Start in the table below to launch all services.`,
      })
      loadProjects()
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to create stack' })
    }
  }

  async function handleUpdate(e) {
    e.preventDefault()
    if (!selectedProject) return
    setFeedback(null)
    try {
      await apiPut(`/compose/${encodeURIComponent(selectedProject.name)}`, { config: form.config })
      setShowEdit(false)
      setValidationMsg(null)
      setFeedback({ type: 'success', text: `Saved changes for "${selectedProject.name}".` })
      loadProjects()
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to update stack' })
    }
  }

  async function handleStackAction(name, action) {
    setActionBusy(`${name}:${action}`)
    setFeedback(null)
    try {
      const res = await apiPost(`/compose/${encodeURIComponent(name)}/${action}`, {})
      const svcCount = res.deployedCount ?? res.services?.length ?? 0
      const messages = {
        start: `Started stack "${name}" (${svcCount} service(s) running).`,
        stop: `Stopped stack "${name}" and exited its service containers.`,
        restart: `Restarted stack "${name}" (${svcCount} service(s) active).`,
      }
      setFeedback({ type: 'success', text: messages[action] || `Executed ${action} on "${name}".` })
      loadProjects()
    } catch (err) {
      setFeedback({ type: 'error', text: `Failed to ${action} "${name}": ${err.message}` })
    } finally {
      setActionBusy(null)
    }
  }

  async function handleDelete(name) {
    setActionBusy(`${name}:delete`)
    setFeedback(null)
    try {
      await apiDelete(`/compose/${encodeURIComponent(name)}`)
      setConfirmDeleteName(null)
      setFeedback({ type: 'success', text: `Removed stack "${name}".` })
      loadProjects()
    } catch (err) {
      setFeedback({ type: 'error', text: `Delete failed: ${err.message}` })
    } finally {
      setActionBusy(null)
    }
  }

  function openInspector(project) {
    setSelectedProject(project)
    setForm({ name: project.name, config: project.config || '' })
    setValidationMsg(null)
    setShowEdit(true)
  }

  const summary = useMemo(() => {
    const healthy = projects.filter((p) => getStackHealth(p).status === 'healthy').length
    const degraded = projects.filter((p) => getStackHealth(p).status === 'degraded').length
    const down = projects.filter((p) => getStackHealth(p).status === 'down').length
    const totalServices = projects.reduce(
      (sum, p) => sum + (p.serviceDefs?.length ?? p.services?.length ?? 0),
      0
    )
    return { total: projects.length, healthy, degraded, down, totalServices }
  }, [projects])

  const filteredProjects = useMemo(() => {
    const q = search.trim().toLowerCase()
    return projects.filter((p) => {
      const health = getStackHealth(p)
      const matchesStatus =
        statusFilter === 'all' ||
        (statusFilter === 'healthy' && health.status === 'healthy') ||
        (statusFilter === 'down' && health.status !== 'healthy')
      if (!matchesStatus) return false
      if (!q) return true
      const serviceNames = (p.serviceDefs || []).map((s) => `${s.name} ${s.image}`).join(' ')
      return (
        p.name.toLowerCase().includes(q) ||
        (p.filePath || '').toLowerCase().includes(q) ||
        serviceNames.toLowerCase().includes(q)
      )
    })
  }, [projects, search, statusFilter])

  return (
    <div className="p-6 sm:p-8 max-w-7xl mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-100">Compose Stacks</h1>
          <p className="text-slate-400 text-sm mt-1">
            Group multiple apps together (like a website + database), monitor live service health, or build stacks visually without writing YAML
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleScan}
            disabled={scanning}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 rounded-lg text-sm font-medium whitespace-nowrap transition-colors disabled:opacity-50"
          >
            <ScanSearch className="w-4 h-4" />
            <span>{scanning ? 'Scanning...' : 'Scan Compose Files'}</span>
          </button>
          <button
            onClick={() => {
              setForm({ name: '', config: COMPOSE_PLACEHOLDER })
              setAddMode('visual')
              setVisualServices([{ name: 'web', image: 'nginx:alpine', hostPort: '8085', containerPort: '80' }])
              setValidationMsg(null)
              setShowAdd(true)
            }}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-kathal-600 hover:bg-kathal-500 text-white rounded-lg text-sm font-medium whitespace-nowrap transition-colors"
          >
            <Plus className="w-4 h-4" />
            <span>New Stack</span>
          </button>
        </div>
      </div>

      {/* Summary Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="bg-[#111827] border border-slate-800/90 rounded-xl px-4 py-3.5">
          <p className="text-xs font-medium text-slate-400">Discovered Stacks</p>
          <p className="text-2xl font-semibold text-slate-100 mt-1 tabular-nums">{summary.total}</p>
        </div>
        <div className="bg-[#111827] border border-slate-800/90 rounded-xl px-4 py-3.5">
          <p className="text-xs font-medium text-slate-400">Healthy Stacks</p>
          <p className="text-2xl font-semibold text-green-400 mt-1 tabular-nums">{summary.healthy}</p>
        </div>
        <div className="bg-[#111827] border border-slate-800/90 rounded-xl px-4 py-3.5">
          <p className="text-xs font-medium text-slate-400">Down / Degraded</p>
          <p className="text-2xl font-semibold text-red-400 mt-1 tabular-nums">
            {summary.down + summary.degraded}
          </p>
        </div>
        <div className="bg-[#111827] border border-slate-800/90 rounded-xl px-4 py-3.5">
          <p className="text-xs font-medium text-slate-400">Parsed Services</p>
          <p className="text-2xl font-semibold text-kathal-400 mt-1 tabular-nums">{summary.totalServices}</p>
        </div>
      </div>

      {/* Filter & Search Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 bg-[#111827] border border-slate-800 rounded-lg p-1">
          {[
            { id: 'all', label: `All (${summary.total})` },
            { id: 'healthy', label: `Healthy (${summary.healthy})` },
            { id: 'down', label: `Down / Degraded (${summary.down + summary.degraded})` },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setStatusFilter(tab.id)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
                statusFilter === tab.id
                  ? 'bg-kathal-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search stacks, file paths, or services..."
          className="px-3 py-2 bg-[#111827] border border-slate-800 rounded-lg text-sm text-slate-200 focus:border-kathal-500 focus:outline-none w-full sm:w-72"
        />
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
          {feedback.type === 'success' && (
            <Link to="/containers" className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 rounded text-xs text-slate-200 whitespace-nowrap">
              Running Apps →
            </Link>
          )}
        </div>
      )}

      {loading ? (
        <div className="bg-[#111827] border border-slate-800/90 rounded-xl p-12 text-center text-slate-500">
          Scanning and parsing Compose stacks...
        </div>
      ) : filteredProjects.length === 0 ? (
        <div className="bg-[#111827] border border-slate-800/90 rounded-xl p-12 text-center">
          <h2 className="text-lg font-semibold text-slate-200 mb-1">
            {projects.length === 0 ? 'No Compose stacks found' : 'No stacks match your filter'}
          </h2>
          <p className="text-sm text-slate-400 mb-4">
            {projects.length === 0
              ? 'Scan your workspace or create a new stack visually without writing YAML.'
              : 'Try clearing the search query or switching the health filter.'}
          </p>
        </div>
      ) : (
        <div className="bg-[#111827] border border-slate-800/90 rounded-xl overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead className="bg-slate-800/50 border-b border-slate-800">
              <tr>
                <th className="py-3 px-4 text-xs font-medium uppercase tracking-wider text-slate-400">
                  Stack / Source File
                </th>
                <th className="py-3 px-4 text-xs font-medium uppercase tracking-wider text-slate-400">
                  Health
                </th>
                <th className="py-3 px-4 text-xs font-medium uppercase tracking-wider text-slate-400">
                  Parsed Services
                </th>
                <th className="py-3 px-4 text-xs font-medium uppercase tracking-wider text-slate-400">
                  Updated
                </th>
                <th className="py-3 px-4 text-xs font-medium uppercase tracking-wider text-slate-400 text-right">
                  Controls
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {filteredProjects.map((p) => {
                const health = getStackHealth(p)
                const isRunning = p.status === 'running' || health.status === 'healthy'
                const defs = p.serviceDefs || (p.services || []).map((s) => ({ name: s, image: '', state: 'down' }))
                const isBusy = actionBusy?.startsWith(`${p.name}:`)
                return (
                  <tr key={p.name} className="hover:bg-slate-800/30 transition-colors">
                    <td className="py-3.5 px-4 align-top">
                      <div className="font-semibold text-slate-100">{p.name}</div>
                      <div className="text-xs text-slate-400 font-mono mt-0.5">
                        {p.filePath || `${p.workingDir}/docker-compose.yml`}
                      </div>
                    </td>
                    <td className="py-3.5 px-4 align-top whitespace-nowrap">
                      <div
                        className="inline-flex items-center gap-2"
                        title={`${health.runningServices} of ${health.totalServices} services running`}
                      >
                        <span
                          aria-label={`Health status: ${health.label}`}
                          className={`w-2.5 h-2.5 rounded-full shrink-0 ${HEALTH_DOT[health.status] || HEALTH_DOT.down}`}
                        />
                        <div>
                          <div className={`text-xs font-semibold ${HEALTH_TEXT[health.status] || HEALTH_TEXT.down}`}>
                            {health.label}
                          </div>
                          <div className="text-[11px] text-slate-500 tabular-nums">
                            {health.runningServices}/{health.totalServices} running
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="py-3.5 px-4 align-top">
                      {defs.length === 0 ? (
                        <span className="text-xs text-slate-500">No services parsed</span>
                      ) : (
                        <div className="space-y-1">
                          {defs.map((svc) => {
                            const svcState = svc.state || (isRunning ? 'running' : 'down')
                            return (
                              <div key={svc.name} className="text-xs text-slate-300 flex flex-wrap items-center gap-1.5">
                                <span
                                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${SERVICE_DOT[svcState] || SERVICE_DOT.down}`}
                                  title={`${svc.name}: ${svcState}`}
                                />
                                <span className="font-medium text-slate-100">{svc.name}</span>
                                {svc.image && (
                                  <>
                                    <span className="text-slate-600">·</span>
                                    <span className="font-mono text-slate-400">{svc.image}</span>
                                  </>
                                )}
                                {svc.hostPort && (
                                  <>
                                    <span className="text-slate-600">·</span>
                                    <span className="font-mono text-kathal-400 tabular-nums">
                                      :{svc.hostPort}→{svc.containerPort || svc.hostPort}
                                    </span>
                                  </>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </td>
                    <td className="py-3.5 px-4 align-top text-xs text-slate-400 tabular-nums whitespace-nowrap">
                      {formatUpdatedAt(p.updatedAt)}
                    </td>
                    <td className="py-3.5 px-4 align-top text-right whitespace-nowrap">
                      <div className="inline-flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => handleStackAction(p.name, 'start')}
                          disabled={isBusy || health.status === 'healthy'}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-green-600 hover:bg-green-500 disabled:bg-slate-800 disabled:text-slate-500 text-white rounded-md text-xs font-medium transition-colors"
                        >
                          <Play className="w-3 h-3" />
                          <span>{actionBusy === `${p.name}:start` ? 'Starting...' : 'Start'}</span>
                        </button>
                        <button
                          onClick={() => handleStackAction(p.name, 'stop')}
                          disabled={isBusy || health.runningServices === 0}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-amber-600 hover:bg-amber-500 disabled:bg-slate-800 disabled:text-slate-500 text-white rounded-md text-xs font-medium transition-colors"
                        >
                          <Square className="w-3 h-3" />
                          <span>{actionBusy === `${p.name}:stop` ? 'Stopping...' : 'Stop'}</span>
                        </button>
                        <button
                          onClick={() => handleStackAction(p.name, 'restart')}
                          disabled={isBusy}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-md text-xs font-medium transition-colors"
                        >
                          <RotateCw className="w-3 h-3" />
                          <span>{actionBusy === `${p.name}:restart` ? 'Restarting...' : 'Restart'}</span>
                        </button>
                        <button
                          onClick={() => openInspector(p)}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 rounded-md text-xs font-medium transition-colors"
                        >
                          <FileCode2 className="w-3 h-3" />
                          <span>YAML</span>
                        </button>
                        {confirmDeleteName === p.name ? (
                          <>
                            <button
                              onClick={() => handleDelete(p.name)}
                              disabled={isBusy}
                              className="px-2.5 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded-md text-xs font-medium"
                            >
                              Confirm
                            </button>
                            <button
                              onClick={() => setConfirmDeleteName(null)}
                              className="px-2 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-md text-xs"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => setConfirmDeleteName(p.name)}
                            disabled={isBusy}
                            aria-label={`Delete ${p.name}`}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-red-500/15 hover:bg-red-600 text-red-400 hover:text-white rounded-md text-xs transition-colors"
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

      {/* New Stack Modal (Visual Builder + YAML Editor) */}
      {showAdd && (
        <div
          className="fixed inset-0 bg-black/75 backdrop-blur-xs flex items-center justify-center z-50 p-4"
          onClick={() => setShowAdd(false)}
        >
          <form
            onSubmit={handleAdd}
            onClick={(e) => e.stopPropagation()}
            className="bg-[#111827] border border-slate-800 rounded-2xl p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto space-y-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-xl font-bold text-slate-100">Create Compose Stack</h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Add services visually or paste an existing docker-compose.yml file
                </p>
              </div>
              <div className="flex items-center gap-1 bg-slate-950 border border-slate-800 rounded-lg p-1">
                <button
                  type="button"
                  onClick={() => setAddMode('visual')}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                    addMode === 'visual' ? 'bg-kathal-600 text-white' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Visual Builder (No Code)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setForm((prev) => ({ ...prev, config: buildComposeYaml(visualServices) }))
                    setAddMode('yaml')
                  }}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                    addMode === 'yaml' ? 'bg-kathal-600 text-white' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  YAML Editor
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Stack Name</label>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="my-app-stack"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-kathal-500 focus:outline-none"
                required
              />
            </div>

            {addMode === 'visual' ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-medium text-slate-300">Services in this stack</span>
                  <div className="flex flex-wrap gap-1.5">
                    {VISUAL_SERVICE_PRESETS.map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() =>
                          setVisualServices((prev) => [
                            ...prev,
                            {
                              name: `${preset.defaultName}-${prev.length + 1}`,
                              image: preset.image,
                              hostPort: preset.hostPort,
                              containerPort: preset.containerPort,
                            },
                          ])
                        }
                        className="px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs text-slate-200"
                      >
                        + {preset.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-2.5">
                  {visualServices.map((svc, idx) => (
                    <div
                      key={idx}
                      className="grid grid-cols-1 sm:grid-cols-12 gap-2 p-3 rounded-xl bg-slate-950/70 border border-slate-800 items-end"
                    >
                      <div className="sm:col-span-3">
                        <label className="block text-[11px] text-slate-400 mb-1">Service Name</label>
                        <input
                          value={svc.name}
                          onChange={(e) =>
                            setVisualServices((prev) =>
                              prev.map((item, i) => (i === idx ? { ...item, name: e.target.value } : item))
                            )
                          }
                          className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-100"
                          required
                        />
                      </div>
                      <div className="sm:col-span-4">
                        <label className="block text-[11px] text-slate-400 mb-1">App Image</label>
                        <input
                          value={svc.image}
                          onChange={(e) =>
                            setVisualServices((prev) =>
                              prev.map((item, i) => (i === idx ? { ...item, image: e.target.value } : item))
                            )
                          }
                          className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs font-mono text-slate-100"
                          required
                        />
                      </div>
                      <div className="sm:col-span-2">
                        <label className="block text-[11px] text-slate-400 mb-1">Host Port</label>
                        <input
                          value={svc.hostPort}
                          onChange={(e) =>
                            setVisualServices((prev) =>
                              prev.map((item, i) => (i === idx ? { ...item, hostPort: e.target.value } : item))
                            )
                          }
                          className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs tabular-nums text-slate-100"
                        />
                      </div>
                      <div className="sm:col-span-2">
                        <label className="block text-[11px] text-slate-400 mb-1">App Port</label>
                        <input
                          value={svc.containerPort}
                          onChange={(e) =>
                            setVisualServices((prev) =>
                              prev.map((item, i) => (i === idx ? { ...item, containerPort: e.target.value } : item))
                            )
                          }
                          className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs tabular-nums text-slate-100"
                        />
                      </div>
                      <div className="sm:col-span-1 flex justify-end">
                        <button
                          type="button"
                          disabled={visualServices.length <= 1}
                          onClick={() =>
                            setVisualServices((prev) => prev.filter((_, i) => i !== idx))
                          }
                          aria-label="Remove service"
                          className="p-1.5 rounded-lg text-slate-400 hover:text-red-400 hover:bg-slate-800 disabled:opacity-30"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">docker-compose.yml</label>
                <textarea
                  value={form.config}
                  onChange={(e) => setForm({ ...form, config: e.target.value })}
                  rows={12}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-xs font-mono text-slate-200 focus:border-kathal-500 focus:outline-none"
                />
              </div>
            )}

            {validationMsg && (
              <div
                className={`p-2.5 rounded-lg text-xs border ${
                  validationMsg.type === 'error'
                    ? 'bg-red-500/10 border-red-500/30 text-red-400'
                    : 'bg-green-500/10 border-green-500/30 text-green-400'
                }`}
              >
                {validationMsg.text}
              </div>
            )}
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
              {addMode === 'yaml' && (
                <button
                  type="button"
                  onClick={() => handleValidate(form.config)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-sm text-slate-200 mr-auto"
                >
                  Validate YAML
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowAdd(false)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm text-slate-300"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-kathal-600 hover:bg-kathal-500 text-white rounded-lg text-sm font-medium"
              >
                Create Stack
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Inspect / Edit Modal */}
      {showEdit && selectedProject && (
        <div
          className="fixed inset-0 bg-black/75 backdrop-blur-xs flex items-center justify-center z-50 p-4"
          onClick={() => setShowEdit(false)}
        >
          <form
            onSubmit={handleUpdate}
            onClick={(e) => e.stopPropagation()}
            className="bg-[#111827] border border-slate-800 rounded-2xl p-6 max-w-2xl w-full space-y-4"
          >
            <div>
              <h3 className="text-xl font-bold text-slate-100">Inspect &amp; Edit: {selectedProject.name}</h3>
              <p className="text-xs text-slate-400 font-mono mt-0.5">
                {selectedProject.filePath || `${selectedProject.workingDir}/docker-compose.yml`}
              </p>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">docker-compose.yml</label>
              <textarea
                value={form.config}
                onChange={(e) => setForm({ ...form, config: e.target.value })}
                rows={15}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-xs font-mono text-slate-200 focus:border-kathal-500 focus:outline-none"
              />
            </div>
            {validationMsg && (
              <div
                className={`p-2.5 rounded-lg text-xs border ${
                  validationMsg.type === 'error'
                    ? 'bg-red-500/10 border-red-500/30 text-red-400'
                    : 'bg-green-500/10 border-green-500/30 text-green-400'
                }`}
              >
                {validationMsg.text}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => handleValidate(form.config)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-sm text-slate-200 mr-auto"
              >
                Validate YAML
              </button>
              <button
                type="button"
                onClick={() => setShowEdit(false)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm text-slate-300"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-kathal-600 hover:bg-kathal-500 text-white rounded-lg text-sm font-medium"
              >
                Save Changes
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}