import { Link } from 'react-router-dom'
import { ShieldAlert, ArrowLeft } from 'lucide-react'

export default function AccessDenied({ requiredPermission = '', user = null }) {
  const roleLabel = Array.isArray(user?.roles) && user.roles.length > 0 ? user.roles.join(', ') : user?.role || 'Viewer'

  return (
    <div className="p-6 sm:p-10 max-w-2xl mx-auto">
      <div className="bg-white dark:bg-[#101A10] border border-slate-200 dark:border-slate-800 rounded-2xl p-8 space-y-5">
        <div className="w-12 h-12 rounded-xl bg-red-500/10 border border-red-500/30 flex items-center justify-center text-red-600 dark:text-red-400">
          <ShieldAlert className="w-6 h-6" />
        </div>

        <div className="space-y-2">
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">Access Restricted</h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
            Your current account role does not include permission to view or operate this section.
            Contact a workspace Owner or Administrator if your team requires elevated access.
          </p>
        </div>

        <div className="py-3 px-4 rounded-xl bg-slate-50 dark:bg-slate-900/70 border border-slate-200 dark:border-slate-800 text-xs space-y-1.5">
          <div className="flex items-center justify-between gap-4">
            <span className="text-slate-500 dark:text-slate-400">Signed-in role</span>
            <span className="font-medium text-slate-900 dark:text-slate-200">{roleLabel}</span>
          </div>
          {requiredPermission && (
            <div className="flex items-center justify-between gap-4">
              <span className="text-slate-500 dark:text-slate-400">Required permission</span>
              <code className="font-mono text-red-600 dark:text-red-400">{requiredPermission}</code>
            </div>
          )}
        </div>

        <div className="pt-1">
          <Link
            to="/"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-kathal-600 hover:bg-kathal-500 text-white text-sm font-medium transition-colors whitespace-nowrap"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Back to Dashboard</span>
          </Link>
        </div>
      </div>
    </div>
  )
}
