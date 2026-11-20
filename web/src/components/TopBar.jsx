import { useLocation } from 'react-router-dom'
import { Menu, Rocket } from 'lucide-react'

const ROUTE_META = {
  '/': { section: 'Overview', title: 'Dashboard', hint: 'Server health, running apps, and quick actions' },
  '/templates': { section: 'Overview', title: 'App Store', hint: 'One-click apps ready to run with zero setup' },
  '/containers': { section: 'Overview', title: 'Running Apps', hint: 'Start, stop, restart, or inspect logs for your apps' },
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

export default function TopBar({ onOpenMobileNav, onOpenQuickLaunch }) {
  const location = useLocation()
  const meta = ROUTE_META[location.pathname] || ROUTE_META['/']

  return (
    <header className="h-16 px-4 sm:px-8 border-b border-slate-800/80 bg-[#0D121C]/90 backdrop-blur-sm flex items-center justify-between gap-4 shrink-0 sticky top-0 z-30">
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

      <button
        type="button"
        onClick={onOpenQuickLaunch}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-kathal-600 hover:bg-kathal-500 text-white text-sm font-medium whitespace-nowrap shrink-0 transition-colors"
      >
        <Rocket className="w-4 h-4" />
        <span>Launch App</span>
      </button>
    </header>
  )
}
