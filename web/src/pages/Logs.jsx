import { useState, useEffect } from 'react'
import { apiFetch, apiPost } from '../hooks/useApi'

export default function Logs() {
  const [containers, setContainers] = useState([])
  const [logs, setLogs] = useState([])
  const [selectedContainer, setSelectedContainer] = useState(null)
  const [loading, setLoading] = useState(false)
  const [tail, setTail] = useState(100)
  const [filter, setFilter] = useState('')
  const [follow, setFollow] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  useEffect(() => {
    loadContainers()
  }, [])

  useEffect(() => {
    if (selectedContainer && !follow) {
      loadLogs()
    }
  }, [selectedContainer, tail, filter])

  async function loadContainers() {
    try {
      const data = await apiFetch('/api/v1/logs/containers')
      setContainers(data || [])
    } catch (e) {
      console.error(e)
    }
  }

  async function loadLogs() {
    if (!selectedContainer) return
    setLoading(true)
    try {
      const data = await apiFetch(`/api/v1/logs?container=${selectedContainer.id}&tail=${tail}&filter=${encodeURIComponent(filter)}`)
      setLogs(data || [])
    } catch (e) {
      console.error(e)
    }
    setLoading(false)
  }

  async function searchLogs() {
    if (!selectedContainer || !searchQuery) return
    setLoading(true)
    try {
      const data = await apiPost('/api/v1/logs/search', {
        container: selectedContainer.id,
        query: searchQuery,
        limit: 500
      })
      setLogs(data || [])
    } catch (e) {
      console.error(e)
    }
    setLoading(false)
  }

  function formatTime(ts) {
    if (!ts) return ''
    return new Date(ts).toLocaleTimeString()
  }

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h2 style={{ margin: 0 }}>Container Logs</h2>
        <button onClick={loadContainers} disabled={loading}
          style={{ padding: '8px 16px', background: '#3b82f6', border: 'none', borderRadius: 6, color: 'white', cursor: 'pointer' }}>
          Refresh Containers
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 24 }}>
        {/* Container List */}
        <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: 16 }}>
          <h3 style={{ margin: '0 0 16px' }}>Containers</h3>
          {loading && <div style={{ textAlign: 'center', color: '#64748b', padding: 20 }}>Loading...</div>}
          {!loading && containers.length === 0 && (
            <div style={{ textAlign: 'center', color: '#64748b', padding: 20 }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>📦</div>
              No containers found
            </div>
          )}
          <div style={{ maxHeight: 'calc(100vh - 200px)', overflow: 'auto' }}>
            {containers.map(c => (
              <button
                key={c.id}
                onClick={() => setSelectedContainer(c)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '12px',
                  marginBottom: 8,
                  background: selectedContainer?.id === c.id ? '#3b82f6' : '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: 8,
                  color: 'white',
                  cursor: 'pointer',
                  transition: 'background 0.2s'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 16 }}>
                    {c.status?.includes('Up') ? '🟢' : c.status?.includes('Exited') ? '🔴' : '⚪'}
                  </span>
                  <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {c.name}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
                  {c.image} · {c.id}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Logs View */}
        <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 12, display: 'flex', flexDirection: 'column', height: 'calc(100vh - 180px)', minHeight: 400 }}>
          {!selectedContainer ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b' }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 48, marginBottom: 16 }}>📋</div>
                <p>Select a container to view logs</p>
              </div>
            </div>
          ) : (
            <>
              {/* Header */}
              <div style={{ padding: 16, borderBottom: '1px solid #334155', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 20 }}>{selectedContainer.status?.includes('Up') ? '🟢' : '🔴'}</span>
                  <div>
                    <h3 style={{ margin: 0, fontSize: 16 }}>{selectedContainer.name}</h3>
                    <p style={{ margin: 0, fontSize: 12, color: '#94a3b8' }}>{selectedContainer.image} · {selectedContainer.id}</p>
                  </div>
                </div>

                <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#94a3b8' }}>
                    <input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)} />
                    Follow
                  </label>
                  <select value={tail} onChange={e => setTail(parseInt(e.target.value))}
                    style={{ padding: '6px 10px', background: '#0f172a', border: '1px solid #334155', borderRadius: 6, color: 'white', fontSize: 13 }}>
                    <option value={50}>50 lines</option>
                    <option value={100}>100 lines</option>
                    <option value={500}>500 lines</option>
                    <option value={1000}>1000 lines</option>
                  </select>
                  <input
                    type="text"
                    placeholder="Filter..."
                    value={filter}
                    onChange={e => setFilter(e.target.value)}
                    style={{ padding: '6px 10px', background: '#0f172a', border: '1px solid #334155', borderRadius: 6, color: 'white', fontSize: 13, width: 160 }}
                  />
                  <input
                    type="text"
                    placeholder="Search..."
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && searchLogs()}
                    style={{ padding: '6px 10px', background: '#0f172a', border: '1px solid #334155', borderRadius: 6, color: 'white', fontSize: 13, width: 180 }}
                  />
                  <button onClick={searchLogs} disabled={!searchQuery || loading}
                    style={{ padding: '6px 12px', background: '#3b82f6', border: 'none', borderRadius: 6, color: 'white', cursor: 'pointer', fontSize: 13 }}>
                    Search
                  </button>
                </div>
              </div>

              {/* Logs */}
              <div style={{ flex: 1, overflow: 'auto', padding: 16, fontFamily: 'monospace', fontSize: 12, lineHeight: 1.6 }}>
                {loading ? (
                  <div style={{ color: '#64748b', textAlign: 'center', padding: 40 }}>Loading logs...</div>
                ) : logs.length === 0 ? (
                  <div style={{ color: '#64748b', textAlign: 'center', padding: 40 }}>No logs found</div>
                ) : (
                  <div>
                    {logs.map((line, i) => (
                      <div key={i} style={{
                        padding: '2px 0',
                        color: line.stream === 'stderr' ? '#f87171' : '#cbd5e1',
                        borderBottom: '1px solid #1e293b',
                        wordBreak: 'break-word'
                      }}>
                        <span style={{ color: '#64748b', marginRight: 8 }}>{formatTime(line.timestamp)}</span>
                        <span style={{ color: '#94a3b8', marginRight: 8, textTransform: 'uppercase', fontSize: 10 }}>{line.stream}</span>
                        <span>{line.content}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}