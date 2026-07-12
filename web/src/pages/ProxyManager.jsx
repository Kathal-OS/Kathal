import { useState, useEffect } from 'react'
import { apiFetch, apiPost, apiDelete } from '../hooks/useApi'

export default function ProxyManager() {
  const [routes, setRoutes] = useState([])
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ domain: '', target: '', port: 80, ssl: false })
  const [loading, setLoading] = useState(true)

  useEffect(() => { loadRoutes() }, [])

  async function loadRoutes() {
    setLoading(true)
    try {
      const data = await apiFetch('/api/v1/proxy')
      setRoutes(Array.isArray(data) ? data : [])
    } catch { setRoutes([]) }
    setLoading(false)
  }

  async function handleCreate(e) {
    e.preventDefault()
    try {
      await apiPost('/api/v1/proxy', form)
      setShowForm(false)
      setForm({ domain: '', target: '', port: 80, ssl: false })
      loadRoutes()
    } catch (err) { alert(err.message) }
  }

  async function handleDelete(id) {
    if (!confirm('Delete this route?')) return
    await apiDelete(`/api/v1/proxy/${id}`)
    loadRoutes()
  }

  async function handleToggle(id, enabled) {
    const endpoint = enabled ? 'disable' : 'enable'
    await apiPost(`/api/v1/proxy/${id}/${endpoint}`, {})
    loadRoutes()
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">🔀 Reverse Proxy</h1>
          <p className="text-gray-500 text-sm mt-1">Route traffic to your services with automatic SSL</p>
        </div>
        <button onClick={() => setShowForm(!showForm)} className="bg-kathal-600 hover:bg-kathal-700 px-4 py-2 rounded-lg text-sm font-medium transition-colors">
          + Add Route
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Domain</label>
              <input value={form.domain} onChange={e => setForm({...form, domain: e.target.value})} placeholder="example.com" className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-sm focus:border-kathal-500 focus:outline-none" required />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Target URL</label>
              <input value={form.target} onChange={e => setForm({...form, target: e.target.value})} placeholder="http://localhost:3000" className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-sm focus:border-kathal-500 focus:outline-none" required />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Listen Port</label>
              <input type="number" value={form.port} onChange={e => setForm({...form, port: parseInt(e.target.value)})} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-sm focus:border-kathal-500 focus:outline-none" />
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form.ssl} onChange={e => setForm({...form, ssl: e.target.checked})} className="w-4 h-4 rounded bg-gray-800 border-gray-700 text-kathal-600 focus:ring-kathal-500" />
                <span className="text-sm text-gray-400">Auto SSL (Let's Encrypt)</span>
              </label>
            </div>
          </div>
          <div className="flex gap-2">
            <button type="submit" className="bg-kathal-600 hover:bg-kathal-700 px-4 py-2 rounded-lg text-sm font-medium">Create</button>
            <button type="button" onClick={() => setShowForm(false)} className="bg-gray-800 hover:bg-gray-700 px-4 py-2 rounded-lg text-sm text-gray-400">Cancel</button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading...</div>
      ) : routes.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500 text-lg mb-2">No proxy routes configured</p>
          <p className="text-gray-600 text-sm">Add a route to start proxying traffic to your services</p>
        </div>
      ) : (
        <div className="space-y-3">
          {routes.map(route => (
            <div key={route.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className={`w-3 h-3 rounded-full ${route.enabled ? 'bg-green-500' : 'bg-gray-600'}`} />
                <div>
                  <p className="font-medium">{route.domain}</p>
                  <p className="text-sm text-gray-500">→ {route.target} {route.ssl && '🔒 SSL'}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => handleToggle(route.id, route.enabled)} className={`px-3 py-1 rounded text-xs font-medium ${route.enabled ? 'bg-yellow-600/20 text-yellow-400' : 'bg-green-600/20 text-green-400'}`}>
                  {route.enabled ? 'Disable' : 'Enable'}
                </button>
                <button onClick={() => handleDelete(route.id)} className="px-3 py-1 rounded text-xs font-medium bg-red-600/20 text-red-400 hover:bg-red-600/30">Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
