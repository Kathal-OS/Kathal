import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import {
  Cpu,
  MemoryStick,
  HardDrive,
  ArrowUpDown,
  Globe,
  Database,
  FileText,
  Activity,
  Rocket,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
} from 'lucide-react'
import { useApi, apiFetch, apiPost } from '../hooks/useApi'
import ContainerStatusWidget from '../components/ContainerStatusWidget'
import SystemMonitor from '../components/SystemMonitor'
import QuickActionsWidget from '../components/QuickActionsWidget'

function getMetricTone(percent) {
  if (percent >= 85) return 'text-red-400'
  if (percent >= 65) return 'text-yellow-400'
  return 'text-green-400'
}

function MetricCard({ icon: Icon, label, value, sub, valueClass = 'text-slate-100' }) {
  return (
    <div className="bg-[#101A10] border border-slate-800/90 rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium text-slate-400">{label}</span>
        <Icon className="w-4 h-4 text-slate-400" strokeWidth={1.85} />
      </div>
      <p className={`text-2xl font-bold tabular-nums ${valueClass}`}>{value}</p>
      {sub && <p className="text-xs text-slate-500 mt-1 tabular-nums">{sub}</p>}
    </div>
  )
}

function formatBytes(bytes) {
  if (!bytes) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i]
}

function formatUptime(seconds) {
  if (!seconds) return 'N/A'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

const QUICK_APPS = [
  {
    id: 'my-website',
    runtime: 'static',
    name: 'Static Website Host',
    desc: 'Instant local HTML/CSS/JS site server',
    icon: Globe,
  },
  {
    id: 'my-blog',
    runtime: 'cms',
    name: 'Blog & CMS Studio',
    desc: 'Native Node.js CMS with live post publishing',
    icon: FileText,
  },
  {
    id: 'sqlite-studio',
    runtime: 'sqlite',
    name: 'SQLite Database Studio',
    desc: 'Local SQLite3 database + web row browser',
    icon: Database,
  },
  {
    id: 'uptime-monitor',
    runtime: 'monitor',
    name: 'Uptime Status Monitor',
    desc: 'Real-time local service & host monitor',
    icon: Activity,
  },
]

export default function Dashboard({ externalRefreshKey = 0, onOpenQuickLaunch, onUpdateChecked }) {
  const { data: initialMetrics, loading } = useApi('/metrics')
  const { data: status } = useApi('/status')
  const [metrics, setMetrics] = useState(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [deployingApp, setDeployingApp] = useState(null)
  const [deployNotice, setDeployNotice] = useState(null)

  useEffect(() => {
    if (initialMetrics) setMetrics(initialMetrics)
  }, [initialMetrics])

  const refreshDashboard = useCallback(async () => {
    setRefreshKey((k) => k + 1)
    try {
      const latest = await apiFetch('/metrics')
      setMetrics(latest)
    } catch {
      // Keep previous metrics if refresh fails
    }
  }, [])

  useEffect(() => {
    if (externalRefreshKey > 0) {
      refreshDashboard()
    }
  }, [externalRefreshKey, refreshDashboard])

  const handleQuickDeploy = async (app) => {
    setDeployingApp(app.id)
    setDeployNotice(null)
    try {
      const res = await apiPost('/deploy', {
        name: app.id,
        runtime: app.runtime,
        autoDomain: true,
        source: 'quick-deploy',
      })
      setDeployNotice({
        type: 'success',
        title: `${app.name} is installed & running live`,
        detail: `Port ${res.app?.port}${
          res.container?.pid ? ` · PID ${res.container.pid}` : ''
        }${res.proxyRoute ? ` · Domain ${res.proxyRoute.domain}` : ''}`,
        liveUrl: res.liveUrl,
      })
      await refreshDashboard()
    } catch (err) {
      setDeployNotice({
        type: 'error',
        title: `Could not launch ${app.name}`,
        detail: err.message || 'Deployment error',
      })
    } finally {
      setDeployingApp(null)
    }
  }

  if (loading && !metrics) {
    return (
      <div className="p-6 sm:p-8 max-w-7xl mx-auto space-y-6">
        <div className="h-24 rounded-xl bg-slate-900/60 border border-slate-800/80 animate-pulse" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-28 rounded-xl bg-slate-900/60 border border-slate-800/80 animate-pulse" />
          ))}
        </div>
      </div>
    )
  }

  const sys = metrics?.system
  const docker = metrics?.docker
  const runningCount = docker?.containersRunning || 0

  return (
    <div className="p-6 sm:p-8 max-w-7xl mx-auto space-y-6">
      {/* Welcome / Status Banner */}
      <div className="bg-[#101A10] border border-slate-800/90 rounded-xl p-6 flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span className="inline-flex items-center gap-1.5 font-medium text-green-400">
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>Local Native Runtime Active (No Docker)</span>
            </span>
            <span aria-hidden="true" className="text-slate-600">·</span>
            <span>{status?.platform || 'linux'} ({status?.arch || 'x64'})</span>
            <span aria-hidden="true" className="text-slate-600">·</span>
            <span className="tabular-nums">Uptime {formatUptime(sys?.uptime)}</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold text-slate-100">
            Server Control Center
          </h1>
          <p className="text-sm text-slate-400">
            {runningCount} local {runningCount === 1 ? 'app is' : 'apps are'} running live. Install websites, Node.js, Python, or Git repos locally and connect custom domains.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <Link
            to="/git"
            className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-sm font-medium whitespace-nowrap transition-colors"
          >
            Deploy Git Repo
          </Link>
          {onOpenQuickLaunch && (
            <button
              type="button"
              onClick={onOpenQuickLaunch}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-kathal-600 hover:bg-kathal-500 text-white text-sm font-medium whitespace-nowrap transition-colors"
            >
              <Rocket className="w-4 h-4" />
              <span>Install Local App</span>
            </button>
          )}
        </div>
      </div>

      {/* System Resources */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          icon={Cpu}
          label="Processor (CPU)"
          value={`${sys?.cpu?.toFixed(1) || 0}%`}
          sub={`${sys?.cpuCores || 0} cores available`}
          valueClass={getMetricTone(sys?.cpu || 0)}
        />
        <MetricCard
          icon={MemoryStick}
          label="Memory (RAM)"
          value={`${sys?.memory?.percent?.toFixed(1) || 0}%`}
          sub={`${formatBytes(sys?.memory?.used)} of ${formatBytes(sys?.memory?.total)}`}
          valueClass={getMetricTone(sys?.memory?.percent || 0)}
        />
        <MetricCard
          icon={HardDrive}
          label="Storage (Disk)"
          value={`${sys?.disk?.percent?.toFixed(1) || 0}%`}
          sub={`${formatBytes(sys?.disk?.used)} of ${formatBytes(sys?.disk?.total)}`}
          valueClass={getMetricTone(sys?.disk?.percent || 0)}
        />
        <MetricCard
          icon={ArrowUpDown}
          label="Network Traffic"
          value={formatBytes(sys?.network?.bytesSent)}
          sub={`Sent · ${formatBytes(sys?.network?.bytesRecv)} received`}
          valueClass="text-yellow-400"
        />
      </div>

      {/* Real-time System Monitor (CPU, Memory & Disk via Node.js os) */}
      <SystemMonitor />

      {/* Real Running Local Apps Widget */}
      <ContainerStatusWidget refreshKey={refreshKey} />

      {/* Quick Actions */}
      <QuickActionsWidget onPruned={refreshDashboard} onUpdateChecked={onUpdateChecked} />

      {/* One-Click Popular Local Apps */}
      <div className="bg-[#101A10] border border-slate-800/90 rounded-xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">One-Click Local Apps (Zero Docker)</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Installs real apps on disk and runs them directly via Node.js &amp; Python 3 with instant preview URLs and domain routing.
            </p>
          </div>
          <Link
            to="/templates"
            className="inline-flex items-center gap-1 text-xs text-kathal-400 hover:text-kathal-300 font-medium whitespace-nowrap"
          >
            <span>Browse all app templates</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>

        {deployNotice && (
          <div
            className={`mb-4 p-3 rounded-lg border text-xs flex flex-wrap items-center justify-between gap-2 ${
              deployNotice.type === 'error'
                ? 'bg-red-500/10 border-red-500/30 text-red-400'
                : 'bg-green-500/10 border-green-500/30 text-green-400'
            }`}
          >
            <div>
              <p className="font-semibold">{deployNotice.title}</p>
              <p className="text-slate-300 mt-0.5">{deployNotice.detail}</p>
            </div>
            {deployNotice.type === 'success' && (
              <div className="flex items-center gap-2">
                {deployNotice.liveUrl && (
                  <a
                    href={deployNotice.liveUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-green-600 hover:bg-green-500 text-white font-medium"
                  >
                    <span>Open Live App</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                )}
                <Link to="/containers" className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200">
                  Manage Apps →
                </Link>
                <Link to="/proxy" className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200">
                  Connect Domain →
                </Link>
              </div>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {QUICK_APPS.map((app) => {
            const Icon = app.icon
            const isDeploying = deployingApp === app.id
            return (
              <button
                key={app.id}
                type="button"
                onClick={() => handleQuickDeploy(app)}
                disabled={deployingApp !== null}
                className="p-4 bg-slate-900/70 hover:bg-slate-800/80 border border-slate-800 hover:border-kathal-500/50 rounded-xl transition-colors text-left group disabled:opacity-60"
              >
                <div className="flex items-center justify-between mb-3">
                  <div className="w-9 h-9 rounded-lg bg-slate-800 border border-slate-700/80 flex items-center justify-center text-slate-300 group-hover:text-kathal-400 transition-colors">
                    <Icon className="w-4 h-4" />
                  </div>
                  <span className="text-[11px] font-medium text-kathal-400 opacity-80 group-hover:opacity-100">
                    {isDeploying ? 'Starting...' : 'Install & Run →'}
                  </span>
                </div>
                <p className="font-semibold text-sm text-slate-100 group-hover:text-kathal-400 transition-colors">
                  {app.name}
                </p>
                <p className="text-xs text-slate-400 mt-1">{app.desc}</p>
              </button>
            )
          })}
        </div>
      </div>

      {/* System Summary */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-[#101A10] border border-slate-800/90 rounded-xl p-6">
          <h2 className="text-base font-semibold text-slate-100 mb-4">Server Details</h2>
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between border-b border-slate-800/60 pb-2">
              <dt className="text-slate-400">Operating System</dt>
              <dd className="text-slate-200">{status?.platform} / {status?.arch}</dd>
            </div>
            <div className="flex justify-between border-b border-slate-800/60 pb-2">
              <dt className="text-slate-400">Runtime Engine</dt>
              <dd className="text-slate-200 font-mono text-xs">{sys?.goVersion || status?.goVersion}</dd>
            </div>
            <div className="flex justify-between border-b border-slate-800/60 pb-2">
              <dt className="text-slate-400">Control Panel Version</dt>
              <dd className="text-slate-200 font-mono text-xs">v{status?.version}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">System Load (1m / 5m / 15m)</dt>
              <dd className="text-slate-200 font-mono text-xs tabular-nums">
                {sys?.load ? `${sys.load.load1.toFixed(2)} / ${sys.load.load5.toFixed(2)} / ${sys.load.load15.toFixed(2)}` : '—'}
              </dd>
            </div>
          </dl>
        </div>

        <div className="bg-[#101A10] border border-slate-800/90 rounded-xl p-6">
          <h2 className="text-base font-semibold text-slate-100 mb-4">Local Runtime Summary</h2>
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between border-b border-slate-800/60 pb-2">
              <dt className="text-slate-400">Execution Mode</dt>
              <dd className="text-slate-200 font-mono text-xs">
                {status?.runtimeEngine || 'Local Native Runtime'}
              </dd>
            </div>
            <div className="flex justify-between border-b border-slate-800/60 pb-2">
              <dt className="text-slate-400">Running Local Apps</dt>
              <dd className="text-green-400 font-semibold tabular-nums">{docker?.containersRunning || 0}</dd>
            </div>
            <div className="flex justify-between border-b border-slate-800/60 pb-2">
              <dt className="text-slate-400">Stopped Apps</dt>
              <dd className="text-slate-300 tabular-nums">{docker?.containersStopped || 0}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">Apps Folder</dt>
              <dd className="text-slate-300 font-mono text-xs truncate max-w-[220px]">
                {status?.appsRoot || '/tmp/kathal-apps'}
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  )
}
