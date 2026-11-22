import { useState, useEffect, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import {
  KeyRound,
  Plus,
  Download,
  Search,
  CheckCircle2,
  Pencil,
  Trash2,
  ShieldCheck,
} from 'lucide-react'
import { apiFetch, apiPost, apiPut, apiDelete } from '../hooks/useApi'

const REGISTRY_PRESETS = [
  { label: 'Docker Hub', url: 'docker.io', name: 'Docker Hub' },
  { label: 'GitHub GHCR', url: 'ghcr.io', name: 'GitHub Container Registry' },
  { label: 'GitLab Registry', url: 'registry.gitlab.com', name: 'GitLab Container Registry' },
  { label: 'AWS ECR', url: '123456789012.dkr.ecr.us-east-1.amazonaws.com', name: 'AWS ECR' },
  { label: 'Google Artifact', url: 'us-docker.pkg.dev', name: 'Google Artifact Registry' },
  { label: 'Custom', url: '', name: '' },
]

function formatTimestamp(iso) {
  if (!iso) return 'Never'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'Never'
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function Registries() {
  const [registries, setRegistries] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [showModal, setShowModal] = useState(false)
  const [editingReg, setEditingReg] = useState(null)
  const [form, setForm] = useState({
    name: '',
    registryUrl: '',
    username: '',
    password: '',
    email: '',
  })
  const [pullForm, setPullForm] = useState({ registryId: '', image: '' })
  const [pulling, setPulling] = useState(false)
  const [busyId, setBusyId] = useState(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [feedback, setFeedback] = useState(null)

  const loadRegistries = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiFetch('/registries')
      const list = Array.isArray(data) ? data : []
      setRegistries(list)
      setPullForm((prev) => ({
        ...prev,
        registryId: prev.registryId || list[0]?.id || '',
      }))
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to load registries' })
      setRegistries([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadRegistries()
  }, [loadRegistries])

  function openAddModal() {
    setEditingReg(null)
    setForm({ name: 'GitHub Container Registry', registryUrl: 'ghcr.io', username: '', password: '', email: '' })
    setShowModal(true)
  }

  function openEditModal(reg) {
    setEditingReg(reg)
    setForm({
      name: reg.name,
      registryUrl: reg.registryUrl,
      username: reg.username,
      password: '',
      email: reg.email || '',
    })
    setShowModal(true)
  }

  async function handleSave(e) {
    e.preventDefault()
    setFeedback(null)
    setBusyId('save')
    try {
      if (editingReg) {
        await apiPut(`/registries/${encodeURIComponent(editingReg.id)}`, form)
        setFeedback({ type: 'success', text: `Updated registry "${form.name}".` })
      } else {
        await apiPost('/registries', form)
        setFeedback({ type: 'success', text: `Added registry credentials for "${form.registryUrl}".` })
      }
      setShowModal(false)
      loadRegistries()
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to save registry credentials' })
    } finally {
      setBusyId(null)
    }
  }

  async function handleTest(reg) {
    setFeedback(null)
    setBusyId(`test:${reg.id}`)
    try {
      const res = await apiPost(`/registries/${encodeURIComponent(reg.id)}/test`, {})
      setFeedback({ type: 'success', text: res.message || `Verified credentials for ${reg.registryUrl}.` })
      loadRegistries()
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Registry login verification failed' })
    } finally {
      setBusyId(null)
    }
  }

  async function handleDelete(id) {
    setFeedback(null)
    setBusyId(`delete:${id}`)
    try {
      await apiDelete(`/registries/${encodeURIComponent(id)}`)
      setConfirmDeleteId(null)
      setFeedback({ type: 'success', text: 'Registry credential removed.' })
      loadRegistries()
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to remove registry' })
    } finally {
      setBusyId(null)
    }
  }

  async function handlePullPrivate(e) {
    e.preventDefault()
    if (!pullForm.image.trim()) return
    setPulling(true)
    setFeedback(null)
    try {
      const img = await apiPost('/images/pull', {
        image: pullForm.image.trim(),
        registryId: pullForm.registryId || undefined,
      })
      setPullForm((prev) => ({ ...prev, image: '' }))
      setFeedback({
        type: 'success',
        text: `Pulled private image ${img.repoTags?.[0] || pullForm.image} using ${
          img.registry?.name || 'saved registry credentials'
        }.`,
      })
      loadRegistries()
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Private image pull failed' })
    } finally {
      setPulling(false)
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return registries
    return registries.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.registryUrl.toLowerCase().includes(q) ||
        r.username.toLowerCase().includes(q)
    )
  }, [registries, search])

  return (
    <div className="p-6 sm:p-8 max-w-7xl mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-100">Private Registries</h1>
          <p className="text-slate-400 text-sm mt-1">
            Connect private accounts like GitHub or Docker Hub so you can pull private apps without command-line logins.
          </p>
        </div>
        <button
          onClick={openAddModal}
          className="inline-flex items-center gap-2 px-4 py-2 bg-kathal-600 hover:bg-kathal-500 text-white rounded-lg text-sm font-medium whitespace-nowrap shrink-0 transition-colors"
        >
          <Plus className="w-4 h-4" />
          <span>Add Registry</span>
        </button>
      </div>

      {/* Quick Private Image Pull Bar */}
      <form
        onSubmit={handlePullPrivate}
        className="bg-[#101A10] border border-slate-800/90 rounded-xl p-5 flex flex-wrap items-end gap-3"
      >
        <div className="min-w-[200px] flex-1 max-w-xs">
          <label className="block text-xs text-slate-400 mb-1.5">Authenticate With Registry</label>
          <select
            value={pullForm.registryId}
            onChange={(e) => setPullForm({ ...pullForm, registryId: e.target.value })}
            disabled={registries.length === 0}
            className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-sm text-slate-200 focus:border-kathal-500 focus:outline-none"
          >
            {registries.length === 0 ? (
              <option value="">No registries configured</option>
            ) : (
              registries.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.registryUrl})
                </option>
              ))
            )}
          </select>
        </div>
        <div className="flex-1 min-w-[240px]">
          <label className="block text-xs text-slate-400 mb-1.5">Private Image Reference</label>
          <input
            type="text"
            value={pullForm.image}
            onChange={(e) => setPullForm({ ...pullForm, image: e.target.value })}
            placeholder="e.g. my-org/private-api:v1.2.0 or ghcr.io/acme/worker:latest"
            className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-sm text-slate-200 placeholder:text-slate-500 focus:border-kathal-500 focus:outline-none"
          />
        </div>
        <button
          type="submit"
          disabled={pulling || !pullForm.image.trim() || registries.length === 0}
          className="inline-flex items-center gap-2 px-4 py-2 bg-kathal-600 hover:bg-kathal-500 text-white rounded-lg text-sm font-medium whitespace-nowrap shrink-0 disabled:opacity-50 transition-colors"
        >
          <Download className="w-4 h-4" />
          <span>{pulling ? 'Downloading...' : 'Pull Private Image'}</span>
        </button>
      </form>

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
            <Link
              to="/images"
              className="text-xs px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 whitespace-nowrap"
            >
              View Images →
            </Link>
          )}
        </div>
      )}

      {/* Search */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-400 tabular-nums">
          {registries.length} configured {registries.length === 1 ? 'registry' : 'registries'}
        </p>
        <div className="relative w-full sm:w-72">
          <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, host, or user..."
            className="w-full pl-9 pr-3 py-2 bg-[#101A10] border border-slate-800 rounded-lg text-sm text-slate-200 placeholder:text-slate-500 focus:border-kathal-500 focus:outline-none"
          />
        </div>
      </div>

      {loading ? (
        <div className="bg-[#101A10] border border-slate-800/90 rounded-xl p-12 text-center text-slate-400 text-sm">
          Loading Docker registries...
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-[#101A10] border border-slate-800/90 rounded-xl p-12 text-center space-y-3">
          <KeyRound className="w-10 h-10 text-slate-600 mx-auto" />
          <h2 className="text-lg font-semibold text-slate-200">
            {registries.length === 0 ? 'No Registries Connected' : 'No Matching Registries'}
          </h2>
          <p className="text-sm text-slate-400 max-w-md mx-auto">
            {registries.length === 0
              ? 'Save credentials for Docker Hub, GitHub Packages, GitLab, AWS ECR, or a private company registry.'
              : 'Clear your search query to see all configured registries.'}
          </p>
          {registries.length === 0 && (
            <button
              onClick={openAddModal}
              className="inline-flex items-center gap-2 px-4 py-2 bg-kathal-600 hover:bg-kathal-500 text-white rounded-lg text-sm font-medium"
            >
              <Plus className="w-4 h-4" />
              <span>Add Registry</span>
            </button>
          )}
        </div>
      ) : (
        <div className="bg-[#101A10] border border-slate-800/90 rounded-xl overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead className="bg-slate-900/70 border-b border-slate-800">
              <tr>
                <th className="py-3 px-4 text-xs font-medium uppercase tracking-wider text-slate-400">
                  Registry
                </th>
                <th className="py-3 px-4 text-xs font-medium uppercase tracking-wider text-slate-400">
                  Credentials
                </th>
                <th className="py-3 px-4 text-xs font-medium uppercase tracking-wider text-slate-400">
                  Status
                </th>
                <th className="py-3 px-4 text-xs font-medium uppercase tracking-wider text-slate-400">
                  Last Used
                </th>
                <th className="py-3 px-4 text-xs font-medium uppercase tracking-wider text-slate-400 text-right">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {filtered.map((reg) => {
                const isTesting = busyId === `test:${reg.id}`
                const isDeleting = busyId === `delete:${reg.id}`
                return (
                  <tr key={reg.id} className="hover:bg-slate-800/30 transition-colors">
                    <td className="py-3.5 px-4">
                      <div className="flex items-center gap-3">
                        <KeyRound className="w-4 h-4 text-slate-500 shrink-0" />
                        <div>
                          <div className="font-semibold text-slate-100">{reg.name}</div>
                          <div className="text-xs text-kathal-400 font-mono mt-0.5">{reg.registryUrl}</div>
                        </div>
                      </div>
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="text-sm text-slate-200 font-mono">{reg.username}</div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        Token: {reg.passwordMasked || '••••••••'}
                        {reg.email ? ` · ${reg.email}` : ''}
                      </div>
                    </td>
                    <td className="py-3.5 px-4 whitespace-nowrap">
                      <span
                        className={`inline-flex items-center gap-1.5 text-xs font-medium ${
                          reg.status === 'connected' ? 'text-green-400' : 'text-amber-400'
                        }`}
                      >
                        <span
                          className={`w-2 h-2 rounded-full ${
                            reg.status === 'connected' ? 'bg-green-500' : 'bg-amber-400'
                          }`}
                          aria-hidden="true"
                        />
                        {reg.status === 'connected' ? 'Connected' : 'Unverified'}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 text-xs text-slate-400 tabular-nums whitespace-nowrap">
                      {formatTimestamp(reg.lastUsedAt)}
                    </td>
                    <td className="py-3.5 px-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => handleTest(reg)}
                          disabled={isTesting}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 rounded-md text-xs font-medium transition-colors disabled:opacity-50"
                        >
                          {reg.status === 'connected' ? (
                            <CheckCircle2 className="w-3 h-3 text-green-400" />
                          ) : (
                            <ShieldCheck className="w-3 h-3" />
                          )}
                          <span>{isTesting ? 'Verifying...' : 'Test Auth'}</span>
                        </button>
                        <button
                          onClick={() => openEditModal(reg)}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 rounded-md text-xs font-medium transition-colors"
                        >
                          <Pencil className="w-3 h-3" />
                          <span>Edit</span>
                        </button>
                        {confirmDeleteId === reg.id ? (
                          <>
                            <button
                              onClick={() => handleDelete(reg.id)}
                              disabled={isDeleting}
                              className="px-2.5 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded-md text-xs font-medium"
                            >
                              Confirm
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
                            onClick={() => setConfirmDeleteId(reg.id)}
                            aria-label={`Delete ${reg.name}`}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-red-500/15 hover:bg-red-600 text-red-400 hover:text-white rounded-md text-xs font-medium transition-colors"
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

      {/* Add / Edit Registry Modal */}
      {showModal && (
        <div
          className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          onClick={() => setShowModal(false)}
        >
          <form
            onSubmit={handleSave}
            onClick={(e) => e.stopPropagation()}
            className="bg-[#101A10] border border-slate-800 rounded-2xl p-6 max-w-lg w-full space-y-4 shadow-2xl"
          >
            <div>
              <h3 className="text-xl font-bold text-slate-100">
                {editingReg ? `Edit Registry: ${editingReg.name}` : 'Connect Docker Registry'}
              </h3>
              <p className="text-xs text-slate-400 mt-1">
                Credentials are stored safely on your server for automated private pulls.
              </p>
            </div>

            {!editingReg && (
              <div>
                <label className="block text-xs text-slate-400 mb-1.5">Provider Preset</label>
                <div className="flex flex-wrap gap-1.5">
                  {REGISTRY_PRESETS.map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() =>
                        setForm((prev) => ({
                          ...prev,
                          registryUrl: preset.url,
                          name: preset.name || prev.name,
                        }))
                      }
                      className={`px-2.5 py-1.5 rounded-md text-xs border whitespace-nowrap transition-colors ${
                        form.registryUrl === preset.url && preset.url
                          ? 'bg-kathal-600/20 border-kathal-500 text-kathal-300'
                          : 'bg-slate-800/80 border-slate-700 text-slate-300 hover:bg-slate-700'
                      }`}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">Display Name</label>
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Production GHCR"
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-kathal-500 focus:outline-none"
                  required
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Registry Host / URL</label>
                <input
                  value={form.registryUrl}
                  onChange={(e) => setForm({ ...form, registryUrl: e.target.value })}
                  placeholder="ghcr.io"
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm font-mono text-slate-100 focus:border-kathal-500 focus:outline-none"
                  required
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">Username</label>
                <input
                  value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                  placeholder="octocat"
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-kathal-500 focus:outline-none"
                  required
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">
                  {editingReg ? 'New Password / Token (optional)' : 'Password / Access Token'}
                </label>
                <input
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  placeholder={editingReg ? 'Leave blank to keep existing' : 'ghp_... or token'}
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-kathal-500 focus:outline-none"
                  required={!editingReg}
                />
              </div>
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1">Email (optional)</label>
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="devops@company.com"
                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-kathal-500 focus:outline-none"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowModal(false)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm text-slate-300"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busyId === 'save'}
                className="px-4 py-2 bg-kathal-600 hover:bg-kathal-500 text-white rounded-lg text-sm font-medium disabled:opacity-50"
              >
                {busyId === 'save' ? 'Saving...' : editingReg ? 'Save Changes' : 'Add Registry'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
