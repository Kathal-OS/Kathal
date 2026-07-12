import { useApi } from '../hooks/useApi'

function MetricCard({ icon, label, value, sub, color = 'text-kathal-400' }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
      <div className="flex items-center justify-between mb-3">
        <span className="text-2xl">{icon}</span>
        <span className={`text-2xl font-bold ${color}`}>{value}</span>
      </div>
      <p className="text-sm text-gray-400">{label}</p>
      {sub && <p className="text-xs text-gray-600 mt-1">{sub}</p>}
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

function DockerBadge({ available }) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium ${
      available
        ? 'bg-green-600/20 text-green-400 border border-green-600/30'
        : 'bg-yellow-600/20 text-yellow-400 border border-yellow-600/30'
    }`}>
      <span className={`w-2 h-2 rounded-full ${available ? 'bg-green-400' : 'bg-yellow-400'}`}></span>
      {available ? 'Docker Connected' : 'System-Only Mode'}
    </span>
  )
}

export default function Dashboard() {
  const { data: metrics, loading } = useApi('/metrics')
  const { data: status } = useApi('/status')

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-gray-500">Loading dashboard...</div>
      </div>
    )
  }

  const sys = metrics?.system
  const docker = metrics?.docker

  return (
    <div className="p-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold">Dashboard</h1>
          <p className="text-gray-500 mt-1">
            {status?.platform && (
              <>Running on {status.platform} ({status.arch})</>
            )}
          </p>
        </div>
        <DockerBadge available={status?.dockerAvailable || false} />
      </div>

      {/* System metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <MetricCard
          icon="⚡"
          label="CPU Usage"
          value={`${sys?.cpu?.toFixed(1) || 0}%`}
          sub={`${sys?.cpuCores || 0} cores`}
        />
        <MetricCard
          icon="🧠"
          label="Memory"
          value={`${sys?.memory?.percent?.toFixed(1) || 0}%`}
          sub={`${formatBytes(sys?.memory?.used)} / ${formatBytes(sys?.memory?.total)}`}
        />
        <MetricCard
          icon="💾"
          label="Disk"
          value={`${sys?.disk?.percent?.toFixed(1) || 0}%`}
          sub={`${formatBytes(sys?.disk?.used)} / ${formatBytes(sys?.disk?.total)}`}
        />
        <MetricCard
          icon="🌐"
          label="Network"
          value={`${formatBytes(sys?.network?.bytesSent)}`}
          sub={`↑ sent / ↓ ${formatBytes(sys?.network?.bytesRecv)} recv`}
        />
      </div>

      {/* System info */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-8">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <h2 className="text-lg font-semibold mb-4">System</h2>
          <div className="space-y-3">
            <div className="flex justify-between">
              <span className="text-gray-500">Platform</span>
              <span>{status?.platform} / {status?.arch}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Go Version</span>
              <span>{sys?.goVersion || status?.goVersion}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Uptime</span>
              <span>{formatUptime(sys?.uptime)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">KATHAL Version</span>
              <span>v{status?.version}</span>
            </div>
            {sys?.load?.load1 > 0 && (
              <div className="flex justify-between">
                <span className="text-gray-500">Load Average</span>
                <span>{sys.load.load1.toFixed(2)} / {sys.load.load5.toFixed(2)} / {sys.load.load15.toFixed(2)}</span>
              </div>
            )}
          </div>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <h2 className="text-lg font-semibold mb-4">Docker</h2>
          {status?.dockerAvailable ? (
            <div className="space-y-3">
              <div className="flex justify-between">
                <span className="text-gray-500">Version</span>
                <span>{status?.dockerVersion || docker?.containersRunning !== undefined ? `v${status?.dockerVersion}` : 'N/A'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Running Containers</span>
                <span className="text-green-400">{docker?.containersRunning || 0}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Stopped Containers</span>
                <span className="text-yellow-400">{docker?.containersStopped || 0}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Images</span>
                <span>{docker?.imagesCount || 0}</span>
              </div>
            </div>
          ) : (
            <div className="text-center py-8">
              <span className="text-4xl mb-3 block">🐳</span>
              <p className="text-gray-500 mb-2">Docker not available</p>
              <p className="text-xs text-gray-600 max-w-xs mx-auto">
                Install Docker Desktop to manage containers. KATHAL runs in system-only mode without Docker.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Quick actions */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <h2 className="text-lg font-semibold mb-4">Quick Deploy</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { name: 'Nginx', icon: '🌐', image: 'nginx:alpine' },
            { name: 'PostgreSQL', icon: '🐘', image: 'postgres:16-alpine' },
            { name: 'Redis', icon: '🔴', image: 'redis:alpine' },
            { name: 'Portainer', icon: '🐳', image: 'portainer/portainer-ce:latest' },
          ].map(app => (
            <button
              key={app.name}
              className="p-4 bg-gray-800 hover:bg-gray-700 border border-gray-700 hover:border-kathal-500/50 rounded-lg transition-all text-left group"
            >
              <span className="text-2xl mb-2 block">{app.icon}</span>
              <p className="font-medium text-sm group-hover:text-kathal-400 transition-colors">{app.name}</p>
              <p className="text-xs text-gray-600 mt-1 truncate">{app.image}</p>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
