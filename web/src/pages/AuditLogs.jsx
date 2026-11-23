import { useState, useEffect, useCallback } from 'react'
import { ScrollText, Search, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react'
import { apiFetch } from '../hooks/useApi'

export default function AuditLogs() {
  const [result, setResult] = useState({ events: [], total: 0, page: 1, pageSize: 25, totalPages: 1 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [outcome, setOutcome] = useState('')
  const [actionFilter, setActionFilter] = useState('')

  const loadAudit = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const qs = new URLSearchParams({
        paginated: '1',
        page: String(page),
        pageSize: '25',
      })
      if (search.trim()) qs.set('search', search.trim())
      if (outcome) qs.set('outcome', outcome)
      if (actionFilter.trim()) qs.set('action', actionFilter.trim())

      const data = await apiFetch(`/audit?${qs.toString()}`)
      setResult({
        events: Array.isArray(data?.events) ? data.events : [],
        total: Number(data?.total || 0),
        page: Number(data?.page || 1),
        pageSize: Number(data?.pageSize || 25),
        totalPages: Number(data?.totalPages || 1),
      })
    } catch (err) {
      setError(err.message || 'Failed to load audit events.')
    } finally {
      setLoading(false)
    }
  }, [page, search, outcome, actionFilter])

  useEffect(() => {
    loadAudit()
  }, [loadAudit])

  return (
    <div className="p-6 sm:p-8 max-w-7xl mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-slate-100">Audit Trail</h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            Persistent security, authentication, access control, vault, and deployment events.
          </p>
        </div>

        <button
          type="button"
          onClick={loadAudit}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#101A10] text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-900 whitespace-nowrap"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Refresh</span>
        </button>
      </div>

      {/* Filters */}
      <div className="bg-white dark:bg-[#101A10] border border-slate-200 dark:border-slate-800 rounded-xl p-4 grid grid-cols-1 md:grid-cols-4 gap-3">
        <div className="relative md:col-span-2">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => {
              setPage(1)
              setSearch(e.target.value)
            }}
            placeholder="Search actor, action, target, or detail..."
            className="w-full pl-9 pr-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-sm text-slate-900 dark:text-slate-100"
          />
        </div>

        <input
          type="text"
          value={actionFilter}
          onChange={(e) => {
            setPage(1)
            setActionFilter(e.target.value)
          }}
          placeholder="Filter action (e.g. auth.login)"
          className="px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-sm text-slate-900 dark:text-slate-100 font-mono"
        />

        <select
          value={outcome}
          onChange={(e) => {
            setPage(1)
            setOutcome(e.target.value)
          }}
          className="px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-sm text-slate-900 dark:text-slate-100"
        >
          <option value="">All Outcomes</option>
          <option value="success">Success</option>
          <option value="denied">Denied</option>
          <option value="error">Error</option>
        </select>
      </div>

      {error && (
        <div className="p-3.5 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      <div className="bg-white dark:bg-[#101A10] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
        <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
          <div className="flex items-center gap-2">
            <ScrollText className="w-4 h-4 text-kathal-600 dark:text-kathal-400" />
            <span className="font-medium text-slate-800 dark:text-slate-200 tabular-nums">
              {result.total} recorded event{result.total === 1 ? '' : 's'}
            </span>
          </div>
          <span className="tabular-nums">
            Page {result.page} of {result.totalPages}
          </span>
        </div>

        {loading ? (
          <div className="py-12 text-center text-sm text-slate-500">Loading audit events...</div>
        ) : result.events.length === 0 ? (
          <div className="py-12 text-center text-sm text-slate-500">
            No audit events match your current filters.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400">
                  <th className="text-left py-2.5 px-3 font-medium">Timestamp</th>
                  <th className="text-left py-2.5 px-3 font-medium">Actor</th>
                  <th className="text-left py-2.5 px-3 font-medium">Action</th>
                  <th className="text-left py-2.5 px-3 font-medium">Target</th>
                  <th className="text-left py-2.5 px-3 font-medium">IP Address</th>
                  <th className="text-left py-2.5 px-3 font-medium">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {result.events.map((ev) => (
                  <tr
                    key={ev.id}
                    className="border-b border-slate-100 dark:border-slate-800/50 hover:bg-slate-50 dark:hover:bg-slate-900/40"
                  >
                    <td className="py-2.5 px-3 text-slate-500 dark:text-slate-400 tabular-nums whitespace-nowrap">
                      {new Date(ev.timestamp).toLocaleString()}
                    </td>
                    <td className="py-2.5 px-3 font-mono text-slate-800 dark:text-slate-200">{ev.actor}</td>
                    <td className="py-2.5 px-3 font-mono text-slate-900 dark:text-slate-100">{ev.action}</td>
                    <td className="py-2.5 px-3 text-slate-600 dark:text-slate-400 max-w-xs truncate">
                      {ev.target}
                      {ev.detail ? ` · ${ev.detail}` : ''}
                    </td>
                    <td className="py-2.5 px-3 font-mono tabular-nums text-slate-500 dark:text-slate-400">
                      {ev.ip || '127.0.0.1'}
                    </td>
                    <td className="py-2.5 px-3 font-medium capitalize">
                      <span
                        className={
                          ev.outcome === 'success'
                            ? 'text-green-700 dark:text-green-400'
                            : ev.outcome === 'denied'
                            ? 'text-yellow-700 dark:text-yellow-400'
                            : 'text-red-600 dark:text-red-400'
                        }
                      >
                        {ev.outcome}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 text-xs text-slate-700 dark:text-slate-300 disabled:opacity-40"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
            <span>Previous</span>
          </button>
          <button
            type="button"
            disabled={page >= result.totalPages}
            onClick={() => setPage((p) => Math.min(result.totalPages, p + 1))}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 text-xs text-slate-700 dark:text-slate-300 disabled:opacity-40"
          >
            <span>Next</span>
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}
