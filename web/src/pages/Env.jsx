import { useState, useEffect, useCallback } from 'react'
import { apiFetch, apiPost, apiDelete } from '../hooks/useApi'

export default function Env() {
  const [globalEnv, setGlobalEnv] = useState([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState({ key: '', value: '', description: '', secret: false })
  const [revealed, setRevealed] = useState({})
  const [confirmDeleteKey, setConfirmDeleteKey] = useState(null)
  const [feedback, setFeedback] = useState(null)

  const loadEnv = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiFetch('/env')
      setGlobalEnv(Array.isArray(data) ? data : [])
    } catch {
      setGlobalEnv([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadEnv()
  }, [loadEnv])

  async function handleAdd(e) {
    e.preventDefault()
    setFeedback(null)
    try {
      await apiPost('/env', form)
      setShowAdd(false)
      setForm({ key: '', value: '', description: '', secret: false })
      setFeedback({ type: 'success', text: `Saved environment variable "${form.key}".` })
      loadEnv()
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to save variable' })
    }
  }

  async function handleDelete(key) {
    setFeedback(null)
    try {
      await apiDelete('/env/' + encodeURIComponent(key))
      setConfirmDeleteKey(null)
      setFeedback({ type: 'success', text: `Removed variable "${key}".` })
      loadEnv()
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Delete failed' })
    }
  }

  async function handleToggleReveal(env) {
    if (revealed[env.key] !== undefined) {
      setRevealed((prev) => {
        const next = { ...prev }
        delete next[env.key]
        return next
      })
      return
    }
    setFeedback(null)
    try {
      const res = await apiPost('/env/' + encodeURIComponent(env.key) + '/reveal', {})
      setRevealed((prev) => ({ ...prev, [env.key]: res.value ?? '' }))
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to reveal secret' })
    }
  }

  return (
    <div className="p-8">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-3xl font-bold">Environment Variables</h1>
          <p className="text-gray-500 mt-1">Global secrets and runtime variables injected into deployed containers</p>
        </div>
        <button
          onClick={() => {
            setForm({ key: '', value: '', description: '', secret: false })
            setShowAdd(true)
          }}
          className="px-4 py-2 bg-kathal-600 hover:bg-kathal-500 text-white rounded-lg text-sm font-medium transition-colors"
        >
          + Add Variable
        </button>
      </div>

      {feedback && (
        <div
          className={`mb-4 p-3 rounded-lg border text-sm ${
            feedback.type === 'error'
              ? 'bg-red-600/10 border-red-600/30 text-red-400'
              : 'bg-green-600/10 border-green-600/30 text-green-400'
          }`}
        >
          {feedback.text}
        </div>
      )}

      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-gray-800 flex items-center gap-3">
          <span className="bg-kathal-600/20 text-kathal-400 border border-kathal-600/30 px-2.5 py-0.5 rounded text-xs font-medium">
            Global ({globalEnv.length})
          </span>
          <span className="text-gray-500 text-xs">Applied automatically on container and Git deployments</span>
        </div>

        {loading ? (
          <div className="p-10 text-center text-gray-500">Loading variables...</div>
        ) : globalEnv.length === 0 ? (
          <div className="p-12 text-center text-gray-500">
            <div className="text-5xl mb-3">🔐</div>
            <p className="font-medium text-gray-300">No global environment variables</p>
            <p className="text-xs text-gray-500 mt-1">Add variables to inject into all deployed apps</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-800">
            {globalEnv.map((env) => {
              const isRevealed = revealed[env.key] !== undefined
              const displayValue = env.secret ? (isRevealed ? revealed[env.key] : '••••••••••••') : env.value
              return (
                <div key={env.key} className="flex flex-wrap items-center justify-between gap-4 px-5 py-3.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <code className="bg-gray-950 border border-gray-800 px-2.5 py-1 rounded text-xs font-mono text-gray-200">
                        {env.key}
                      </code>
                      {env.secret && (
                        <span className="bg-red-600/20 text-red-400 border border-red-600/30 px-2 py-0.5 rounded text-[10px] font-semibold">
                          SECRET
                        </span>
                      )}
                    </div>
                    {env.description && <p className="text-xs text-gray-500 mt-1">{env.description}</p>}
                  </div>

                  <div className="flex items-center gap-2">
                    <code className="bg-gray-950 border border-gray-800 px-3 py-1 rounded text-xs font-mono text-gray-300 max-w-xs truncate">
                      {displayValue}
                    </code>
                    {env.secret && (
                      <button
                        type="button"
                        onClick={() => handleToggleReveal(env)}
                        className="px-2.5 py-1 bg-gray-800 hover:bg-gray-700 rounded text-xs text-gray-300"
                      >
                        {isRevealed ? 'Hide' : 'Reveal'}
                      </button>
                    )}
                    {confirmDeleteKey === env.key ? (
                      <>
                        <button
                          onClick={() => handleDelete(env.key)}
                          className="px-2.5 py-1 bg-red-600 text-white rounded text-xs font-medium"
                        >
                          Confirm
                        </button>
                        <button
                          onClick={() => setConfirmDeleteKey(null)}
                          className="px-2.5 py-1 bg-gray-800 text-gray-300 rounded text-xs"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => setConfirmDeleteKey(env.key)}
                        className="px-2.5 py-1 bg-red-600/20 hover:bg-red-600 text-red-400 hover:text-white rounded text-xs transition-colors"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Add Modal */}
      {showAdd && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
          onClick={() => setShowAdd(false)}
        >
          <form
            onSubmit={handleAdd}
            onClick={(e) => e.stopPropagation()}
            className="bg-gray-900 border border-gray-800 rounded-2xl p-6 max-w-md w-full space-y-4"
          >
            <h3 className="text-xl font-bold">Add Environment Variable</h3>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Key</label>
              <input
                value={form.key}
                onChange={(e) => setForm({ ...form, key: e.target.value })}
                placeholder="DATABASE_URL"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono focus:border-kathal-500 focus:outline-none"
                required
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Value</label>
              <input
                value={form.value}
                onChange={(e) => setForm({ ...form, value: e.target.value })}
                placeholder="postgresql://..."
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono focus:border-kathal-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Description (optional)</label>
              <input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Production database URL"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-kathal-500 focus:outline-none"
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={form.secret}
                onChange={(e) => setForm({ ...form, secret: e.target.checked })}
                className="w-4 h-4 accent-kathal-500"
              />
              Mark as secret (masked by default)
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowAdd(false)}
                className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm text-gray-300"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-kathal-600 hover:bg-kathal-500 text-white rounded-lg text-sm font-medium"
              >
                Save Variable
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}