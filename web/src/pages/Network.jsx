import { useState, useEffect, useCallback } from 'react'
import { apiFetch, apiPost, apiDelete } from '../hooks/useApi'

export default function Network() {
  const [tab, setTab] = useState('networks')
  const [networks, setNetworks] = useState([])
  const [volumes, setVolumes] = useState([])
  const [loading, setLoading] = useState(true)
  const [showCreateNetwork, setShowCreateNetwork] = useState(false)
  const [showCreateVolume, setShowCreateVolume] = useState(false)
  const [netForm, setNetForm] = useState({ name: '', driver: 'bridge', internal: false, attachable: true, enableIPv6: false })
  const [volForm, setVolForm] = useState({ name: '', driver: 'local' })
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [confirmPrune, setConfirmPrune] = useState(false)
  const [feedback, setFeedback] = useState(null)

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [nets, vols] = await Promise.all([apiFetch('/network'), apiFetch('/volumes')])
      setNetworks(Array.isArray(nets) ? nets : [])
      setVolumes(Array.isArray(vols) ? vols : [])
    } catch {
      // keep existing
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  async function createNetwork(e) {
    e.preventDefault()
    setFeedback(null)
    try {
      await apiPost('/network', netForm)
      setShowCreateNetwork(false)
      setFeedback({ type: 'success', text: `Created network "${netForm.name}".` })
      setNetForm({ name: '', driver: 'bridge', internal: false, attachable: true, enableIPv6: false })
      loadData()
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to create network' })
    }
  }

  async function createVolume(e) {
    e.preventDefault()
    setFeedback(null)
    try {
      const vol = await apiPost('/volumes', volForm)
      setShowCreateVolume(false)
      setFeedback({ type: 'success', text: `Created volume "${vol.name}".` })
      setVolForm({ name: '', driver: 'local' })
      loadData()
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to create volume' })
    }
  }

  async function deleteNetwork(name) {
    setFeedback(null)
    try {
      await apiDelete('/network/' + encodeURIComponent(name))
      setConfirmDelete(null)
      setFeedback({ type: 'success', text: `Deleted network "${name}".` })
      loadData()
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Delete failed' })
    }
  }

  async function deleteVolume(name) {
    setFeedback(null)
    try {
      await apiDelete('/volumes/' + encodeURIComponent(name))
      setConfirmDelete(null)
      setFeedback({ type: 'success', text: `Deleted volume "${name}".` })
      loadData()
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Delete failed' })
    }
  }

  async function pruneNetworks() {
    setFeedback(null)
    try {
      const res = await apiPost('/network/prune', {})
      setConfirmPrune(false)
      setFeedback({ type: 'success', text: `Pruned ${res.networks_deleted || 0} unused network(s).` })
      loadData()
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Prune failed' })
    }
  }

  async function pruneVolumes() {
    setFeedback(null)
    try {
      const res = await apiPost('/volumes/prune', {})
      setConfirmPrune(false)
      const mb = Math.round((res.space_reclaimed_bytes || 0) / 1048576)
      setFeedback({ type: 'success', text: `Pruned unused volumes (${mb} MB reclaimed).` })
      loadData()
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Prune failed' })
    }
  }

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold">Networks &amp; Volumes</h1>
        <p className="text-gray-500 mt-1">Manage isolated container networks and persistent storage volumes</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-900 border border-gray-800 p-1 rounded-xl mb-6">
        <button
          onClick={() => { setTab('networks'); setConfirmDelete(null); setConfirmPrune(false) }}
          className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-colors ${
            tab === 'networks' ? 'bg-kathal-600 text-white' : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          🌐 Networks ({networks.length})
        </button>
        <button
          onClick={() => { setTab('volumes'); setConfirmDelete(null); setConfirmPrune(false) }}
          className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-colors ${
            tab === 'volumes' ? 'bg-kathal-600 text-white' : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          💾 Volumes ({volumes.length})
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

      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <button
          onClick={loadData}
          disabled={loading}
          className="px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-sm text-gray-300 disabled:opacity-50"
        >
          🔄 Refresh
        </button>
        <div className="flex items-center gap-2">
          {confirmPrune ? (
            <>
              <button
                onClick={tab === 'networks' ? pruneNetworks : pruneVolumes}
                className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg text-sm font-medium"
              >
                Confirm Prune Unused
              </button>
              <button
                onClick={() => setConfirmPrune(false)}
                className="px-3 py-2 bg-gray-800 text-gray-300 rounded-lg text-sm"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              onClick={() => setConfirmPrune(true)}
              className="px-4 py-2 bg-red-600/20 hover:bg-red-600 text-red-400 hover:text-white rounded-lg text-sm transition-colors"
            >
              Prune Unused
            </button>
          )}
          <button
            onClick={() => (tab === 'networks' ? setShowCreateNetwork(true) : setShowCreateVolume(true))}
            className="px-4 py-2 bg-kathal-600 hover:bg-kathal-500 text-white rounded-lg text-sm font-medium"
          >
            {tab === 'networks' ? '+ Create Network' : '+ Create Volume'}
          </button>
        </div>
      </div>

      {tab === 'networks' ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl divide-y divide-gray-800">
          {loading ? (
            <div className="p-10 text-center text-gray-500">Loading networks...</div>
          ) : networks.length === 0 ? (
            <div className="p-12 text-center text-gray-500">No networks found</div>
          ) : (
            networks.map((n) => (
              <div key={n.id} className="p-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="bg-gray-950 border border-gray-800 px-2.5 py-1 rounded text-sm font-mono text-gray-100">
                      {n.name}
                    </code>
                    <span className="bg-green-600/20 text-green-400 px-2 py-0.5 rounded text-xs">{n.driver}</span>
                    {n.internal && <span className="bg-yellow-600/20 text-yellow-400 px-2 py-0.5 rounded text-xs">Internal</span>}
                    {n.attachable && <span className="bg-purple-600/20 text-purple-400 px-2 py-0.5 rounded text-xs">Attachable</span>}
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    ID: {n.id} · Scope: {n.scope} · {n.containers?.length || 0} containers
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {confirmDelete === `net:${n.name}` ? (
                    <>
                      <button onClick={() => deleteNetwork(n.name)} className="px-3 py-1 bg-red-600 text-white rounded text-xs font-medium">
                        Confirm
                      </button>
                      <button onClick={() => setConfirmDelete(null)} className="px-2.5 py-1 bg-gray-800 text-gray-300 rounded text-xs">
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(`net:${n.name}`)}
                      className="px-3 py-1 bg-red-600/20 hover:bg-red-600 text-red-400 hover:text-white rounded text-xs transition-colors"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl divide-y divide-gray-800">
          {loading ? (
            <div className="p-10 text-center text-gray-500">Loading volumes...</div>
          ) : volumes.length === 0 ? (
            <div className="p-12 text-center text-gray-500">No volumes found</div>
          ) : (
            volumes.map((v) => (
              <div key={v.name} className="p-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <code className="bg-gray-950 border border-gray-800 px-2.5 py-1 rounded text-sm font-mono text-gray-100">
                      {v.name}
                    </code>
                    <span className="bg-blue-600/20 text-blue-400 px-2 py-0.5 rounded text-xs">{v.driver}</span>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    Mountpoint: {v.mountpoint} · Scope: {v.scope}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {confirmDelete === `vol:${v.name}` ? (
                    <>
                      <button onClick={() => deleteVolume(v.name)} className="px-3 py-1 bg-red-600 text-white rounded text-xs font-medium">
                        Confirm
                      </button>
                      <button onClick={() => setConfirmDelete(null)} className="px-2.5 py-1 bg-gray-800 text-gray-300 rounded text-xs">
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(`vol:${v.name}`)}
                      className="px-3 py-1 bg-red-600/20 hover:bg-red-600 text-red-400 hover:text-white rounded text-xs transition-colors"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Create Network Modal */}
      {showCreateNetwork && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={() => setShowCreateNetwork(false)}>
          <form onSubmit={createNetwork} onClick={(e) => e.stopPropagation()} className="bg-gray-900 border border-gray-800 rounded-2xl p-6 max-w-md w-full space-y-4">
            <h3 className="text-xl font-bold">Create Network</h3>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Name</label>
              <input
                value={netForm.name}
                onChange={(e) => setNetForm({ ...netForm, name: e.target.value })}
                placeholder="my-network"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-kathal-500 focus:outline-none"
                required
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Driver</label>
              <select
                value={netForm.driver}
                onChange={(e) => setNetForm({ ...netForm, driver: e.target.value })}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-kathal-500 focus:outline-none"
              >
                <option value="bridge">bridge</option>
                <option value="overlay">overlay</option>
                <option value="macvlan">macvlan</option>
                <option value="ipvlan">ipvlan</option>
              </select>
            </div>
            <div className="flex gap-4 text-xs text-gray-300">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={netForm.internal} onChange={(e) => setNetForm({ ...netForm, internal: e.target.checked })} />
                Internal
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={netForm.attachable} onChange={(e) => setNetForm({ ...netForm, attachable: e.target.checked })} />
                Attachable
              </label>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setShowCreateNetwork(false)} className="px-4 py-2 bg-gray-800 rounded-lg text-sm text-gray-300">
                Cancel
              </button>
              <button type="submit" className="px-4 py-2 bg-kathal-600 hover:bg-kathal-500 text-white rounded-lg text-sm font-medium">
                Create
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Create Volume Modal */}
      {showCreateVolume && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={() => setShowCreateVolume(false)}>
          <form onSubmit={createVolume} onClick={(e) => e.stopPropagation()} className="bg-gray-900 border border-gray-800 rounded-2xl p-6 max-w-md w-full space-y-4">
            <h3 className="text-xl font-bold">Create Volume</h3>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Name (optional)</label>
              <input
                value={volForm.name}
                onChange={(e) => setVolForm({ ...volForm, name: e.target.value })}
                placeholder="auto-generated if empty"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-kathal-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Driver</label>
              <select
                value={volForm.driver}
                onChange={(e) => setVolForm({ ...volForm, driver: e.target.value })}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-kathal-500 focus:outline-none"
              >
                <option value="local">local</option>
                <option value="nfs">nfs</option>
                <option value="tmpfs">tmpfs</option>
              </select>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setShowCreateVolume(false)} className="px-4 py-2 bg-gray-800 rounded-lg text-sm text-gray-300">
                Cancel
              </button>
              <button type="submit" className="px-4 py-2 bg-kathal-600 hover:bg-kathal-500 text-white rounded-lg text-sm font-medium">
                Create
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}