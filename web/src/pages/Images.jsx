import { useState, useEffect, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import {
  Package,
  Download,
  Search,
  X,
  Trash2,
  Rocket,
  KeyRound,
  RotateCcw,
} from 'lucide-react'
import { useApi, apiFetch, apiPost, apiDelete } from '../hooks/useApi'

const QUICK_IMAGE_SUGGESTIONS = [
  { label: 'Nginx Web', image: 'nginx:alpine' },
  { label: 'PostgreSQL 16', image: 'postgres:16-alpine' },
  { label: 'Redis 7', image: 'redis:7-alpine' },
  { label: 'Node.js 20', image: 'node:20-alpine' },
]

function formatBytes(bytes) {
  if (!bytes) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i]
}

function formatCreatedDate(epochSec) {
  if (!epochSec) return '—'
  const date = new Date(epochSec * 1000)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function splitTag(tag) {
  if (!tag || tag === '<none>:<none>') return { repo: '<none>', version: '<none>' }
  const lastColon = tag.lastIndexOf(':')
  const lastSlash = tag.lastIndexOf('/')
  if (lastColon > lastSlash) {
    return { repo: tag.slice(0, lastColon), version: tag.slice(lastColon + 1) }
  }
  return { repo: tag, version: 'latest' }
}

export default function Images() {
  const { data: status } = useApi('/status')
  const [images, setImages] = useState([])
  const [registries, setRegistries] = useState([])
  const [selectedRegistryId, setSelectedRegistryId] = useState('')
  const [loading, setLoading] = useState(true)
  const [pullInput, setPullInput] = useState('')
  const [pulling, setPulling] = useState(false)
  const [search, setSearch] = useState('')
  const [repoTagFilter, setRepoTagFilter] = useState('all')
  const [usageFilter, setUsageFilter] = useState('all')
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [confirmPrune, setConfirmPrune] = useState(false)
  const [busyAction, setBusyAction] = useState(null)
  const [feedback, setFeedback] = useState(null)

  const loadImages = useCallback(async () => {
    setLoading(true)
    try {
      const [data, regData] = await Promise.all([
        apiFetch('/images'),
        apiFetch('/registries').catch(() => []),
      ])
      setImages(Array.isArray(data) ? data : (data?.images || []))
      setRegistries(Array.isArray(regData) ? regData : [])
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to load images' })
      setImages([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadImages()
  }, [loadImages])

  async function handlePull(e) {
    e.preventDefault()
    if (!pullInput.trim()) return
    setPulling(true)
    setFeedback(null)
    try {
      const img = await apiPost('/images/pull', {
        image: pullInput.trim(),
        registryId: selectedRegistryId || undefined,
      })
      setPullInput('')
      setFeedback({
        type: 'success',
        text: img.registry
          ? `Downloaded private image ${img.repoTags?.[0] || pullInput} via ${img.registry.name}.`
          : `Downloaded image ${img.repoTags?.[0] || pullInput}.`,
      })
      loadImages()
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err.message || 'Failed to pull image',
        showRegistriesLink: String(err.message || '').toLowerCase().includes('registries'),
      })
    } finally {
      setPulling(false)
    }
  }

  async function handleDeployImage(tag) {
    const baseName = tag.split('/')[0].split(':')[0] || 'app'
    setFeedback(null)
    setBusyAction(`deploy:${tag}`)
    try {
      const res = await apiPost('/deploy', {
        name: `${baseName}-${Math.floor(Math.random() * 900 + 100)}`,
        image: tag,
        autoDomain: true,
        source: 'images',
      })
      setFeedback({
        type: 'success',
        text: `Launched app "${res.container?.name}" from ${tag} on port ${res.app?.port}.`,
      })
      loadImages()
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Deploy failed' })
    } finally {
      setBusyAction(null)
    }
  }

  async function handleDelete(id, force = false) {
    setFeedback(null)
    setBusyAction(`delete:${id}`)
    try {
      const query = force ? '?force=true' : ''
      await apiDelete(`/images/${encodeURIComponent(id)}${query}`)
      setConfirmDeleteId(null)
      setFeedback({ type: 'success', text: 'Image deleted successfully.' })
      loadImages()
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to delete image' })
    } finally {
      setBusyAction(null)
    }
  }

  async function handlePruneUnused() {
    setFeedback(null)
    setBusyAction('prune')
    try {
      const res = await apiPost('/images/prune', {})
      setConfirmPrune(false)
      const count = res.images_deleted ?? 0
      const reclaimed = formatBytes(res.space_reclaimed_bytes ?? 0)
      setFeedback({
        type: 'success',
        text:
          count > 0
            ? `Deleted ${count} unused image(s) and reclaimed ${reclaimed}.`
            : 'No unused images to delete.',
      })
      loadImages()
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to prune unused images' })
    } finally {
      setBusyAction(null)
    }
  }

  const dockerAvailable = status?.dockerAvailable ?? true

  const stats = useMemo(() => {
    const unusedList = images.filter((img) => !img.inUse)
    const inUseCount = images.length - unusedList.length
    const reclaimableBytes = unusedList.reduce((sum, img) => sum + (img.size || 0), 0)
    const totalBytes = images.reduce((sum, img) => sum + (img.size || 0), 0)
    return {
      total: images.length,
      unused: unusedList.length,
      inUse: inUseCount,
      reclaimableBytes,
      totalBytes,
    }
  }, [images])

  const filterOptions = useMemo(() => {
    const repos = new Set()
    const tags = new Set()
    for (const img of images) {
      for (const fullTag of img.repoTags || []) {
        const { repo, version } = splitTag(fullTag)
        if (repo && repo !== '<none>') repos.add(repo)
        if (version && version !== '<none>') tags.add(version)
      }
    }
    return {
      repos: Array.from(repos).sort((a, b) => a.localeCompare(b)),
      tags: Array.from(tags).sort((a, b) => a.localeCompare(b)),
    }
  }, [images])

  const filteredImages = useMemo(() => {
    const q = search.trim().toLowerCase()
    return images.filter((img) => {
      if (usageFilter === 'unused' && img.inUse) return false
      if (usageFilter === 'in_use' && !img.inUse) return false

      const parsedTags = (img.repoTags || []).map((t) => splitTag(t))
      if (repoTagFilter !== 'all') {
        if (repoTagFilter.startsWith('repo:')) {
          const targetRepo = repoTagFilter.slice(5)
          if (!parsedTags.some((p) => p.repo === targetRepo)) return false
        } else if (repoTagFilter.startsWith('tag:')) {
          const targetTag = repoTagFilter.slice(4)
          if (!parsedTags.some((p) => p.version === targetTag)) return false
        }
      }

      if (!q) return true
      const fullTagsStr = (img.repoTags || []).join(' ').toLowerCase()
      return fullTagsStr.includes(q) || (img.id || '').toLowerCase().includes(q)
    })
  }, [images, search, repoTagFilter, usageFilter])

  const hasActiveFilters = Boolean(search.trim()) || repoTagFilter !== 'all' || usageFilter !== 'all'

  return (
    <div className="p-6 sm:p-8 max-w-7xl mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-100">App Images</h1>
          <p className="text-slate-400 text-sm mt-1">
            {dockerAvailable
              ? `${stats.total} downloaded images · ${formatBytes(stats.totalBytes)} total · ${stats.unused} unused (${formatBytes(stats.reclaimableBytes)} can be freed)`
              : 'Docker not available'}
          </p>
        </div>

        <Link
          to="/registries"
          className="inline-flex items-center gap-2 px-3.5 py-2 bg-[#101A10] hover:bg-slate-800 border border-slate-800 rounded-lg text-sm text-slate-200 whitespace-nowrap shrink-0 transition-colors"
        >
          <KeyRound className="w-4 h-4 text-slate-400" />
          <span>Manage Registries</span>
        </Link>
      </div>

      {/* Zero-Code Friendly Download Card */}
      <div className="bg-[#101A10] border border-slate-800/90 rounded-xl p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">Download an App Image</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Images are ready-made software packages. Pick a popular preset or enter any image name to pull it onto your server.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {QUICK_IMAGE_SUGGESTIONS.map((item) => (
              <button
                key={item.image}
                type="button"
                onClick={() => setPullInput(item.image)}
                className="px-2.5 py-1 rounded-md bg-slate-800/90 hover:bg-slate-700 border border-slate-700/80 text-xs text-slate-300 whitespace-nowrap shrink-0 transition-colors"
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <form onSubmit={handlePull} className="flex flex-wrap items-center gap-2.5">
          <select
            aria-label="Registry credential for pull"
            value={selectedRegistryId}
            onChange={(e) => setSelectedRegistryId(e.target.value)}
            className="px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-sm text-slate-200 focus:border-kathal-500 focus:outline-none min-w-[200px]"
          >
            <option value="">Public / Auto-detect Registry</option>
            {registries.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} ({r.registryUrl})
              </option>
            ))}
          </select>
          <input
            type="text"
            placeholder="e.g. node:20-alpine or ghcr.io/org/app:v1"
            value={pullInput}
            onChange={(e) => setPullInput(e.target.value)}
            className="flex-1 min-w-[240px] px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-sm text-slate-200 placeholder:text-slate-500 focus:border-kathal-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={pulling || !pullInput.trim()}
            className="inline-flex items-center gap-2 px-4 py-2 bg-kathal-600 hover:bg-kathal-500 text-white rounded-lg text-sm font-medium whitespace-nowrap shrink-0 disabled:opacity-50 transition-colors"
          >
            <Download className="w-4 h-4" />
            <span>{pulling ? 'Downloading...' : 'Pull Image'}</span>
          </button>
        </form>
      </div>

      {/* Search Bar, Filter Dropdowns & Bulk Prune Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5 flex-1 min-w-[280px]">
          <div className="relative flex-1 min-w-[220px] max-w-sm">
            <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              aria-label="Search images by repository name or tag"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name or tag (e.g. nginx, alpine)..."
              className="w-full pl-9 pr-8 py-2 bg-[#101A10] border border-slate-800 rounded-lg text-sm text-slate-200 placeholder:text-slate-500 focus:border-kathal-500 focus:outline-none"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                aria-label="Clear search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-200"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <select
            aria-label="Filter by repository or tag"
            value={repoTagFilter}
            onChange={(e) => setRepoTagFilter(e.target.value)}
            className="px-3 py-2 bg-[#101A10] border border-slate-800 rounded-lg text-sm text-slate-200 focus:border-kathal-500 focus:outline-none"
          >
            <option value="all">All Repositories &amp; Tags ({stats.total})</option>
            {filterOptions.repos.length > 0 && (
              <optgroup label="Filter by Repository">
                {filterOptions.repos.map((repo) => (
                  <option key={`repo:${repo}`} value={`repo:${repo}`}>
                    Repo: {repo}
                  </option>
                ))}
              </optgroup>
            )}
            {filterOptions.tags.length > 0 && (
              <optgroup label="Filter by Tag">
                {filterOptions.tags.map((tag) => (
                  <option key={`tag:${tag}`} value={`tag:${tag}`}>
                    Tag: :{tag}
                  </option>
                ))}
              </optgroup>
            )}
          </select>

          <select
            aria-label="Filter by usage status"
            value={usageFilter}
            onChange={(e) => setUsageFilter(e.target.value)}
            className="px-3 py-2 bg-[#101A10] border border-slate-800 rounded-lg text-sm text-slate-200 focus:border-kathal-500 focus:outline-none"
          >
            <option value="all">All Statuses ({stats.total})</option>
            <option value="unused">Unused ({stats.unused})</option>
            <option value="in_use">In Use ({stats.inUse})</option>
          </select>

          {hasActiveFilters && (
            <button
              type="button"
              onClick={() => {
                setSearch('')
                setRepoTagFilter('all')
                setUsageFilter('all')
              }}
              className="inline-flex items-center gap-1 px-2.5 py-2 text-xs text-slate-400 hover:text-slate-200 whitespace-nowrap shrink-0"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Reset</span>
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {confirmPrune ? (
            <div className="inline-flex items-center gap-1.5 bg-[#101A10] border border-red-500/40 rounded-lg px-2 py-1">
              <button
                onClick={handlePruneUnused}
                disabled={busyAction === 'prune'}
                className="px-2.5 py-1 bg-red-600 hover:bg-red-500 text-white rounded text-xs font-medium whitespace-nowrap"
              >
                {busyAction === 'prune'
                  ? 'Cleaning...'
                  : `Confirm Delete (${stats.unused} · ${formatBytes(stats.reclaimableBytes)})`}
              </button>
              <button
                onClick={() => setConfirmPrune(false)}
                className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-xs whitespace-nowrap"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmPrune(true)}
              disabled={stats.unused === 0 || busyAction === 'prune'}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-red-500/15 hover:bg-red-600 disabled:bg-[#101A10] disabled:text-slate-600 disabled:border disabled:border-slate-800 text-red-400 hover:text-white rounded-lg text-sm font-medium whitespace-nowrap shrink-0 transition-colors"
            >
              <Trash2 className="w-4 h-4" />
              <span>Delete Unused Images ({stats.unused})</span>
            </button>
          )}
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
          <div className="flex items-center gap-2">
            {feedback.showRegistriesLink && (
              <Link
                to="/registries"
                className="text-xs px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 whitespace-nowrap"
              >
                Add Registry Credentials →
              </Link>
            )}
            {feedback.type === 'success' && (
              <Link
                to="/containers"
                className="text-xs px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 whitespace-nowrap"
              >
                Open Running Apps →
              </Link>
            )}
          </div>
        </div>
      )}

      {loading ? (
        <div className="bg-[#101A10] border border-slate-800/90 rounded-xl p-12 text-center text-slate-400 text-sm">
          Loading downloaded images...
        </div>
      ) : filteredImages.length === 0 ? (
        <div className="bg-[#101A10] border border-slate-800/90 rounded-xl p-12 text-center space-y-2">
          <Package className="w-10 h-10 text-slate-600 mx-auto" />
          <h2 className="text-lg font-semibold text-slate-200">
            {images.length === 0 ? 'No App Images Downloaded' : 'No Images Match Filter'}
          </h2>
          <p className="text-sm text-slate-400 max-w-md mx-auto">
            {images.length === 0
              ? 'Pick one of the presets above or pull a custom image to get started.'
              : 'Adjust your search query or filter dropdown selection.'}
          </p>
        </div>
      ) : (
        <div className="bg-[#101A10] border border-slate-800/90 rounded-xl overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead className="bg-slate-900/70 border-b border-slate-800">
              <tr>
                <th className="py-3 px-4 text-xs font-medium uppercase tracking-wider text-slate-400">
                  Image
                </th>
                <th className="py-3 px-4 text-xs font-medium uppercase tracking-wider text-slate-400">
                  Tags
                </th>
                <th className="py-3 px-4 text-xs font-medium uppercase tracking-wider text-slate-400">
                  Usage
                </th>
                <th className="py-3 px-4 text-xs font-medium uppercase tracking-wider text-slate-400 text-right">
                  Size
                </th>
                <th className="py-3 px-4 text-xs font-medium uppercase tracking-wider text-slate-400">
                  Created
                </th>
                <th className="py-3 px-4 text-xs font-medium uppercase tracking-wider text-slate-400 text-right">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {filteredImages.map((img) => {
                const primaryTag = img.repoTags?.[0] || '<none>:<none>'
                const { repo } = splitTag(primaryTag)
                const allTags = (img.repoTags || []).map((t) => splitTag(t).version)
                const containers = img.containers || []
                const isDeleting = busyAction === `delete:${img.id}`
                const isDeploying = busyAction === `deploy:${primaryTag}`

                return (
                  <tr key={img.id} className="hover:bg-slate-800/30 transition-colors">
                    <td className="py-3.5 px-4">
                      <div className="flex items-center gap-3">
                        <Package className="w-4 h-4 text-slate-500 shrink-0" />
                        <div>
                          <p className="font-semibold text-slate-100">{repo}</p>
                          <p className="text-xs text-slate-500 font-mono mt-0.5">{img.id.slice(0, 19)}</p>
                        </div>
                      </div>
                    </td>
                    <td className="py-3.5 px-4">
                      <span className="text-xs font-mono text-slate-200">
                        {(allTags.length > 0 ? allTags : ['latest']).join(', ')}
                      </span>
                    </td>
                    <td className="py-3.5 px-4">
                      {img.inUse ? (
                        <div>
                          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-green-400">
                            <span className="w-2 h-2 rounded-full bg-green-500" aria-hidden="true" />
                            <span>In Use</span>
                          </span>
                          {containers.length > 0 && (
                            <p className="text-xs text-slate-500 font-mono mt-0.5">
                              {containers.join(', ')}
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
                    <td className="py-3.5 px-4 text-sm text-slate-300 tabular-nums text-right whitespace-nowrap">
                      {formatBytes(img.size)}
                    </td>
                    <td className="py-3.5 px-4 text-sm text-slate-400 tabular-nums whitespace-nowrap">
                      {formatCreatedDate(img.created)}
                    </td>
                    <td className="py-3.5 px-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => handleDeployImage(primaryTag)}
                          disabled={isDeploying}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-kathal-600/20 hover:bg-kathal-600 text-kathal-300 hover:text-white rounded-md text-xs font-medium transition-colors disabled:opacity-50"
                        >
                          <Rocket className="w-3 h-3" />
                          <span>{isDeploying ? 'Launching...' : 'Launch App'}</span>
                        </button>
                        {confirmDeleteId === img.id ? (
                          <>
                            <button
                              onClick={() => handleDelete(img.id, Boolean(img.inUse))}
                              disabled={isDeleting}
                              className="px-2.5 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded-md text-xs font-medium disabled:opacity-50"
                            >
                              {isDeleting
                                ? 'Deleting...'
                                : img.inUse
                                ? 'Force Delete'
                                : 'Confirm'}
                            </button>
                            <button
                              onClick={() => setConfirmDeleteId(null)}
                              className="px-2 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-md text-xs"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => setConfirmDeleteId(img.id)}
                            disabled={isDeleting}
                            aria-label={`Delete ${primaryTag}`}
                            className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
                              img.inUse
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
    </div>
  )
}
