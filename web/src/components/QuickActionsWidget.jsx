import { useState } from 'react'
import { Trash2, RefreshCw } from 'lucide-react'
import { apiFetch, apiPost } from '../hooks/useApi'

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i]
}

export default function QuickActionsWidget({ onPruned }) {
  const [confirmingPrune, setConfirmingPrune] = useState(false)
  const [pruning, setPruning] = useState(false)
  const [pruneFeedback, setPruneFeedback] = useState(null)

  const [checkingUpdates, setCheckingUpdates] = useState(false)
  const [updateResult, setUpdateResult] = useState(null)
  const [updateError, setUpdateError] = useState(null)

  const handlePruneStopped = async () => {
    if (!confirmingPrune) {
      setConfirmingPrune(true)
      setPruneFeedback(null)
      return
    }

    setPruning(true)
    setPruneFeedback(null)
    try {
      const res = await apiPost('/containers/prune', {})
      const deleted = Number(res?.containers_deleted || 0)
      const reclaimed = formatBytes(res?.space_reclaimed_bytes || 0)
      setPruneFeedback({
        type: 'success',
        text:
          deleted > 0
            ? `Cleaned up ${deleted} stopped app${deleted === 1 ? '' : 's'} (${reclaimed} reclaimed).`
            : 'Everything is already tidy — no stopped apps to remove.',
      })
      setConfirmingPrune(false)
      if (onPruned) onPruned()
    } catch (err) {
      setPruneFeedback({
        type: 'error',
        text: err.message || 'Failed to clean up stopped apps.',
      })
    } finally {
      setPruning(false)
    }
  }

  const handleCheckUpdates = async () => {
    setCheckingUpdates(true)
    setUpdateError(null)
    try {
      const res = await apiFetch('/system/updates')
      setUpdateResult(res)
    } catch (err) {
      setUpdateError(err.message || 'Failed to check for updates.')
    } finally {
      setCheckingUpdates(false)
    }
  }

  return (
    <section className="bg-[#111827] border border-slate-800/90 rounded-xl p-6">
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-slate-100">Quick Maintenance</h2>
        <p className="text-xs text-slate-400 mt-0.5">
          One-click housekeeping to keep your server tidy and up to date
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 divide-y md:divide-y-0 md:divide-x divide-slate-800/80">
        {/* Prune All Stopped Containers */}
        <div className="flex flex-col justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-slate-100">Clean Up Stopped Apps</p>
            <p className="text-xs text-slate-400 mt-1">
              Safely remove exited containers you are no longer using to free up disk space.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handlePruneStopped}
              disabled={pruning}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors disabled:opacity-50 ${
                confirmingPrune
                  ? 'bg-red-600 hover:bg-red-500 text-white'
                  : 'bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200'
              }`}
            >
              <Trash2 className="w-4 h-4" />
              <span>
                {pruning
                  ? 'Cleaning...'
                  : confirmingPrune
                  ? 'Confirm Prune Stopped'
                  : 'Prune All Stopped Containers'}
              </span>
            </button>

            {confirmingPrune && !pruning && (
              <button
                type="button"
                onClick={() => setConfirmingPrune(false)}
                className="px-3 py-2 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-300"
              >
                Cancel
              </button>
            )}
          </div>

          {pruneFeedback && (
            <div
              className={`p-2.5 rounded-lg text-xs border ${
                pruneFeedback.type === 'error'
                  ? 'bg-red-500/10 border-red-500/30 text-red-400'
                  : 'bg-green-500/10 border-green-500/30 text-green-400'
              }`}
            >
              {pruneFeedback.text}
            </div>
          )}
        </div>

        {/* Check for Updates */}
        <div className="flex flex-col justify-between gap-3 pt-4 md:pt-0 md:pl-6">
          <div>
            <p className="text-sm font-medium text-slate-100">Check for Updates</p>
            <p className="text-xs text-slate-400 mt-1">
              Verify your control panel version and scan installed app images for newer releases.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCheckUpdates}
              disabled={checkingUpdates}
              className="inline-flex items-center gap-2 px-4 py-2 bg-kathal-600 hover:bg-kathal-500 text-white rounded-lg text-sm font-medium whitespace-nowrap transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${checkingUpdates ? 'animate-spin' : ''}`} />
              <span>{checkingUpdates ? 'Checking...' : 'Check for Updates'}</span>
            </button>
          </div>

          {updateError && (
            <div className="p-2.5 rounded-lg text-xs bg-red-500/10 border border-red-500/30 text-red-400">
              {updateError}
            </div>
          )}

          {updateResult && (
            <div className="p-3 rounded-lg text-xs bg-green-500/10 border border-green-500/30 text-green-300 space-y-1">
              <div className="flex items-center justify-between font-medium text-green-400">
                <span>
                  {updateResult.updateAvailable
                    ? `Update available: v${updateResult.latestVersion}`
                    : `Up to date (v${updateResult.currentVersion})`}
                </span>
                <span className="text-[11px] text-slate-400 tabular-nums">
                  {updateResult.checkedAt ? new Date(updateResult.checkedAt).toLocaleTimeString() : ''}
                </span>
              </div>
              <p className="text-slate-300">{updateResult.message}</p>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
