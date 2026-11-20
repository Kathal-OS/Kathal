import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { apiFetch, apiPost, apiPut, apiDelete } from '../hooks/useApi'

export default function GitDeploy() {
  const [repos, setRepos] = useState([])
  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [form, setForm] = useState({ name: '', url: '', branch: 'main', deploy_cmd: 'docker compose up -d', domain: '', port: '' })
  const [loading, setLoading] = useState(true)
  const [deploying, setDeploying] = useState(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [history, setHistory] = useState(null)
  const [deployOutput, setDeployOutput] = useState(null)
  const [feedback, setFeedback] = useState(null)

  const loadRepos = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiFetch('/git/repos')
      setRepos(Array.isArray(data) ? data : [])
    } catch {
      setRepos([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadRepos()
  }, [loadRepos])

  function openAdd() {
    setEditingId(null)
    setForm({ name: '', url: '', branch: 'main', deploy_cmd: 'docker compose up -d', domain: '', port: '' })
    setShowModal(true)
  }

  function openEdit(repo) {
    setEditingId(repo.id)
    setForm({
      name: repo.name || '',
      url: repo.url || '',
      branch: repo.branch || 'main',
      deploy_cmd: repo.deploy_cmd || '',
      domain: repo.domain || '',
      port: repo.port ? String(repo.port) : '',
    })
    setShowModal(true)
  }

  async function handleSave(e) {
    e.preventDefault()
    setFeedback(null)
    try {
      const payload = {
        ...form,
        port: form.port ? Number(form.port) : undefined,
      }
      if (editingId) {
        await apiPut(`/git/repos/${editingId}`, payload)
        setFeedback({ type: 'success', text: `Updated repository "${form.name}".` })
      } else {
        await apiPost('/git/repos', payload)
        setFeedback({ type: 'success', text: `Added repository "${form.name}".` })
      }
      setShowModal(false)
      loadRepos()
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to save repository' })
    }
  }

  async function handleDeploy(repo) {
    setDeploying(repo.id)
    setFeedback(null)
    try {
      const result = await apiPost(`/git/repos/${repo.id}/deploy`, {})
      setDeployOutput({ repoName: repo.name, ...result })
      setFeedback({
        type: 'success',
        text: `Deployed ${repo.name} (${result.commit}) on port ${result.port}${result.domain ? ` · ${result.domain}` : ''}`,
      })
      loadRepos()
    } catch (err) {
      setFeedback({ type: 'error', text: `Deploy failed: ${err.message}` })
    } finally {
      setDeploying(null)
    }
  }

  async function handleDelete(id) {
    try {
      await apiDelete(`/git/repos/${id}`)
      setConfirmDeleteId(null)
      setFeedback({ type: 'success', text: 'Repository deleted.' })
      loadRepos()
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to delete repository' })
    }
  }

  async function showRepoHistory(repo) {
    try {
      const data = await apiFetch(`/git/repos/${repo.id}/history`)
      setHistory({ id: repo.id, name: repo.name, logs: Array.isArray(data) ? data : [] })
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to load history' })
    }
  }

  return (
    <div className="p-8">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-3xl font-bold">Git Deployment</h1>
          <p className="text-gray-500 mt-1">
            Connect repositories for one-click build, container rollout, and reverse proxy routing
          </p>
        </div>
        <button
          onClick={openAdd}
          className="px-4 py-2 bg-kathal-600 hover:bg-kathal-500 text-white rounded-lg text-sm font-medium transition-colors"
        >
          + Add Repository
        </button>
      </div>

      {feedback && (
        <div
          className={`mb-5 p-3 rounded-lg border text-sm flex flex-wrap items-center justify-between gap-2 ${
            feedback.type === 'error'
              ? 'bg-red-600/10 border-red-600/30 text-red-400'
              : 'bg-green-600/10 border-green-600/30 text-green-400'
          }`}
        >
          <span>{feedback.text}</span>
          {feedback.type === 'success' && (
            <div className="flex gap-2">
              <Link to="/containers" className="px-2.5 py-1 bg-gray-800 rounded text-xs text-gray-200">
                Containers →
              </Link>
              <Link to="/proxy" className="px-2.5 py-1 bg-gray-800 rounded text-xs text-gray-200">
                Proxy →
              </Link>
            </div>
          )}
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading repositories...</div>
      ) : repos.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-12 text-center">
          <p className="text-5xl mb-3">🔗</p>
          <h2 className="text-xl font-semibold mb-1">No repositories configured</h2>
          <p className="text-sm text-gray-500 mb-4">Add a GitHub or GitLab repo to enable one-click deployments</p>
          <button
            onClick={openAdd}
            className="px-4 py-2 bg-kathal-600 hover:bg-kathal-500 text-white rounded-lg text-sm font-medium"
          >
            + Add Repository
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {repos.map((repo) => (
            <div
              key={repo.id}
              className="bg-gray-900 border border-gray-800 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-3">
                  <h3 className="text-lg font-semibold text-gray-100">{repo.name}</h3>
                  <span
                    className={`px-2 py-0.5 rounded text-xs font-medium ${
                      repo.status === 'success'
                        ? 'bg-green-600/20 text-green-400'
                        : repo.status === 'failed'
                        ? 'bg-red-600/20 text-red-400'
                        : 'bg-gray-800 text-gray-400'
                    }`}
                  >
                    {repo.status || 'idle'}
                  </span>
                </div>
                <p className="text-sm text-gray-400 mt-1 truncate">
                  {repo.url} · branch <code className="text-gray-300">{repo.branch}</code>
                </p>
                <div className="flex flex-wrap gap-3 mt-1.5 text-xs text-gray-500">
                  {repo.deploy_cmd && <span>Command: <code className="text-gray-400">{repo.deploy_cmd}</code></span>}
                  {repo.domain && <span>Domain: <code className="text-kathal-400">{repo.domain}</code></span>}
                  {repo.port && <span>Port: <code className="text-gray-300">{repo.port}</code></span>}
                  {repo.last_deploy && <span>Last deploy: {new Date(repo.last_deploy).toLocaleString()}</span>}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => showRepoHistory(repo)}
                  className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-xs text-gray-300"
                >
                  History
                </button>
                <button
                  onClick={() => openEdit(repo)}
                  className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-xs text-gray-300"
                >
                  Edit
                </button>
                <button
                  onClick={() => handleDeploy(repo)}
                  disabled={deploying === repo.id}
                  className="px-4 py-1.5 bg-kathal-600 hover:bg-kathal-500 text-white rounded-lg text-xs font-medium disabled:opacity-50"
                >
                  {deploying === repo.id ? 'Deploying...' : 'Deploy'}
                </button>
                {confirmDeleteId === repo.id ? (
                  <>
                    <button
                      onClick={() => handleDelete(repo.id)}
                      className="px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded-lg text-xs font-medium"
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => setConfirmDeleteId(null)}
                      className="px-2.5 py-1.5 bg-gray-800 text-gray-300 rounded-lg text-xs"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => setConfirmDeleteId(repo.id)}
                    className="px-3 py-1.5 bg-red-600/20 hover:bg-red-600 text-red-400 hover:text-white rounded-lg text-xs"
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add / Edit Modal */}
      {showModal && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
          onClick={() => setShowModal(false)}
        >
          <form
            onSubmit={handleSave}
            onClick={(e) => e.stopPropagation()}
            className="bg-gray-900 border border-gray-800 rounded-2xl p-6 max-w-md w-full space-y-4"
          >
            <h3 className="text-xl font-bold">{editingId ? 'Edit Repository' : 'Add Repository'}</h3>
            <div>
              <label className="block text-xs text-gray-400 mb-1">App Name</label>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="my-app"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-kathal-500 focus:outline-none"
                required
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Git Repository URL</label>
              <input
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                placeholder="https://github.com/user/repo.git"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-kathal-500 focus:outline-none"
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Branch</label>
                <input
                  value={form.branch}
                  onChange={(e) => setForm({ ...form, branch: e.target.value })}
                  placeholder="main"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-kathal-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Port (optional)</label>
                <input
                  type="number"
                  value={form.port}
                  onChange={(e) => setForm({ ...form, port: e.target.value })}
                  placeholder="3000"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm tabular-nums focus:border-kathal-500 focus:outline-none"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Domain (auto-assigned if blank)</label>
              <input
                value={form.domain}
                onChange={(e) => setForm({ ...form, domain: e.target.value })}
                placeholder="myapp.apps.kathal.local"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-kathal-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Build / Deploy Command</label>
              <input
                value={form.deploy_cmd}
                onChange={(e) => setForm({ ...form, deploy_cmd: e.target.value })}
                placeholder="docker compose up -d --build"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono focus:border-kathal-500 focus:outline-none"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowModal(false)}
                className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm text-gray-300"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-kathal-600 hover:bg-kathal-500 text-white rounded-lg text-sm font-medium"
              >
                {editingId ? 'Save Changes' : 'Add Repository'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Deployment Output Modal */}
      {deployOutput && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
          onClick={() => setDeployOutput(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-gray-900 border border-gray-800 rounded-2xl p-6 max-w-2xl w-full"
          >
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-lg font-bold text-green-400">
                  Deployment Complete — {deployOutput.repoName}
                </h3>
                <p className="text-xs text-gray-400 mt-0.5">
                  Commit {deployOutput.commit} · Port {deployOutput.port}
                  {deployOutput.domain ? ` · ${deployOutput.domain}` : ''}
                </p>
              </div>
              <button
                onClick={() => setDeployOutput(null)}
                className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded-lg text-xs text-gray-300"
              >
                Close
              </button>
            </div>
            <pre className="bg-gray-950 border border-gray-800 rounded-xl p-4 text-xs font-mono text-gray-300 whitespace-pre-wrap max-h-80 overflow-y-auto">
              {deployOutput.output}
            </pre>
          </div>
        </div>
      )}

      {/* History Modal */}
      {history && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
          onClick={() => setHistory(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-gray-900 border border-gray-800 rounded-2xl p-6 max-w-xl w-full max-h-[80vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold">Deploy History — {history.name}</h3>
              <button
                onClick={() => setHistory(null)}
                className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded-lg text-xs text-gray-300"
              >
                Close
              </button>
            </div>
            {history.logs.length === 0 ? (
              <p className="text-sm text-gray-500 py-6 text-center">No deployments yet.</p>
            ) : (
              <div className="space-y-3">
                {history.logs.map((log, i) => (
                  <div key={i} className="bg-gray-950 border border-gray-800 rounded-xl p-4">
                    <div className="flex justify-between text-xs mb-2">
                      <span className={log.error ? 'text-red-400 font-semibold' : 'text-green-400 font-semibold'}>
                        {log.error ? 'FAILED' : 'SUCCESS'}
                      </span>
                      <span className="text-gray-500">{new Date(log.timestamp).toLocaleString()}</span>
                    </div>
                    {log.commit && <p className="text-xs text-gray-400 mb-1">Commit: <code>{log.commit}</code></p>}
                    {log.output && (
                      <pre className="text-[11px] font-mono text-gray-400 whitespace-pre-wrap">{log.output}</pre>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
