import { useState, useEffect } from 'react'
import { apiFetch, apiPost, apiDelete } from '../hooks/useApi'

const DB_TYPES = [
  { value: 'postgres', label: 'PostgreSQL', icon: '🐘', color: 'blue' },
  { value: 'mysql', label: 'MySQL', icon: '🐬', color: 'orange' },
  { value: 'mongodb', label: 'MongoDB', icon: '🍃', color: 'green' },
  { value: 'redis', label: 'Redis', icon: '🔴', color: 'red' },
]

export default function Databases() {
  const [databases, setDatabases] = useState([])
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ name: '', type: 'postgres', password: '' })
  const [loading, setLoading] = useState(true)
  const [connStr, setConnStr] = useState(null)

  useEffect(() => { loadDatabases() }, [])

  async function loadDatabases() {
    setLoading(true)
    try {
      const data = await apiFetch('/api/v1/databases')
      setDatabases(Array.isArray(data) ? data : [])
    } catch { setDatabases([]) }
    setLoading(false)
  }

  async function handleCreate(e) {
    e.preventDefault()
    try {
      const db = await apiPost('/api/v1/databases', form)
      setShowForm(false)
      setForm({ name: '', type: 'postgres', password: '' })
      loadDatabases()
    } catch (err) { alert(err.message) }
  }

  async function handleDelete(id) {
    if (!confirm('Delete this database? All data will be lost.')) return
    await apiDelete(`/api/v1/databases/${id}`)
    loadDatabases()
  }

  async function handleConnection(id) {
    try {
      const data = await apiFetch(`/api/v1/databases/${id}/connection`)
      setConnStr(data.connection_string)
    } catch (err) { alert(err.message) }
  }

  async function handleStart(id) {
    await apiPost(`/api/v1/databases/${id}/start`, {})
    loadDatabases()
  }

  async function handleStop(id) {
    await apiPost(`/api/v1/databases/${id}/stop`, {})
    loadDatabases()
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">🗄️ Databases</h1>
          <p className="text-gray-500 text-sm mt-1">Manage PostgreSQL, MySQL, MongoDB, and Redis instances</p>
        </div>
        <button onClick={() => setShowForm(!showForm)} className="bg-kathal-600 hover:bg-kathal-700 px-4 py-2 rounded-lg text-sm font-medium transition-colors">
          + Create Database
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-6 space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Name</label>
              <input value={form.name} onChange={e => setForm({...form, name: e.target.value})} placeholder="mydb" className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-sm focus:border-kathal-500 focus:outline-none" required />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Type</label>
              <select value={form.type} onChange={e => setForm({...form, type: e.target.value})} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-sm focus:border-kathal-500 focus:outline-none">
                {DB_TYPES.map(t => <option key={t.value} value={t.value}>{t.icon} {t.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Password (blank = auto-generate)</label>
              <input type="password" value={form.password} onChange={e => setForm({...form, password: e.target.value})} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-sm focus:border-kathal-500 focus:outline-none" />
            </div>
          </div>
          <div className="flex gap-2">
            <button type="submit" className="bg-kathal-600 hover:bg-kathal-700 px-4 py-2 rounded-lg text-sm font-medium">Create</button>
            <button type="button" onClick={() => setShowForm(false)} className="bg-gray-800 hover:bg-gray-700 px-4 py-2 rounded-lg text-sm text-gray-400">Cancel</button>
          </div>
        </form>
      )}

      {connStr && (
        <div className="bg-gray-900 border border-kathal-600/30 rounded-xl p-4 mb-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-400 mb-1">Connection String</p>
              <code className="text-sm text-kathal-400 font-mono break-all">{connStr}</code>
            </div>
            <button onClick={() => navigator.clipboard.writeText(connStr)} className="text-gray-500 hover:text-white text-sm">Copy</button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading...</div>
      ) : databases.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500 text-lg mb-2">No databases running</p>
          <p className="text-gray-600 text-sm">Create a database to get started</p>
        </div>
      ) : (
        <div className="space-y-3">
          {databases.map(db => {
            const typeInfo = DB_TYPES.find(t => t.value === db.type) || DB_TYPES[0]
            const running = db.status === 'running'
            return (
              <div key={db.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <span className="text-2xl">{typeInfo.icon}</span>
                  <div>
                    <p className="font-medium">{db.name}</p>
                    <p className="text-sm text-gray-500">{typeInfo.label} • Port {db.port} • {db.user}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`px-2 py-1 rounded text-xs font-medium ${running ? 'bg-green-600/20 text-green-400' : 'bg-gray-700 text-gray-400'}`}>
                    {db.status}
                  </span>
                  <button onClick={() => handleConnection(db.id)} className="text-gray-500 hover:text-white text-sm" title="Connection string">🔗</button>
                  {running ? (
                    <button onClick={() => handleStop(db.id)} className="text-yellow-500 hover:text-yellow-400 text-sm" title="Stop">⏸</button>
                  ) : (
                    <button onClick={() => handleStart(db.id)} className="text-green-500 hover:text-green-400 text-sm" title="Start">▶️</button>
                  )}
                  <button onClick={() => handleDelete(db.id)} className="text-red-500 hover:text-red-400 text-sm" title="Delete">🗑️</button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
