import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, FileText } from 'lucide-react'
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

  const loadContainers = useCallback(async () => {
    try {
      const data = await apiFetch('/logs/containers')
      const list = Array.isArray(data) ? data : []
      setContainers(list)
      if (list.length > 0 && !selectedContainer) {
        setSelectedContainer(list[0])
      }
    } catch {
      setContainers([])
    }
  }, [selectedContainer])

  useEffect(() => {
    loadContainers()
  }, [loadContainers])

  const loadLogs = useCallback(async (silent = false) => {
    if (!selectedContainer) return
    if (!silent) setLoading(true)
    try {
      const data = await apiFetch(
        `/logs?container=${encodeURIComponent(selectedContainer.id)}&tail=${tail}&filter=${encodeURIComponent(filter)}`
      )
      setLogs(Array.isArray(data) ? data : [])
    } catch {
      // keep existing
    } finally {
      if (!silent) setLoading(false)
    }
  }, [selectedContainer, tail, filter])

  useEffect(() => {
    if (selectedContainer) {
      loadLogs(false)
    }
  }, [selectedContainer, tail, filter, loadLogs])

  useEffect(() => {
    if (!selectedContainer || !follow) return
    const timer = setInterval(() => loadLogs(true), 2000)
    return () => clearInterval(timer)
  }, [selectedContainer, follow, loadLogs])

  async function searchLogs() {
    if (!selectedContainer || !searchQuery) return
    setLoading(true)
    try {
      const data = await apiPost('/logs/search', {
        container: selectedContainer.id,
        query: searchQuery,
        limit: 500,
      })
      setLogs(Array.isArray(data) ? data : [])
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="p-6 sm:p-8 max-w-7xl mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-100">Live App Logs</h1>
          <p className="text-slate-400 text-sm mt-1">
            Inspect real stdout and stderr streams from your running local app processes
          </p>
        </div>
        <button
          onClick={loadContainers}
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-sm text-slate-200 transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          <span>Refresh Apps</span>
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* App List */}
        <div className="bg-[#101A10] border border-slate-800/90 rounded-xl p-4">
          <h2 className="text-sm font-semibold text-slate-300 mb-3">Installed Apps</h2>
          {containers.length === 0 ? (
            <div className="text-center text-slate-500 py-8 text-sm">
              No local apps running yet
            </div>
          ) : (
            <div className="space-y-2 max-h-[65vh] overflow-y-auto">
              {containers.map((c) => {
                const active = selectedContainer?.id === c.id
                const isUp = c.status?.includes('Up')
                return (
                  <button
                    key={c.id}
                    onClick={() => setSelectedContainer(c)}
                    className={`w-full text-left p-3 rounded-lg border transition-colors ${
                      active
                        ? 'bg-kathal-600/20 border-kathal-500/40 text-white'
                        : 'bg-slate-950/60 border-slate-800 text-slate-300 hover:bg-slate-800/60'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${isUp ? 'bg-green-400' : 'bg-slate-500'}`} />
                      <span className="text-sm font-medium truncate">{c.name}</span>
                    </div>
                    <p className="text-xs text-slate-500 mt-1 truncate">{c.image}</p>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Logs View */}
        <div className="lg:col-span-3 bg-[#101A10] border border-slate-800/90 rounded-xl flex flex-col h-[70vh] min-h-[420px]">
          {!selectedContainer ? (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-500 text-sm gap-2">
              <FileText className="w-8 h-8 text-slate-600" />
              <span>Select a local app to stream its logs</span>
            </div>
          ) : (
            <>
              <div className="p-4 border-b border-slate-800 flex flex-wrap items-center gap-3">
                <div>
                  <h3 className="font-semibold text-slate-100">{selectedContainer.name}</h3>
                  <p className="text-xs text-slate-500">{selectedContainer.image}</p>
                </div>

                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer px-2.5 py-1.5 bg-slate-800 rounded-lg">
                    <input
                      type="checkbox"
                      checked={follow}
                      onChange={(e) => setFollow(e.target.checked)}
                      className="accent-kathal-500"
                    />
                    Follow Live
                  </label>
                  <select
                    value={tail}
                    onChange={(e) => setTail(parseInt(e.target.value, 10))}
                    className="px-2.5 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-slate-200"
                  >
                    <option value={50}>50 lines</option>
                    <option value={100}>100 lines</option>
                    <option value={500}>500 lines</option>
                  </select>
                  <input
                    type="text"
                    placeholder="Filter..."
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    className="px-2.5 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-slate-200 w-36"
                  />
                  <input
                    type="text"
                    placeholder="Search..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && searchLogs()}
                    className="px-2.5 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-slate-200 w-36"
                  />
                  <button
                    onClick={searchLogs}
                    disabled={!searchQuery || loading}
                    className="px-3 py-1.5 bg-kathal-600 hover:bg-kathal-500 text-white rounded-lg text-xs font-medium disabled:opacity-50"
                  >
                    Search
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed bg-slate-950/60">
                {loading ? (
                  <div className="text-slate-500 text-center py-8">Loading process logs...</div>
                ) : logs.length === 0 ? (
                  <div className="text-slate-500 text-center py-8">No log lines captured yet</div>
                ) : (
                  logs.map((line, i) => (
                    <div
                      key={i}
                      className={`py-1 border-b border-slate-900 break-words ${
                        line.stream === 'stderr' ? 'text-red-400' : 'text-slate-300'
                      }`}
                    >
                      <span className="text-slate-600 mr-2 tabular-nums">
                        {line.timestamp ? new Date(line.timestamp).toLocaleTimeString() : ''}
                      </span>
                      <span className="text-slate-500 mr-2 uppercase text-[10px]">{line.stream}</span>
                      <span>{line.content}</span>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}