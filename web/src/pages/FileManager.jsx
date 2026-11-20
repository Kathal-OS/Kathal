import { useState, useEffect, useCallback } from 'react'
import {
  Folder,
  File,
  FileCode2,
  FileText,
  Image as ImageIcon,
  Archive,
  FolderPlus,
  Upload,
  ArrowLeft,
  Trash2,
} from 'lucide-react'
import { apiFetch, apiPost, apiDelete, apiFetchText, apiPostFormData } from '../hooks/useApi'

function formatSize(bytes) {
  if (!bytes || bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i]
}

function renderFileIcon(item) {
  if (item.is_dir) return <Folder className="w-4 h-4 text-kathal-400 shrink-0" />
  const ext = item.name.split('.').pop()?.toLowerCase()
  if (['js', 'jsx', 'ts', 'tsx', 'py', 'go', 'json', 'yaml', 'yml', 'sh', 'html', 'css'].includes(ext)) {
    return <FileCode2 className="w-4 h-4 text-slate-400 shrink-0" />
  }
  if (['md', 'txt', 'log'].includes(ext)) {
    return <FileText className="w-4 h-4 text-slate-400 shrink-0" />
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) {
    return <ImageIcon className="w-4 h-4 text-slate-400 shrink-0" />
  }
  if (['zip', 'tar', 'gz'].includes(ext)) {
    return <Archive className="w-4 h-4 text-slate-400 shrink-0" />
  }
  return <File className="w-4 h-4 text-slate-400 shrink-0" />
}

export default function FileManager() {
  const [path, setPath] = useState('/')
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [editor, setEditor] = useState(null)
  const [editorContent, setEditorContent] = useState('')
  const [showMkdir, setShowMkdir] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [confirmDeletePath, setConfirmDeletePath] = useState(null)
  const [feedback, setFeedback] = useState(null)

  const loadDir = useCallback(async (dirPath) => {
    setLoading(true)
    try {
      const data = await apiFetch('/files?path=' + encodeURIComponent(dirPath))
      setItems(Array.isArray(data) ? data : [])
    } catch {
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadDir(path)
  }, [path, loadDir])

  async function openFile(filePath) {
    setFeedback(null)
    try {
      const text = await apiFetchText('/files/read?path=' + encodeURIComponent(filePath))
      setEditor(filePath)
      setEditorContent(text)
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to read file' })
    }
  }

  async function saveFile() {
    setFeedback(null)
    try {
      await apiPost('/files/write', { path: editor, content: editorContent })
      setFeedback({ type: 'success', text: `Saved ${editor}` })
      setEditor(null)
      loadDir(path)
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to save file' })
    }
  }

  async function handleDelete(filePath) {
    setFeedback(null)
    try {
      await apiDelete('/files/delete?path=' + encodeURIComponent(filePath))
      setConfirmDeletePath(null)
      setFeedback({ type: 'success', text: `Deleted ${filePath}` })
      loadDir(path)
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Delete failed' })
    }
  }

  async function handleMkdir(e) {
    e.preventDefault()
    if (!newFolderName.trim()) return
    setFeedback(null)
    const fullPath = path === '/' ? '/' + newFolderName.trim() : path + '/' + newFolderName.trim()
    try {
      await apiPost('/files/mkdir', { path: fullPath })
      setNewFolderName('')
      setShowMkdir(false)
      loadDir(path)
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to create folder' })
    }
  }

  async function handleUpload(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setFeedback(null)
    const formData = new FormData()
    formData.append('file', file)
    formData.append('path', path === '/' ? file.name : path + '/' + file.name)
    try {
      await apiPostFormData('/files/upload', formData)
      setFeedback({ type: 'success', text: `Uploaded ${file.name}` })
      loadDir(path)
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Upload failed' })
    }
    e.target.value = ''
  }

  function navigate(name, is_dir) {
    const target = path === '/' ? '/' + name : path + '/' + name
    if (is_dir) {
      setPath(target)
      setConfirmDeletePath(null)
    } else {
      openFile(target)
    }
  }

  function goUp() {
    const parts = path.split('/').filter(Boolean)
    parts.pop()
    setPath('/' + parts.join('/'))
  }

  const breadcrumbs = path.split('/').filter(Boolean)

  return (
    <div className="p-6 sm:p-8 max-w-7xl mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-100">File Manager</h1>
          <p className="text-slate-400 text-sm mt-1">
            Browse, upload, and edit folders and configuration files right in your browser.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={() => setShowMkdir((v) => !v)}
            className="inline-flex items-center gap-1.5 bg-[#111827] hover:bg-slate-800 border border-slate-800 text-slate-200 px-3.5 py-2 rounded-lg text-sm whitespace-nowrap transition-colors"
          >
            <FolderPlus className="w-4 h-4 text-slate-400" />
            <span>New Folder</span>
          </button>
          <label className="inline-flex items-center gap-1.5 bg-kathal-600 hover:bg-kathal-500 text-white px-4 py-2 rounded-lg text-sm cursor-pointer transition-colors font-medium whitespace-nowrap">
            <Upload className="w-4 h-4" />
            <span>Upload File</span>
            <input type="file" className="hidden" onChange={handleUpload} />
          </label>
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

      {showMkdir && (
        <form onSubmit={handleMkdir} className="bg-[#111827] border border-slate-800/90 rounded-xl p-4 flex flex-wrap items-center gap-3">
          <input
            type="text"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            placeholder="New folder name"
            className="flex-1 min-w-[200px] bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-kathal-500 focus:outline-none"
            required
          />
          <button type="submit" className="px-4 py-2 bg-kathal-600 hover:bg-kathal-500 text-white rounded-lg text-sm font-medium">
            Create Folder
          </button>
          <button type="button" onClick={() => setShowMkdir(false)} className="px-3 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm text-slate-300">
            Cancel
          </button>
        </form>
      )}

      {/* Breadcrumbs */}
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        <button onClick={() => setPath('/')} className="text-kathal-400 hover:text-kathal-300 font-mono">
          root
        </button>
        {breadcrumbs.map((part, i) => (
          <span key={i} className="flex items-center gap-1.5">
            <span className="text-slate-600">/</span>
            <button onClick={() => setPath('/' + breadcrumbs.slice(0, i + 1).join('/'))} className="text-kathal-400 hover:text-kathal-300 font-mono">
              {part}
            </button>
          </span>
        ))}
      </div>

      {editor !== null && (
        <div className="bg-[#111827] border border-kathal-500/40 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm text-slate-300 font-mono">Editing: {editor}</p>
            <div className="flex gap-2">
              <button onClick={saveFile} className="bg-kathal-600 hover:bg-kathal-500 text-white px-3 py-1.5 rounded-md text-xs font-medium">
                Save
              </button>
              <button onClick={() => setEditor(null)} className="bg-slate-800 hover:bg-slate-700 px-3 py-1.5 rounded-md text-xs text-slate-300">
                Close
              </button>
            </div>
          </div>
          <textarea
            value={editorContent}
            onChange={(e) => setEditorContent(e.target.value)}
            className="w-full h-64 bg-slate-950 border border-slate-800 rounded-lg p-3 text-sm font-mono text-slate-200 focus:border-kathal-500 focus:outline-none resize-y"
          />
        </div>
      )}

      {path !== '/' && (
        <button onClick={goUp} className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-200">
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Up one folder</span>
        </button>
      )}

      {loading ? (
        <div className="bg-[#111827] border border-slate-800/90 rounded-xl p-12 text-center text-slate-400 text-sm">
          Loading files...
        </div>
      ) : items.length === 0 ? (
        <div className="bg-[#111827] border border-slate-800/90 rounded-xl p-12 text-center text-slate-400 text-sm">
          This folder is empty.
        </div>
      ) : (
        <div className="bg-[#111827] border border-slate-800/90 rounded-xl overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead className="bg-slate-900/70 border-b border-slate-800">
              <tr className="text-xs text-slate-400 uppercase tracking-wider">
                <th className="py-3 px-4 font-medium">Name</th>
                <th className="text-right py-3 px-4 font-medium">Size</th>
                <th className="text-right py-3 px-4 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {items.map((item) => {
                const fullItemPath = path === '/' ? '/' + item.name : path + '/' + item.name
                return (
                  <tr key={item.name} className="hover:bg-slate-800/30 transition-colors">
                    <td className="px-4 py-3">
                      <button
                        onClick={() => navigate(item.name, item.is_dir)}
                        className="flex items-center gap-2.5 text-sm text-slate-200 hover:text-kathal-400 transition-colors"
                      >
                        {renderFileIcon(item)}
                        <span>{item.name}</span>
                      </button>
                    </td>
                    <td className="text-right px-4 py-3 text-sm text-slate-400 tabular-nums">
                      {item.is_dir ? '—' : formatSize(item.size)}
                    </td>
                    <td className="text-right px-4 py-3 whitespace-nowrap">
                      {confirmDeletePath === fullItemPath ? (
                        <span className="inline-flex items-center gap-1.5">
                          <button
                            onClick={() => handleDelete(fullItemPath)}
                            className="px-2.5 py-1 bg-red-600 text-white rounded text-xs font-medium"
                          >
                            Confirm
                          </button>
                          <button
                            onClick={() => setConfirmDeletePath(null)}
                            className="px-2 py-1 bg-slate-800 text-slate-300 rounded text-xs"
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          onClick={() => setConfirmDeletePath(fullItemPath)}
                          className="inline-flex items-center gap-1 text-red-400 hover:text-red-300 text-xs"
                        >
                          <Trash2 className="w-3 h-3" />
                          <span>Delete</span>
                        </button>
                      )}
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