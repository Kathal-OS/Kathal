import { useState } from 'react'
import { useLocation, Link } from 'react-router-dom'
import { Menu, Rocket, ArrowUpCircle, X } from 'lucide-react'

const ROUTE_META = {
  '/': { section: 'Overview', title: 'Dashboard', hint: 'Server health, running apps, and quick actions' },
  '/templates': { section: 'Overview', title: 'App Store', hint: 'One-click apps ready to run with zero setup' },
  '/containers': { section: 'Overview', title: 'Running Apps', hint: 'Start, stop, restart, or inspect logs for your apps' },
  '/processes': { section: 'Overview', title: 'Native Processes', hint: 'Live host PIDs, CPU%, memory usage, and uptime' },
  '/compose': { section: 'Overview', title: 'Compose Stacks', hint: 'Multi-service app groups parsed from Compose files' },
  '/images': { section: 'Images & Storage', title: 'Images', hint: 'Downloaded app packages and disk cleanup' },
  '/registries': { section: 'Images & Storage', title: 'Registries', hint: 'Saved login credentials for private registries' },
  '/volumes': { section: 'Images & Storage', title: 'Volumes', hint: 'Persistent data folders kept safe across restarts' },
  '/databases': { section: 'Images & Storage', title: 'Databases', hint: 'Managed PostgreSQL, MySQL, MongoDB, and Redis' },
  '/proxy': { section: 'Routing & Automation', title: 'Domains & Proxy', hint: 'Connect friendly web addresses and HTTPS to your apps' },
  '/git': { section: 'Routing & Automation', title: 'Git Deploy', hint: 'Auto-build and deploy directly from a Git repository' },
  '/env': { section: 'Routing & Automation', title: 'Environment', hint: 'Shared variables and secrets injected into apps' },
  '/network': { section: 'Routing & Automation', title: 'Networks', hint: 'Private virtual networks connecting your containers' },
  '/monitoring': { section: 'System & Diagnostics', title: 'Monitoring', hint: 'Live CPU, memory, disk, and network charts' },
  '/logs': { section: 'System & Diagnostics', title: 'Logs', hint: 'Search live output from any running app' },
  '/files': { section: 'System & Diagnostics', title: 'File Manager', hint: 'Browse and edit files directly in your workspace' },
  '/backups': { section: 'System & Diagnostics', title: 'Backups', hint: 'Create, restore, and export full configuration snapshots' },
  '/terminal': { section: 'System & Diagnostics', title: 'Terminal', hint: 'Interactive shell access inside your server' },
  '/settings': { section: 'System & Diagnostics', title: 'Settings', hint: 'Domain defaults, SSL, alerts, and deployment rules' },
}

export default function TopBar({ onOpenMobileNav, onOpenQuickLaunch, updateInfo }) {
  const location = useLocation()
  const [dismissedVersion, setDismissedVersion] = useState(null)
  const meta =
    ROUTE_META[location.pathname] ||
    (location.pathname.startsWith('/templates/') ? ROUTE_META['/templates'] : ROUTE_META['/'])

  const showUpdateNotice =
    Boolean(updateInfo?.updateAvailable && updateInfo?.latestVersion) &&
    dismissedVersion !== updateInfo.latestVersion

  return (
    <header className="h-16 px-4 sm:px-8 border-b border-slate-800/80 bg-[#0A100A]/90 backdrop-blur-sm flex items-center justify-between gap-4 shrink-0 sticky top-0 z-30">
      <div className="flex items-center gap-3 min-w-0">
        <button
          type="button"
          onClick={onOpenMobileNav}
          aria-label="Open navigation menu"
          className="lg:hidden p-2 -ml-1 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800"
        >
          <Menu className="w-5 h-5" />
        </button>

        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs text-slate-400 whitespace-nowrap">
            <span>{meta.section}</span>
            <span aria-hidden="true" className="text-slate-600">/</span>
            <span className="text-slate-100 font-medium">{meta.title}</span>
          </div>
          <p className="hidden md:block text-xs text-slate-500 truncate mt-0.5">{meta.hint}</p>
        </div>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        {showUpdateNotice && (
          <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-yellow-500/15 border border-yellow-500/35 text-yellow-300 text-xs">
            <ArrowUpCircle className="w-3.5 h-3.5 text-yellow-400 shrink-0" />
            <Link to="/settings" className="font-medium hover:text-yellow-200 whitespace-nowrap">
              Update v{updateInfo.latestVersion} available
            </Link>
            <button
              type="button"
              onClick={() => setDismissedVersion(updateInfo.latestVersion)}
              aria-label="Dismiss update notification"
              className="p-0.5 rounded hover:bg-yellow-500/20 text-yellow-400/80 hover:text-yellow-200"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        )}

        <button
          type="button"
          onClick={onOpenQuickLaunch}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-kathal-600 hover:bg-kathal-500 text-white text-sm font-medium whitespace-nowrap shrink-0 transition-colors"
        >
          <Rocket className="w-4 h-4" />
          <span>Launch App</span>
        </button>
      </div>
    </header>
  )
}
