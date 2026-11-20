import { useState, useEffect, useCallback } from 'react'
import { Globe, Plus, Lock, Trash2, Power } from 'lucide-react'
import { apiFetch, apiPost, apiDelete } from '../hooks/useApi'

export default function ProxyManager() {
  const [routes, setRoutes] = useState([])
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ domain: '', target: '', port: 80, ssl: false })
  const [loading, setLoading] = useState(true)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [feedback, setFeedback] = useState(null)

  const loadRoutes = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiFetch('/proxy')
      setRoutes(Array.isArray(data) ? data : [])
    } catch {
      setRoutes([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadRoutes()
  }, [loadRoutes])

  async function handleCreate(e) {
    e.preventDefault()
    setFeedback(null)
    try {
      await apiPost('/proxy', form)
      setShowForm(false)
      setForm({ domain: '', target: '', port: 80, ssl: false })
      setFeedback({ type: 'success', text: `Web route "${form.domain}" created.` })
      loadRoutes()
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to create route' })
    }
  }

  async function handleDelete(id) {
    setFeedback(null)
    try {
      await apiDelete(`/proxy/${id}`)
      setConfirmDeleteId(null)
      setFeedback({ type: 'success', text: 'Web route removed.' })
      loadRoutes()
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to delete route' })
    }
  }

  async function handleToggle(id, enabled) {
    setFeedback(null)
    try {
      const endpoint = enabled ? 'disable' : 'enable'
      await apiPost(`/proxy/${id}/${endpoint}`, {})
      loadRoutes()
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to update route' })
    }
  }

  return (
    <div className="p-6 sm:p-8 max-w-7xl mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-100">Domains &amp; Reverse Proxy</h1>
          <p className="text-slate-400 text-sm mt-1">
            Connect custom web addresses to your running apps with automatic HTTPS security.
          </p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="inline-flex items-center gap-2 bg-kathal-600 hover:bg-kathal-500 text-white px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap shrink-0 transition-colors"
        >
          <Plus className="w-4 h-4" />
          <span>Add Domain Route</span>
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
        <form onSubmit={handleCreate} className="bg-[#111827] border border-slate-800/90 rounded-xl p-6 space-y-4">
          <div>
            <h2 className="text-base font-semibold text-slate-100">Connect a Web Address</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Send visitors from a friendly domain name to an app running on a port.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Domain Name</label>
              <input
                value={form.domain}
                onChange={(e) => setForm({ ...form, domain: e.target.value })}
                placeholder="app.example.com"
                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3.5 py-2 text-sm text-slate-100 focus:border-kathal-500 focus:outline-none"
                required
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Destination App URL</label>
              <input
                value={form.target}
                onChange={(e) => setForm({ ...form, target: e.target.value })}
                placeholder="http://localhost:8080"
                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3.5 py-2 text-sm font-mono text-slate-100 focus:border-kathal-500 focus:outline-none"
                required
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Listen Port</label>
              <input
                type="number"
                value={form.port}
                onChange={(e) => setForm({ ...form, port: parseInt(e.target.value, 10) || 80 })}
                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3.5 py-2 text-sm text-slate-100 tabular-nums focus:border-kathal-500 focus:outline-none"
              />
            </div>
            <div className="flex items-end pb-1">
              <label className="flex items-center gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.ssl}
                  onChange={(e) => setForm({ ...form, ssl: e.target.checked })}
                  className="w-4 h-4 rounded accent-kathal-500"
                />
                <span className="text-sm text-slate-300">Auto SSL Certificate (HTTPS)</span>
              </label>
            </div>
          </div>
          <div className="flex gap-2">
            <button type="submit" className="bg-kathal-600 hover:bg-kathal-500 text-white px-4 py-2 rounded-lg text-sm font-medium">
              Create Route
            </button>
            <button type="button" onClick={() => setShowForm(false)} className="bg-slate-800 hover:bg-slate-700 px-4 py-2 rounded-lg text-sm text-slate-300">
              Cancel
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="bg-[#111827] border border-slate-800/90 rounded-xl p-12 text-center text-slate-400 text-sm">
          Loading domain routes...
        </div>
      ) : routes.length === 0 ? (
        <div className="bg-[#111827] border border-slate-800/90 rounded-xl p-12 text-center space-y-2">
          <Globe className="w-10 h-10 text-slate-600 mx-auto" />
          <p className="text-slate-200 text-lg font-semibold">No domain routes configured</p>
          <p className="text-slate-400 text-sm">Add a route above or launch an app with automatic domain setup.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {routes.map((route) => (
            <div key={route.id} className="bg-[#111827] border border-slate-800/90 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3.5 min-w-0">
                <span
                  className={`w-2.5 h-2.5 rounded-full shrink-0 ${route.enabled ? 'bg-green-500' : 'bg-slate-600'}`}
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-slate-100 truncate">{route.domain}</p>
                    {route.ssl && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-green-400">
                        <Lock className="w-3 h-3" />
                        <span>HTTPS</span>
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-400 font-mono mt-0.5 truncate">
                    → {route.target}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={() => handleToggle(route.id, route.enabled)}
                  className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
                    route.enabled
                      ? 'bg-amber-500/15 hover:bg-amber-500/25 text-amber-400'
                      : 'bg-green-500/15 hover:bg-green-500/25 text-green-400'
                  }`}
                >
                  <Power className="w-3 h-3" />
                  <span>{route.enabled ? 'Disable' : 'Enable'}</span>
                </button>
                {confirmDeleteId === route.id ? (
                  <>
                    <button
                      onClick={() => handleDelete(route.id)}
                      className="px-2.5 py-1.5 rounded-md text-xs font-medium bg-red-600 hover:bg-red-500 text-white"
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => setConfirmDeleteId(null)}
                      className="px-2.5 py-1.5 rounded-md text-xs bg-slate-800 hover:bg-slate-700 text-slate-300"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => setConfirmDeleteId(route.id)}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium bg-red-500/15 hover:bg-red-600 text-red-400 hover:text-white transition-colors"
                  >
                    <Trash2 className="w-3 h-3" />
                    <span>Delete</span>
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
