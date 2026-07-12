import { useApi } from '../hooks/useApi'

export default function Settings() {
  const { data: status } = useApi('/status')
  const { data: system } = useApi('/system')

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold">Settings</h1>
        <p className="text-gray-500 mt-1">System information and configuration</p>
      </div>

      {/* System Info */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-6">
        <h2 className="text-lg font-semibold mb-4">System</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-gray-600 mb-1">Platform</p>
            <p className="font-medium">{status?.platform || 'unknown'} ({status?.arch || 'unknown'})</p>
          </div>
          <div>
            <p className="text-xs text-gray-600 mb-1">Go Version</p>
            <p className="font-medium">{status?.goVersion || 'unknown'}</p>
          </div>
          <div>
            <p className="text-xs text-gray-600 mb-1">KATHAL Version</p>
            <p className="font-medium">v{status?.version || '0.1.0'}</p>
          </div>
          <div>
            <p className="text-xs text-gray-600 mb-1">Docker</p>
            <p className="font-medium">
              {status?.dockerAvailable ? (
                <span className="text-green-400">Connected (v{status?.dockerVersion || '?'})</span>
              ) : (
                <span className="text-yellow-400">Not available</span>
              )}
            </p>
          </div>
        </div>
      </div>

      {/* Quick Deploy */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-6">
        <h2 className="text-lg font-semibold mb-4">Quick Deploy</h2>
        <p className="text-sm text-gray-500 mb-4">
          {status?.dockerAvailable
            ? 'Click to deploy popular apps with one click.'
            : 'Install Docker to deploy apps from the dashboard.'}
        </p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { name: 'Nginx', icon: '🌐', desc: 'Web server' },
            { name: 'PostgreSQL', icon: '🐘', desc: 'Database' },
            { name: 'Redis', icon: '🔴', desc: 'Cache/Queue' },
            { name: 'Portainer', icon: '🐳', desc: 'Docker UI' },
            { name: 'Grafana', icon: '📊', desc: 'Monitoring' },
            { name: 'Prometheus', icon: '📈', desc: 'Metrics' },
            { name: 'MinIO', icon: '🪣', desc: 'Object storage' },
            { name: 'Uptime Kuma', icon: '💚', desc: 'Uptime monitor' },
          ].map(app => (
            <button
              key={app.name}
              disabled={!status?.dockerAvailable}
              className={`p-3 rounded-lg border text-left transition-all ${
                status?.dockerAvailable
                  ? 'bg-gray-800 hover:bg-gray-700 border-gray-700 hover:border-kathal-500/50 group'
                  : 'bg-gray-900 border-gray-800 opacity-50 cursor-not-allowed'
              }`}
            >
              <span className="text-xl mb-1 block">{app.icon}</span>
              <p className={`text-sm font-medium ${status?.dockerAvailable ? 'group-hover:text-kathal-400' : ''}`}>
                {app.name}
              </p>
              <p className="text-xs text-gray-600">{app.desc}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Install on other platforms */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-6">
        <h2 className="text-lg font-semibold mb-4">Install on Other Platforms</h2>
        <div className="space-y-4">
          <div className="bg-gray-800 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-lg">🪟</span>
              <p className="font-medium">Windows</p>
            </div>
            <code className="text-xs text-gray-400 block bg-gray-900 rounded p-2 mb-2">
              powershell -ExecutionPolicy Bypass -File install.ps1
            </code>
            <p className="text-xs text-gray-600">Requires Docker Desktop for container management.</p>
          </div>

          <div className="bg-gray-800 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-lg">🍎</span>
              <p className="font-medium">macOS</p>
            </div>
            <code className="text-xs text-gray-400 block bg-gray-900 rounded p-2 mb-2">
              curl -fsSL https://raw.githubusercontent.com/bakeweb/kathal-os/master/scripts/install-mac.sh | bash
            </code>
            <p className="text-xs text-gray-600">Auto-installs Docker, creates launchd service.</p>
          </div>

          <div className="bg-gray-800 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-lg">🐧</span>
              <p className="font-medium">Linux</p>
            </div>
            <code className="text-xs text-gray-400 block bg-gray-900 rounded p-2 mb-2">
              curl -fsSL https://raw.githubusercontent.com/bakeweb/kathal-os/master/scripts/install.sh | sudo bash
            </code>
            <p className="text-xs text-gray-600">Creates systemd service, auto-starts on boot.</p>
          </div>

          <div className="bg-gray-800 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-lg">🐋</span>
              <p className="font-medium">Docker (any platform)</p>
            </div>
            <code className="text-xs text-gray-400 block bg-gray-900 rounded p-2 mb-2">
              docker run -d --name kathal --restart unless-stopped \<br />
              &nbsp;&nbsp;-p 8080:8080 -v /var/run/docker.sock:/var/run/docker.sock \<br />
              &nbsp;&nbsp;ghcr.io/bakeweb/kathal-os:latest
            </code>
            <p className="text-xs text-gray-600">Works on any platform with Docker installed.</p>
          </div>
        </div>
      </div>

      {/* Danger Zone */}
      <div className="bg-gray-900 border border-red-600/20 rounded-xl p-6">
        <h2 className="text-lg font-semibold mb-4 text-red-400">Danger Zone</h2>
        <div className="flex items-center justify-between">
          <div>
            <p className="font-medium">Reset Dashboard</p>
            <p className="text-sm text-gray-500">Clear all settings and installed apps.</p>
          </div>
          <button className="px-4 py-2 bg-red-600/20 hover:bg-red-600 text-red-400 hover:text-white rounded-lg text-sm transition-colors">
            Reset
          </button>
        </div>
      </div>
    </div>
  )
}
