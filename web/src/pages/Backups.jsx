import { useState, useEffect } from 'react'
import { apiFetch, apiPost, apiDelete } from '../hooks/useApi'

export default function Backups() {
  const [backups, setBackups] = useState([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)

  useEffect(() => { loadBackups() }, [])

  async function loadBackups() {
    setLoading(true)
    try {
      const data = await apiFetch('/api/v1/backups')
      setBackups(Array.isArray(data) ? data : [])
    } catch { setBackups([]) }
    setLoading(false)
  }

  async function handleCreate() {
    const name = prompt('Backup name (blank for auto-generated):')
    if (name === null) return
    setCreating(true)
    try {
      await apiPost('/api/v1/backups', { name })
      loadBackups()
    } catch (err) { alert(err.message) }
    setCreating(false)
  }

  async function handleRestore(id) {
    if (!confirm('Restore this backup? Current data will be overwritten.')) return
    try {
      await apiPost(`/api/v1/backups/${id}/restore`, {})
      alert('Backup restored! Restart KATHAL to apply.')
    } catch (err) { alert(err.message) }
  }

  async function handleDelete(id) {
    if (!confirm('Delete this backup?')) return
    await apiDelete(`/api/v1/backups/${id}`)
    loadBackups()
  }

  async function handleExport() {
    try {
      const resp = await fetch('/api/v1/backups/export', {
        headers: { Authorization: `Bearer ${localStorage.getItem('kathal_token')}` }
      })
      if (!resp.ok) throw new Error('Export failed')
      const blob = await resp.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `kathal-export-${new Date().toISOString().slice(0, 10)}.zip`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) { alert(err.message) }
  }

  async function handleImport(e) {
    const file = e.target.files[0]
    if (!file) return
    const formData = new FormData()
    formData.append('file', file)
    try {
      const resp = await fetch('/api/v1/backups/import', {
        method: 'POST',
        headers: { Authorization: `Bearer ${localStorage.getItem('kathal_token')}` },
        body: formData
      })
      if (!resp.ok) throw new Error('Import failed')
      alert('Import successful! Restart KATHAL to apply.')
      loadBackups()
    } catch (err) { alert(err.message) }
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">💾 Backup & Restore</h1>
          <p className="text-gray-500 text-sm mt-1">Create, restore, and export backups of your KATHAL data</p>
        </div>
        <div className="flex gap-2">
          <button onClick={handleExport} className="bg-gray-800 hover:bg-gray-700 px-4 py-2 rounded-lg text-sm transition-colors">📥 Export All</button>
          <label className="bg-gray-800 hover:bg-gray-700 px-4 py-2 rounded-lg text-sm cursor-pointer transition-colors">
            📤 Import
            <input type="file" accept=".zip" className="hidden" onChange={handleImport} />
          </label>
          <button onClick={handleCreate} disabled={creating} className="bg-kathal-600 hover:bg-kathal-700 px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50">
            {creating ? 'Creating...' : '+ Create Backup'}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading...</div>
      ) : backups.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500 text-lg mb-2">No backups yet</p>
          <p className="text-gray-600 text-sm">Create your first backup to protect your data</p>
        </div>
      ) : (
        <div className="space-y-3">
          {backups.map(b => (
            <div key={b.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <span className="text-2xl">💾</span>
                <div>
                  <p className="font-medium">{b.name || b.id}</p>
                  <p className="text-sm text-gray-500">{b.created_at ? new Date(b.created_at).toLocaleString() : 'Unknown date'} • {b.size || 'Unknown size'}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => handleRestore(b.id)} className="px-3 py-1 rounded text-xs font-medium bg-green-600/20 text-green-400 hover:bg-green-600/30">Restore</button>
                <button onClick={() => handleDelete(b.id)} className="px-3 py-1 rounded text-xs font-medium bg-red-600/20 text-red-400 hover:bg-red-600/30">Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
