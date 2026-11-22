import { useState, useEffect, useCallback } from 'react'
import { Archive, Download, Upload, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { apiFetch, apiPost, apiDelete, apiFetchBlob, apiPostFormData } from '../hooks/useApi'

export default function Backups() {
  const [backups, setBackups] = useState([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [backupName, setBackupName] = useState('')
  const [confirmRestoreId, setConfirmRestoreId] = useState(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [feedback, setFeedback] = useState(null)

  const loadBackups = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiFetch('/backups')
      setBackups(Array.isArray(data) ? data : [])
    } catch {
      setBackups([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadBackups()
  }, [loadBackups])

  async function handleCreate(e) {
    e.preventDefault()
    setCreating(true)
    setFeedback(null)
    try {
      const bkp = await apiPost('/backups', { name: backupName.trim() })
      setBackupName('')
      setShowCreateForm(false)
      setFeedback({ type: 'success', text: `Created backup snapshot "${bkp.name}".` })
      loadBackups()
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to create backup' })
    } finally {
      setCreating(false)
    }
  }

  async function handleRestore(id) {
    setFeedback(null)
    try {
      const res = await apiPost('/backups/' + id + '/restore', {})
      setConfirmRestoreId(null)
      setFeedback({ type: 'success', text: res.message || 'Backup restored.' })
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to restore backup' })
    }
  }

  async function handleDelete(id) {
    setFeedback(null)
    try {
      await apiDelete('/backups/' + id)
      setConfirmDeleteId(null)
      setFeedback({ type: 'success', text: 'Backup deleted.' })
      loadBackups()
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to delete backup' })
    }
  }

  async function handleExport() {
    setFeedback(null)
    try {
      const blob = await apiFetchBlob('/backups/export')
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'kathal-backup-' + new Date().toISOString().slice(0, 10) + '.zip'
      a.click()
      URL.revokeObjectURL(url)
      setFeedback({ type: 'success', text: 'Exported compressed ZIP archive of service registry & app configs.' })
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Export failed' })
    }
  }

  async function handleDownloadSnapshot(b) {
    setFeedback(null)
    try {
      const blob = await apiFetchBlob('/backups/' + encodeURIComponent(b.id) + '/download')
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = (b.name || b.id) + '.zip'
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Download failed' })
    }
  }

  async function handleImport(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setFeedback(null)
    const formData = new FormData()
    formData.append('file', file)
    try {
      const res = await apiPostFormData('/backups/import', formData)
      setFeedback({ type: 'success', text: res.message || 'Import complete.' })
      loadBackups()
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Import failed' })
    }
    e.target.value = ''
  }

  return (
    <div className="p-6 sm:p-8 max-w-7xl mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-100">Backup &amp; Restore</h1>
          <p className="text-slate-400 text-sm mt-1">
            Export your service registry, reverse proxy routes, and application configuration files as a compressed ZIP archive.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 shrink-0">
          <button
            onClick={handleExport}
            className="inline-flex items-center gap-1.5 bg-[#101A10] hover:bg-slate-800 border border-slate-800 text-slate-200 px-3.5 py-2 rounded-lg text-sm whitespace-nowrap transition-colors"
          >
            <Download className="w-4 h-4 text-slate-400" />
            <span>Export ZIP</span>
          </button>
          <label className="inline-flex items-center gap-1.5 bg-[#101A10] hover:bg-slate-800 border border-slate-800 text-slate-200 px-3.5 py-2 rounded-lg text-sm cursor-pointer whitespace-nowrap transition-colors">
            <Upload className="w-4 h-4 text-slate-400" />
            <span>Import</span>
            <input type="file" accept=".zip,.json" className="hidden" onChange={handleImport} />
          </label>
          <button
            onClick={() => setShowCreateForm((v) => !v)}
            className="inline-flex items-center gap-1.5 bg-kathal-600 hover:bg-kathal-500 text-white px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors"
          >
            <Plus className="w-4 h-4" />
            <span>Create Backup</span>
          </button>
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

      {showCreateForm && (
        <form onSubmit={handleCreate} className="bg-[#101A10] border border-slate-800/90 rounded-xl p-4 flex flex-wrap items-center gap-3">
          <input
            type="text"
            value={backupName}
            onChange={(e) => setBackupName(e.target.value)}
            placeholder="Snapshot name (leave blank for auto-timestamp)"
            className="flex-1 min-w-[240px] bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-kathal-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={creating}
            className="px-4 py-2 bg-kathal-600 hover:bg-kathal-500 text-white rounded-lg text-sm font-medium disabled:opacity-50"
          >
            {creating ? 'Creating...' : 'Create Snapshot'}
          </button>
          <button
            type="button"
            onClick={() => setShowCreateForm(false)}
            className="px-3 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm text-slate-300"
          >
            Cancel
          </button>
        </form>
      )}

      {loading ? (
        <div className="bg-[#101A10] border border-slate-800/90 rounded-xl p-12 text-center text-slate-400 text-sm">
          Loading backups...
        </div>
      ) : backups.length === 0 ? (
        <div className="bg-[#101A10] border border-slate-800/90 rounded-xl p-12 text-center space-y-2">
          <Archive className="w-10 h-10 text-slate-600 mx-auto" />
          <p className="text-slate-200 text-lg font-semibold">No backups yet</p>
          <p className="text-slate-400 text-sm">Create your first backup snapshot to keep your data safe.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {backups.map((b) => (
            <div key={b.id} className="bg-[#101A10] border border-slate-800/90 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3.5">
                <div className="w-9 h-9 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center text-kathal-400 shrink-0">
                  <Archive className="w-4 h-4" />
                </div>
                <div>
                  <p className="font-semibold text-slate-100">{b.name || b.id}</p>
                  <p className="text-xs text-slate-400 tabular-nums mt-0.5">
                    {b.created_at ? new Date(b.created_at).toLocaleString() : 'Unknown date'} · {b.size || 'Unknown size'}
                    {b.entryCount ? ` · ${b.entryCount} files` : ''}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {b.archiveAvailable && (
                  <button
                    onClick={() => handleDownloadSnapshot(b)}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors"
                  >
                    <Download className="w-3 h-3" />
                    <span>ZIP</span>
                  </button>
                )}
                {confirmRestoreId === b.id ? (
                  <>
                    <button
                      onClick={() => handleRestore(b.id)}
                      className="px-3 py-1.5 rounded-md text-xs font-medium bg-green-600 hover:bg-green-500 text-white"
                    >
                      Confirm Restore
                    </button>
                    <button
                      onClick={() => setConfirmRestoreId(null)}
                      className="px-2.5 py-1.5 rounded-md text-xs bg-slate-800 text-slate-300"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => setConfirmRestoreId(b.id)}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium bg-green-500/15 hover:bg-green-600 text-green-400 hover:text-white transition-colors"
                  >
                    <RotateCcw className="w-3 h-3" />
                    <span>Restore</span>
                  </button>
                )}

                {confirmDeleteId === b.id ? (
                  <>
                    <button
                      onClick={() => handleDelete(b.id)}
                      className="px-3 py-1.5 rounded-md text-xs font-medium bg-red-600 text-white"
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => setConfirmDeleteId(null)}
                      className="px-2.5 py-1.5 rounded-md text-xs bg-slate-800 text-slate-300"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => setConfirmDeleteId(b.id)}
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