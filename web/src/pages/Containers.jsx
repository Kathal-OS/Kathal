import { useState, useEffect, useCallback } from 'react'
import { useApi, apiPost, apiDelete } from '../hooks/useApi'

function ContainerRow({ container, onRefresh }) {
  const [loading, setLoading] = useState(false)

  const action = async (fn) => {
    setLoading(true)
    try { await fn() } catch {}
    setLoading(false)
    onRefresh()
  }

  const stateColor = {
    running: 'bg-green-500',
    exited: 'bg-gray-500',
    paused: 'bg-yellow-500',
  }

  return (
    <tr className="border-b border-gray-800 hover:bg-gray-900/50">
      <td className="py-3 px-4">
        <div className="flex items-center gap-3">
          <span className={`w-2.5 h-2.5 rounded-full ${stateColor[container.state] || 'bg-gray-500'}`}></span>
          <div>
            <p className="font-medium">{container.name || container.id}</p>
            <p className="text-xs text-gray-600">{container.image}</p>
          </div>
        </div>
      </td>
      <td className="py-3 px-4">
        <span className={`text-sm ${
          container.state === 'running' ? 'text-green-400' : 'text-gray-500'
        }`}>
          {container.state}
        </span>
      </td>
      <td className="py-3 px-4">
        {container.ports?.map((p, i) => (
          <span key={i} className="inline-block bg-gray-800 rounded px-2 py-0.5 text-xs mr-1 mb-1">
            {p.hostPort}:{p.containerPort}
          </span>
        ))}
      </td>
      <td className="py-3 px-4">
        <div className="flex gap-2">
          {container.state !== 'running' && (
            <button
              onClick={() => action(() => apiPost(`/containers/${container.id}/start`))}
              disabled={loading}
              className="px-3 py-1 bg-green-600 hover:bg-green-700 rounded text-xs transition-colors disabled:opacity-50"
            >
              ▶ Start
            </button>
          )}
          {container.state === 'running' && (
            <>
              <button
                onClick={() => action(() => apiPost(`/containers/${container.id}/stop`))}
                disabled={loading}
                className="px-3 py-1 bg-yellow-600 hover:bg-yellow-700 rounded text-xs transition-colors disabled:opacity-50"
              >
                ⏹ Stop
              </button>
              <button
                onClick={() => action(() => apiPost(`/containers/${container.id}/restart`))}
                disabled={loading}
                className="px-3 py-1 bg-blue-600 hover:bg-blue-700 rounded text-xs transition-colors disabled:opacity-50"
              >
                🔄
              </button>
            </>
          )}
          <button
            onClick={() => {
              if (confirm('Delete this container?'))
                action(() => apiDelete(`/containers/${container.id}/delete`))
            }}
            disabled={loading}
            className="px-3 py-1 bg-red-600/20 hover:bg-red-600 text-red-400 hover:text-white rounded text-xs transition-colors disabled:opacity-50"
          >
            🗑
          </button>
        </div>
      </td>
    </tr>
  )
}

export default function Containers() {
  const { data: status } = useApi('/status')
  const [containers, setContainers] = useState([])
  const [loading, setLoading] = useState(true)

  const fetchContainers = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/containers?all=true', {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('kathal_token')}`,
        },
      })
      const data = await res.json()
      // Handle both array and object response (Docker unavailable returns object).
      if (Array.isArray(data)) {
        setContainers(data)
      } else if (data.containers) {
        setContainers(data.containers)
      } else {
        setContainers([])
      }
    } catch {
      setContainers([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchContainers() }, [fetchContainers])

  const dockerAvailable = status?.dockerAvailable || false

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">Containers</h1>
          <p className="text-gray-500 mt-1">
            {dockerAvailable ? `${containers.length} containers` : 'Docker not available'}
          </p>
        </div>
        {dockerAvailable && (
          <button
            onClick={fetchContainers}
            className="px-4 py-2 bg-kathal-600 hover:bg-kathal-700 rounded-lg text-sm font-medium transition-colors"
          >
            🔄 Refresh
          </button>
        )}
      </div>

      {!dockerAvailable ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-12 text-center">
          <span className="text-6xl mb-4 block">🐳</span>
          <h2 className="text-xl font-semibold mb-2">Docker Not Available</h2>
          <p className="text-gray-500 max-w-md mx-auto mb-6">
            Install Docker to manage containers from the dashboard.
            KATHAL is running in system-only mode.
          </p>
          <div className="space-y-2 text-sm text-gray-600">
            <p><strong>Windows:</strong> Install Docker Desktop</p>
            <p><strong>Mac:</strong> Install Docker Desktop or <code>brew install docker</code></p>
            <p><strong>Linux:</strong> <code>sudo apt-get install docker.io</code></p>
          </div>
        </div>
      ) : loading ? (
        <div className="text-center py-12 text-gray-500">Loading containers...</div>
      ) : containers.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-12 text-center">
          <span className="text-6xl mb-4 block">📦</span>
          <h2 className="text-xl font-semibold mb-2">No Containers</h2>
          <p className="text-gray-500">Deploy your first app from the Dashboard.</p>
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-800/50">
              <tr>
                <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">Container</th>
                <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">Status</th>
                <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">Ports</th>
                <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">Actions</th>
              </tr>
            </thead>
            <tbody>
              {containers.map(c => (
                <ContainerRow key={c.id} container={c} onRefresh={fetchContainers} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
