import { useState, useEffect } from 'react'
import { apiFetch, apiPost, apiDelete, apiFetchText, apiPostFormData } from '../hooks/useApi'

function formatSize(bytes) {
  if (!bytes || bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i]
}

const FILE_ICONS = {
  directory: '📁', js: '📄', jsx: '⚛️', ts: '📘', py: '🐍', go: '🔷',
  json: '📋', md: '📝', yaml: '⚙️', yml: '⚙️', sh: '🖥️', txt: '📄',
  html: '🌐', css: '🎨', png: '🖼️', jpg: '🖼️', gif: '🖼️', zip: '📦',
  default: '📄'
}

function getFileIcon(item) {
  if (item.is_dir) return FILE_ICONS.directory
  const ext = item.name.split('.').pop()?.toLowerCase()
  return FILE_ICONS[ext] || FILE_ICONS.default
}

export default function FileManager() {
  const [path, setPath] = useState('/')
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [editor, setEditor] = useState(null)
  const [editorContent, setEditorContent] = useState('')
  const [showUpload, setShowUpload] = useState(false)

  useEffect(() => { loadDir(path) }, [path])

  async function loadDir(dirPath) {
    setLoading(true)
    try {
      const data = await apiFetch('/files?path=' + encodeURIComponent(dirPath))
      setItems(Array.isArray(data) ? data : [])
    } catch { setItems([]) }
    setLoading(false)
  }

  async function openFile(filePath) {
    try {
      const text = await apiFetchText('/files/read?path=' + encodeURIComponent(filePath))
      setEditor(filePath)
      setEditorContent(text)
    } catch (err) { alert(err.message) }
  }

  async function saveFile() {
    try {
      await apiPost('/files/write', { path: editor, content: editorContent })
      setEditor(null)
      loadDir(path)
    } catch (err) { alert(err.message) }
  }

  async function handleDelete(filePath, isDir) {
    if (!confirm('Delete ' + (isDir ? 'folder' : 'file') + ': ' + filePath + '?')) return
    await apiDelete('/files/delete?path=' + encodeURIComponent(filePath))
    loadDir(path)
  }

  async function handleMkdir() {
    const name = prompt('Folder name:')
    if (!name) return
    const fullPath = path === '/' ? '/' + name : path + '/' + name
    await apiPost('/files/mkdir', { path: fullPath })
    loadDir(path)
  }

  async function handleUpload(e) {
    const file = e.target.files[0]
    if (!file) return
    const formData = new FormData()
    formData.append('file', file)
    formData.append('path', path === '/' ? file.name : path + '/' + file.name)
    await apiPostFormData('/files/upload', formData)
    setShowUpload(false)
    loadDir(path)
  }

  function navigate(name, is_dir) {
    if (is_dir) {
      setPath(path === '/' ? '/' + name : path + '/' + name)
    } else {
      openFile(path === '/' ? '/' + name : path + '/' + name)
    }
  }

  function goUp() {
    const parts = path.split('/').filter(Boolean)
    parts.pop()
    setPath('/' + parts.join('/'))
  }

  const breadcrumbs = path.split('/').filter(Boolean)

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">📂 File Manager</h1>
          <p className="text-gray-500 text-sm mt-1">Browse and edit files on the server</p>
        </div>
        <div className="flex gap-2">
          <button onClick={handleMkdir} className="bg-gray-800 hover:bg-gray-700 px-4 py-2 rounded-lg text-sm transition-colors">+ Folder</button>
          <label className="bg-gray-800 hover:bg-gray-700 px-4 py-2 rounded-lg text-sm cursor-pointer transition-colors">
            Upload
            <input type="file" className="hidden" onChange={handleUpload} />
          </label>
        </div>
      </div>

      {/* Breadcrumbs */}
      <div className="flex items-center gap-1 text-sm mb-4">
        <button onClick={() => setPath('/')} className="text-kathal-400 hover:text-kathal-300">/</button>
        {breadcrumbs.map((part, i) => (
          <span key={i} className="flex items-center gap-1">
            <span className="text-gray-600">/</span>
            <button onClick={() => setPath('/' + breadcrumbs.slice(0, i + 1).join('/'))} className="text-kathal-400 hover:text-kathal-300">{part}</button>
          </span>
        ))}
      </div>

      {editor !== null && (
        <div className="bg-gray-900 border border-kathal-600/30 rounded-xl p-4 mb-6">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm text-gray-400">Editing: {editor}</p>
            <div className="flex gap-2">
              <button onClick={saveFile} className="bg-kathal-600 hover:bg-kathal-700 px-3 py-1 rounded text-xs font-medium">Save</button>
              <button onClick={() => setEditor(null)} className="bg-gray-800 hover:bg-gray-700 px-3 py-1 rounded text-xs text-gray-400">Close</button>
            </div>
          </div>
          <textarea value={editorContent} onChange={e => setEditorContent(e.target.value)} className="w-full h-64 bg-gray-800 border border-gray-700 rounded-lg p-3 text-sm font-mono focus:border-kathal-500 focus:outline-none resize-y" />
        </div>
      )}

      {path !== '/' && (
        <button onClick={goUp} className="text-sm text-gray-500 hover:text-gray-300 mb-3">← Back</button>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading...</div>
      ) : items.length === 0 ? (
        <div className="text-center py-12 text-gray-500">Empty directory</div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase">
                <th className="text-left px-4 py-3">Name</th>
                <th className="text-right px-4 py-3">Size</th>
                <th className="text-right px-4 py-3 pr-4">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map(item => (
                <tr key={item.name} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                  <td className="px-4 py-3">
                    <button onClick={() => navigate(item.name, item.is_dir)} className="flex items-center gap-2 text-sm hover:text-kathal-400 transition-colors">
                      <span>{getFileIcon(item)}</span>
                      <span>{item.name}</span>
                    </button>
                  </td>
                  <td className="text-right px-4 py-3 text-sm text-gray-500">{item.is_dir ? '-' : formatSize(item.size)}</td>
                  <td className="text-right px-4 py-3 pr-4">
                    <button onClick={() => handleDelete(path === '/' ? '/' + item.name : path + '/' + item.name, item.is_dir)} className="text-red-500 hover:text-red-400 text-xs">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}