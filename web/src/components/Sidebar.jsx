import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard,
  Box,
  Package,
  KeyRound,
  HardDrive,
  Layers,
  Terminal,
  Globe,
  Database,
  FolderOpen,
  Archive,
  Store,
  GitBranch,
  Activity,
  ScrollText,
  ShieldCheck,
  Network,
  Settings,
  LogOut,
  X,
} from 'lucide-react'

const navGroups = [
  {
    title: 'Overview',
    items: [
      { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
      { to: '/templates', icon: Store, label: 'App Store' },
      { to: '/containers', icon: Box, label: 'Running Apps' },
      { to: '/compose', icon: Layers, label: 'Compose Stacks' },
    ],
  },
  {
    title: 'Images & Storage',
    items: [
      { to: '/images', icon: Package, label: 'Images' },
      { to: '/registries', icon: KeyRound, label: 'Registries' },
      { to: '/volumes', icon: HardDrive, label: 'Volumes' },
      { to: '/databases', icon: Database, label: 'Databases' },
    ],
  },
  {
    title: 'Routing & Automation',
    items: [
      { to: '/proxy', icon: Globe, label: 'Domains & Proxy' },
      { to: '/git', icon: GitBranch, label: 'Git Deploy' },
      { to: '/env', icon: ShieldCheck, label: 'Environment' },
      { to: '/network', icon: Network, label: 'Networks' },
    ],
  },
  {
    title: 'System & Diagnostics',
    items: [
      { to: '/monitoring', icon: Activity, label: 'Monitoring' },
      { to: '/logs', icon: ScrollText, label: 'Logs' },
      { to: '/files', icon: FolderOpen, label: 'File Manager' },
      { to: '/backups', icon: Archive, label: 'Backups' },
      { to: '/terminal', icon: Terminal, label: 'Terminal' },
      { to: '/settings', icon: Settings, label: 'Settings' },
    ],
  },
]

export default function Sidebar({ user, onLogout, mobileOpen = false, onClose }) {
  const renderLink = (item) => {
    const Icon = item.icon
    return (
      <NavLink
        key={item.to}
        to={item.to}
        end={item.to === '/'}
        onClick={onClose}
        className={({ isActive }) =>
          `flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] font-medium whitespace-nowrap transition-colors duration-150 ${
            isActive
              ? 'bg-kathal-600/15 text-kathal-400'
              : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-100'
          }`
        }
      >
        <Icon className="w-4 h-4 shrink-0" strokeWidth={1.85} />
        <span className="truncate">{item.label}</span>
      </NavLink>
    )
  }

  const sidebarBody = (
    <aside className="w-64 shrink-0 bg-[#0F1521] border-r border-slate-800/80 flex flex-col h-full">
      {/* Brand Header */}
      <div className="h-16 px-5 border-b border-slate-800/80 flex items-center justify-between shrink-0">
        <NavLink to="/" onClick={onClose} className="flex items-center gap-2.5 whitespace-nowrap shrink-0">
          <span className="w-8 h-8 rounded-lg bg-kathal-600 flex items-center justify-center shadow-sm">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <rect x="3" y="4" width="18" height="6" rx="1.5" fill="white" />
              <rect x="3" y="13" width="10" height="7" rx="1.5" fill="white" fillOpacity="0.9" />
              <rect x="16" y="13" width="5" height="7" rx="1.5" fill="white" fillOpacity="0.7" />
            </svg>
          </span>
          <span className="font-display text-lg font-bold tracking-tight text-slate-100">
            KATHAL
          </span>
        </NavLink>

        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation menu"
            className="lg:hidden p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-5 overflow-y-auto" aria-label="Primary Navigation">
        {navGroups.map((group) => (
          <div key={group.title}>
            <p className="px-3 mb-1.5 text-[11px] font-medium text-slate-500">
              {group.title}
            </p>
            <div className="space-y-0.5">{group.items.map(renderLink)}</div>
          </div>
        ))}
      </nav>

      {/* Account Footer */}
      <div className="p-3 border-t border-slate-800/80 shrink-0">
        <div className="flex items-center justify-between px-2 py-1.5 rounded-lg bg-slate-900/60 border border-slate-800/70">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-7 h-7 rounded-md bg-slate-800 border border-slate-700 flex items-center justify-center text-xs font-semibold text-slate-200 shrink-0">
              {(user?.email || 'A')[0].toUpperCase()}
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium text-slate-200 truncate">{user?.email || 'admin'}</p>
              <p className="text-[11px] text-slate-500">Administrator</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onLogout}
            className="p-1.5 rounded-md text-slate-400 hover:text-red-400 hover:bg-slate-800 transition-colors shrink-0"
            title="Sign out"
            aria-label="Sign out"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </aside>
  )

  return (
    <>
      {/* Desktop persistent sidebar */}
      <div className="hidden lg:block h-full">{sidebarBody}</div>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-xs"
            onClick={onClose}
            aria-hidden="true"
          />
          <div className="relative z-10 h-full">{sidebarBody}</div>
        </div>
      )}
    </>
  )
}
