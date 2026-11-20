import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  HardDrive,
  Plus,
  Trash2,
  RefreshCw,
  Search,
  Copy,
  Check,
  Database,
  CheckCircle2,
} from 'lucide-react'
import { apiFetch, apiPost, apiDelete } from '../hooks/useApi'

function formatBytes(bytes) {
  if (!bytes) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i]
}

function formatDate(iso) {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export default function Volumes() {
  const [volumes, setVolumes] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [usageFilter, setUsageFilter] = useState('all')
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState({ name: '', driver: 'local' })
  const [confirmPrune, setConfirmPrune] = useState(false)
  const [confirmDeleteName, setConfirmDeleteName] = useState(null)
  const [copiedMount, setCopiedMount] = useState(null)
  const [busyAction, setBusyAction] = useState(null)
  const [feedback, setFeedback] = useState(null)

  const loadVolumes = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiFetch('/volumes')
      setVolumes(Array.isArray(data) ? data : [])
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to load volumes' })
      setVolumes([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadVolumes()
  }, [loadVolumes])

  async function handleCreate(e) {
    e.preventDefault()
    setFeedback(null)
    setBusyAction('create')
    try {
      const vol = await apiPost('/volumes', form)
      setShowCreate(false)
      setForm({ name: '', driver: 'local' })
      setFeedback({ type: 'success', text: `Created volume "${vol.name}".` })
      loadVolumes()
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to create volume' })
    } finally {
      setBusyAction(null)
    }
  }

  async function handlePruneUnused() {
    setFeedback(null)
    setBusyAction('prune')
    try {
      const res = await apiPost('/volumes/prune', {})
      setConfirmPrune(false)
      const count = res.volumes_deleted ?? 0
      const reclaimed = formatBytes(res.space_reclaimed_bytes ?? 0)
      setFeedback({
        type: 'success',
        text:
          count > 0
            ? `Cleaned up ${count} unused volume(s) and reclaimed ${reclaimed}.`
            : 'No unused volumes to prune.',
      })
      loadVolumes()
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to prune volumes' })
    } finally {
      setBusyAction(null)
    }
  }

  async function handleDelete(name, force = false) {
    setFeedback(null)
    setBusyAction(`delete:${name}`)
    try {
      const query = force ? '?force=true' : ''
      await apiDelete(`/volumes/${encodeURIComponent(name)}${query}`)
      setConfirmDeleteName(null)
      setFeedback({ type: 'success', text: `Deleted volume "${name}".` })
      loadVolumes()
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to delete volume' })
    } finally {
      setBusyAction(null)
    }
  }

  async function copyMountpoint(path) {
    try {
      await navigator.clipboard.writeText(path)
      setCopiedMount(path)
      setTimeout(() => setCopiedMount(null), 1500)
    } catch {
      // clipboard unavailable
    }
  }

  const stats = useMemo(() => {
    const unused = volumes.filter((v) => !v.inUse)
    const inUse = volumes.length - unused.length
    const totalBytes = volumes.reduce((sum, v) => sum + (v.sizeBytes || 0), 0)
    const reclaimableBytes = unused.reduce((sum, v) => sum + (v.sizeBytes || 0), 0)
    return {
      total: volumes.length,
      inUse,
      unused: unused.length,
      totalBytes,
      reclaimableBytes,
    }
  }, [volumes])

  const filteredVolumes = useMemo(() => {
    const q = search.trim().toLowerCase()
    return volumes.filter((v) => {
      if (usageFilter === 'unused' && v.inUse) return false
      if (usageFilter === 'in_use' && !v.inUse) return false
      if (!q) return true
      return (
        v.name.toLowerCase().includes(q) ||
        (v.mountpoint || '').toLowerCase().includes(q) ||
        (v.driver || '').toLowerCase().includes(q)
      )
    })
  }, [volumes, search, usageFilter])

  return (
    <div className="p-6 sm:p-8 max-w-7xl mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-100">Storage Volumes</h1>
          <p className="text-slate-400 text-sm mt-1">
            Volumes keep your app data and databases safe even when apps restart or update.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {confirmPrune ? (
            <div className="inline-flex items-center gap-1.5 bg-[#111827] border border-red-500/40 rounded-lg px-2 py-1">
              <button
                onClick={handlePruneUnused}
                disabled={busyAction === 'prune'}
                className="px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded text-xs font-medium whitespace-nowrap"
              >
                {busyAction === 'prune'
                  ? 'Pruning...'
                  : `Confirm Prune (${stats.unused} · ${formatBytes(stats.reclaimableBytes)})`}
              </button>
              <button
                onClick={() => setConfirmPrune(false)}
                className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-xs"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmPrune(true)}
              disabled={stats.unused === 0 || busyAction === 'prune'}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-red-500/15 hover:bg-red-600 disabled:bg-[#111827] disabled:text-slate-600 disabled:border disabled:border-slate-800 text-red-400 hover:text-white rounded-lg text-sm font-medium whitespace-nowrap shrink-0 transition-colors"
            >
              <Trash2 className="w-4 h-4" />
              <span>Prune Unused Volumes ({stats.unused})</span>
            </button>
          )}
          <button
            onClick={() => setShowCreate(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-kathal-600 hover:bg-kathal-500 text-white rounded-lg text-sm font-medium whitespace-nowrap shrink-0 transition-colors"
          >
            <Plus className="w-4 h-4" />
            <span>Create Volume</span>
          </button>
        </div>
      </div>

      {/* Summary Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="bg-[#111827] border border-slate-800/90 rounded-xl p-5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-slate-400">Total Volumes</span>
            <HardDrive className="w-4 h-4 text-slate-500" />
          </div>
          <p className="text-2xl font-bold text-slate-100 tabular-nums">{stats.total}</p>
        </div>
        <div className="bg-[#111827] border border-slate-800/90 rounded-xl p-5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-slate-400">Total Storage</span>
            <Database className="w-4 h-4 text-slate-500" />
          </div>
          <p className="text-2xl font-bold text-slate-100 tabular-nums">
            {formatBytes(stats.totalBytes)}
          </p>
        </div>
        <div className="bg-[#111827] border border-slate-800/90 rounded-xl p-5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-slate-400">Mounted / In Use</span>
            <CheckCircle2 className="w-4 h-4 text-green-500/70" />
          </div>
          <p className="text-2xl font-bold text-green-400 tabular-nums">{stats.inUse}</p>
        </div>
        <div className="bg-[#111827] border border-slate-800/90 rounded-xl p-5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-slate-400">Reclaimable</span>
            <Trash2 className="w-4 h-4 text-amber-400/70" />
          </div>
          <p className="text-2xl font-bold text-amber-400 tabular-nums">
            {formatBytes(stats.reclaimableBytes)}
          </p>
        </div>
      </div>

      {/* Filter & Search Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <select
            aria-label="Filter volumes by usage"
            value={usageFilter}
            onChange={(e) => setUsageFilter(e.target.value)}
            className="px-3 py-2 bg-[#111827] border border-slate-800 rounded-lg text-sm text-slate-200 focus:border-kathal-500 focus:outline-none"
          >
            <option value="all">All Volumes ({stats.total})</option>
            <option value="unused">Unused ({stats.unused})</option>
            <option value="in_use">In Use ({stats.inUse})</option>
          </select>
          <button
            onClick={loadVolumes}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-[#111827] hover:bg-slate-800 border border-slate-800 rounded-lg text-sm text-slate-300 disabled:opacity-50 whitespace-nowrap shrink-0 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
        </div>

        <div className="relative w-full sm:w-72">
          <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search volumes by name or path..."
            className="w-full pl-9 pr-3 py-2 bg-[#111827] border border-slate-800 rounded-lg text-sm text-slate-200 placeholder:text-slate-500 focus:border-kathal-500 focus:outline-none"
          />
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

      {loading ? (
        <div className="bg-[#111827] border border-slate-800/90 rounded-xl p-12 text-center text-slate-400 text-sm">
          Loading persistent storage volumes...
        </div>
      ) : filteredVolumes.length === 0 ? (
        <div className="bg-[#111827] border border-slate-800/90 rounded-xl p-12 text-center space-y-2">
          <HardDrive className="w-10 h-10 text-slate-600 mx-auto" />
          <h2 className="text-lg font-semibold text-slate-200">
            {volumes.length === 0 ? 'No Storage Volumes Found' : 'No Volumes Match Filter'}
          </h2>
          <p className="text-sm text-slate-400 max-w-md mx-auto">
            {volumes.length === 0
              ? 'Create a persistent volume or launch a database to store data safely.'
              : 'Try adjusting your search or usage filter.'}
          </p>
        </div>
      ) : (
        <div className="bg-[#111827] border border-slate-800/90 rounded-xl overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead className="bg-slate-900/70 border-b border-slate-800">
              <tr>
                <th className="py-3 px-4 text-xs font-medium uppercase tracking-wider text-slate-400">
                  Volume
                </th>
                <th className="py-3 px-4 text-xs font-medium uppercase tracking-wider text-slate-400">
                  Mount Point
                </th>
                <th className="py-3 px-4 text-xs font-medium uppercase tracking-wider text-slate-400">
                  Driver / Scope
                </th>
                <th className="py-3 px-4 text-xs font-medium uppercase tracking-wider text-slate-400">
                  Usage
                </th>
                <th className="py-3 px-4 text-xs font-medium uppercase tracking-wider text-slate-400 text-right">
                  Size
                </th>
                <th className="py-3 px-4 text-xs font-medium uppercase tracking-wider text-slate-400 text-right">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {filteredVolumes.map((v) => {
                const isDeleting = busyAction === `delete:${v.name}`
                const isCopied = copiedMount === v.mountpoint
                return (
                  <tr key={v.name} className="hover:bg-slate-800/30 transition-colors">
                    <td className="py-3.5 px-4">
                      <div className="font-semibold text-slate-100 font-mono text-sm">{v.name}</div>
                      <div className="text-xs text-slate-500 mt-0.5 tabular-nums">
                        Created {formatDate(v.createdAt)}
                      </div>
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="flex items-center gap-2">
                        <code className="text-xs font-mono text-slate-300 bg-slate-900 border border-slate-800 px-2 py-1 rounded">
                          {v.mountpoint}
                        </code>
                        <button
                          type="button"
                          onClick={() => copyMountpoint(v.mountpoint)}
                          className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-100 whitespace-nowrap"
                          title="Copy mount point"
                        >
                          {isCopied ? (
                            <>
                              <Check className="w-3.5 h-3.5 text-green-400" />
                              <span className="text-green-400">Copied</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-3.5 h-3.5" />
                              <span>Copy</span>
                            </>
                          )}
                        </button>
                      </div>
                    </td>
                    <td className="py-3.5 px-4 text-xs text-slate-300 whitespace-nowrap">
                      <span className="font-medium text-slate-200">{v.driver || 'local'}</span>
                      <span className="text-slate-600 mx-1">·</span>
                      <span className="text-slate-400">{v.scope || 'local'}</span>
                    </td>
                    <td className="py-3.5 px-4">
                      {v.inUse ? (
                        <div>
                          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-green-400">
                            <span className="w-2 h-2 rounded-full bg-green-500" aria-hidden="true" />
                            <span>In Use</span>
                          </span>
                          {v.containers?.length > 0 && (
                            <p className="text-xs text-slate-500 font-mono mt-0.5">
                              {v.containers.join(', ')}
                            </p>
                          )}
                        </div>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-400">
                          <span className="w-2 h-2 rounded-full bg-amber-400" aria-hidden="true" />
                          <span>Unused</span>
                        </span>
                      )}
                    </td>
                    <td className="py-3.5 px-4 text-sm text-slate-200 tabular-nums text-right whitespace-nowrap">
                      {formatBytes(v.sizeBytes)}
                    </td>
                    <td className="py-3.5 px-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center justify-end gap-1.5">
                        {confirmDeleteName === v.name ? (
                          <>
                            <button
                              onClick={() => handleDelete(v.name, Boolean(v.inUse))}
                              disabled={isDeleting}
                              className="px-2.5 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded-md text-xs font-medium disabled:opacity-50"
                            >
                              {isDeleting
                                ? 'Deleting...'
                                : v.inUse
                                ? 'Force Delete'
                                : 'Confirm'}
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
                            onClick={() => setConfirmDeleteName(v.name)}
                            disabled={isDeleting}
                            aria-label={`Delete volume ${v.name}`}
                            className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
                              v.inUse
                                ? 'bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-red-300'
                                : 'bg-red-500/15 hover:bg-red-600 text-red-400 hover:text-white'
                            }`}
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

      {/* Create Volume Modal */}
      {showCreate && (
        <div
          className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          onClick={() => setShowCreate(false)}
        >
          <form
            onSubmit={handleCreate}
            onClick={(e) => e.stopPropagation()}
            className="bg-[#111827] border border-slate-800 rounded-2xl p-6 max-w-md w-full space-y-4 shadow-2xl"
          >
            <div>
              <h3 className="text-xl font-bold text-slate-100">Create Storage Volume</h3>
              <p className="text-xs text-slate-400 mt-1">
                Create a persistent folder that can be attached to databases or apps.
              </p>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Volume Name</label>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="app-uploads (or leave blank to auto-name)"
                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-kathal-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Storage Driver</label>
              <select
                value={form.driver}
                onChange={(e) => setForm({ ...form, driver: e.target.value })}
                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-kathal-500 focus:outline-none"
              >
                <option value="local">Local Server Disk (recommended)</option>
                <option value="nfs">Network Share (NFS)</option>
                <option value="tmpfs">Temporary RAM Disk (tmpfs)</option>
              </select>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm text-slate-300"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busyAction === 'create'}
                className="px-4 py-2 bg-kathal-600 hover:bg-kathal-500 text-white rounded-lg text-sm font-medium disabled:opacity-50"
              >
                {busyAction === 'create' ? 'Creating...' : 'Create Volume'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
