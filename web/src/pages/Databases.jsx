import { useState, useEffect, useCallback } from 'react'
import { Database, Plus, Link2, Play, Square, Trash2, Copy, Check } from 'lucide-react'
import { apiFetch, apiPost, apiDelete } from '../hooks/useApi'

const DB_TYPES = [
  { value: 'postgres', label: 'PostgreSQL', desc: 'Relational SQL' },
  { value: 'mysql', label: 'MySQL', desc: 'Web SQL Engine' },
  { value: 'mongodb', label: 'MongoDB', desc: 'Document Store' },
  { value: 'redis', label: 'Redis', desc: 'In-Memory Cache' },
]

export default function Databases() {
  const [databases, setDatabases] = useState([])
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ name: '', type: 'postgres', password: '' })
  const [loading, setLoading] = useState(true)
  const [connStr, setConnStr] = useState(null)
  const [copied, setCopied] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [feedback, setFeedback] = useState(null)

  const loadDatabases = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiFetch('/databases')
      setDatabases(Array.isArray(data) ? data : [])
    } catch {
      setDatabases([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadDatabases()
  }, [loadDatabases])

  async function handleCreate(e) {
    e.preventDefault()
    setFeedback(null)
    try {
      await apiPost('/databases', form)
      setShowForm(false)
      setForm({ name: '', type: 'postgres', password: '' })
      setFeedback({ type: 'success', text: `Database "${form.name}" created and started.` })
      loadDatabases()
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to create database' })
    }
  }

  async function handleDelete(id) {
    setFeedback(null)
    try {
      await apiDelete(`/databases/${id}`)
      setConfirmDeleteId(null)
      setFeedback({ type: 'success', text: 'Database deleted.' })
      loadDatabases()
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to delete database' })
    }
  }

  async function handleConnection(id) {
    setFeedback(null)
    try {
      const data = await apiFetch(`/databases/${id}/connection`)
      setConnStr(data.connection_string)
      setCopied(false)
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to fetch connection string' })
    }
  }

  async function handleStart(id) {
    await apiPost(`/databases/${id}/start`, {})
    loadDatabases()
  }

  async function handleStop(id) {
    await apiPost(`/databases/${id}/stop`, {})
    loadDatabases()
  }

  return (
    <div className="p-6 sm:p-8 max-w-7xl mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-100">Managed Databases</h1>
          <p className="text-slate-400 text-sm mt-1">
            Launch PostgreSQL, MySQL, MongoDB, or Redis with automatic credentials in seconds.
          </p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="inline-flex items-center gap-2 bg-kathal-600 hover:bg-kathal-500 text-white px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap shrink-0 transition-colors"
        >
          <Plus className="w-4 h-4" />
          <span>Create Database</span>
        </button>
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

      {showForm && (
        <form onSubmit={handleCreate} className="bg-[#101A10] border border-slate-800/90 rounded-xl p-6 space-y-4">
          <div>
            <h2 className="text-base font-semibold text-slate-100">New Managed Database</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Leave password blank to generate a strong password automatically.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Database Name</label>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="app-production-db"
                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3.5 py-2 text-sm text-slate-100 focus:border-kathal-500 focus:outline-none"
                required
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Engine Type</label>
              <select
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value })}
                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3.5 py-2 text-sm text-slate-100 focus:border-kathal-500 focus:outline-none"
              >
                {DB_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label} ({t.desc})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Password (optional)</label>
              <input
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                placeholder="Auto-generated if blank"
                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3.5 py-2 text-sm text-slate-100 focus:border-kathal-500 focus:outline-none"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <button type="submit" className="bg-kathal-600 hover:bg-kathal-500 text-white px-4 py-2 rounded-lg text-sm font-medium">
              Create &amp; Start
            </button>
            <button type="button" onClick={() => setShowForm(false)} className="bg-slate-800 hover:bg-slate-700 px-4 py-2 rounded-lg text-sm text-slate-300">
              Cancel
            </button>
          </div>
        </form>
      )}

      {connStr && (
        <div className="bg-[#101A10] border border-kathal-500/40 rounded-xl p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs font-medium text-slate-400 mb-1">Database Connection String (URI)</p>
              <code className="text-sm text-kathal-400 font-mono break-all">{connStr}</code>
            </div>
            <button
              onClick={() => {
                navigator.clipboard?.writeText(connStr)
                setCopied(true)
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-xs text-slate-200 shrink-0"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="bg-[#101A10] border border-slate-800/90 rounded-xl p-12 text-center text-slate-400 text-sm">
          Loading managed databases...
        </div>
      ) : databases.length === 0 ? (
        <div className="bg-[#101A10] border border-slate-800/90 rounded-xl p-12 text-center space-y-2">
          <Database className="w-10 h-10 text-slate-600 mx-auto" />
          <p className="text-slate-200 text-lg font-semibold">No databases running</p>
          <p className="text-slate-400 text-sm">Create a database above to get a ready-to-use connection URL.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {databases.map((db) => {
            const typeInfo = DB_TYPES.find((t) => t.value === db.type) || DB_TYPES[0]
            const running = db.status === 'running'
            return (
              <div key={db.id} className="bg-[#101A10] border border-slate-800/90 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3.5">
                  <div className="w-9 h-9 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center text-kathal-400 shrink-0">
                    <Database className="w-4 h-4" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="font-semibold text-slate-100">{db.name}</p>
                      <span
                        className={`inline-flex items-center gap-1.5 text-xs font-medium ${
                          running ? 'text-green-400' : 'text-slate-400'
                        }`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${running ? 'bg-green-500' : 'bg-slate-500'}`} />
                        <span className="capitalize">{db.status}</span>
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 tabular-nums mt-0.5">
                      {typeInfo.label} · Port {db.port} · User <span className="font-mono">{db.user}</span>
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => handleConnection(db.id)}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-md text-xs text-slate-200 whitespace-nowrap"
                    title="View connection string"
                  >
                    <Link2 className="w-3 h-3" />
                    <span>Connection URI</span>
                  </button>
                  {running ? (
                    <button
                      onClick={() => handleStop(db.id)}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-amber-500/15 hover:bg-amber-600 text-amber-400 hover:text-white rounded-md text-xs font-medium whitespace-nowrap transition-colors"
                    >
                      <Square className="w-3 h-3" />
                      <span>Stop</span>
                    </button>
                  ) : (
                    <button
                      onClick={() => handleStart(db.id)}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-green-600 hover:bg-green-500 text-white rounded-md text-xs font-medium whitespace-nowrap transition-colors"
                    >
                      <Play className="w-3 h-3" />
                      <span>Start</span>
                    </button>
                  )}
                  {confirmDeleteId === db.id ? (
                    <>
                      <button
                        onClick={() => handleDelete(db.id)}
                        className="px-2.5 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded-md text-xs font-medium"
                      >
                        Confirm
                      </button>
                      <button
                        onClick={() => setConfirmDeleteId(null)}
                        className="px-2 py-1.5 bg-slate-800 text-slate-300 rounded-md text-xs"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => setConfirmDeleteId(db.id)}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-red-500/15 hover:bg-red-600 text-red-400 hover:text-white rounded-md text-xs font-medium whitespace-nowrap transition-colors"
                    >
                      <Trash2 className="w-3 h-3" />
                      <span>Delete</span>
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
