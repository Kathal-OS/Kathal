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
  Cpu,
} from 'lucide-react'
import PWAInstallButton from './PWAInstallButton'

const navGroups = [
  {
    title: 'Overview',
    items: [
      { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
      { to: '/templates', icon: Store, label: 'App Store' },
      { to: '/containers', icon: Box, label: 'Running Apps' },
      { to: '/processes', icon: Cpu, label: 'Native Processes' },
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
              ? 'bg-kathal-600/20 text-yellow-300'
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
    <aside className="w-64 shrink-0 bg-[#0B120B] border-r border-slate-800/80 flex flex-col h-full">
      {/* Brand Header */}
      <div className="h-16 px-5 border-b border-slate-800/80 flex items-center justify-between shrink-0">
        <NavLink to="/" onClick={onClose} className="flex items-center gap-2.5 whitespace-nowrap shrink-0">
          <span className="w-8 h-8 rounded-lg bg-kathal-600 flex items-center justify-center shadow-sm">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 2.5V5" stroke="#FACC15" strokeWidth="2" strokeLinecap="round" />
              <path d="M12.4 4.2c2.2-1.4 5-.9 6 .7-2 1-4.5.8-6-.7z" fill="#86EFAC" />
              <path d="M12 5c4.5 0 7 3.2 7 7.8 0 4.8-2.9 8.7-7 8.7s-7-3.9-7-8.7C5 8.2 7.5 5 12 5z" fill="#113F1B" stroke="#86EFAC" strokeWidth="1.4" />
              <ellipse cx="10.2" cy="11.8" rx="1.6" ry="2.4" transform="rotate(-14 10.2 11.8)" fill="#FACC15" />
              <ellipse cx="13.8" cy="12" rx="1.6" ry="2.4" transform="rotate(14 13.8 12)" fill="#FDE047" />
              <ellipse cx="12" cy="16" rx="1.7" ry="2.2" fill="#EAB308" />
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

      {/* Account & Desktop App Footer */}
      <div className="p-3 border-t border-slate-800/80 shrink-0 space-y-2">
        <PWAInstallButton compact />
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
