import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import {
  Globe,
  Database,
  Layers,
  Box,
  BarChart3,
  Activity,
  HardDrive,
  ShieldCheck,
  Terminal,
  Copy,
  Check,
  RotateCw,
  AlertTriangle,
  Laptop,
  RefreshCw,
  ExternalLink,
  ArrowUpCircle,
} from 'lucide-react'
import { useApi, apiFetch, apiPost, apiPut } from '../hooks/useApi'
import PWAInstallButton from '../components/PWAInstallButton'
import { usePWAInstall } from '../hooks/usePWAInstall'

const QUICK_DEPLOY_CATALOG = [
  { id: 'nginx', name: 'Nginx', icon: Globe, desc: 'Web server', image: 'nginx:alpine', port: 80 },
  { id: 'postgres', name: 'PostgreSQL', icon: Database, desc: 'Database', image: 'postgres:16-alpine', port: 5432 },
  { id: 'redis', name: 'Redis', icon: Layers, desc: 'Cache & Queue', image: 'redis:7-alpine', port: 6379 },
  { id: 'portainer', name: 'Portainer', icon: Box, desc: 'Docker UI', image: 'portainer/portainer-ce:latest', port: 9000 },
  { id: 'grafana', name: 'Grafana', icon: BarChart3, desc: 'Dashboards', image: 'grafana/grafana:latest', port: 3000 },
  { id: 'prometheus', name: 'Prometheus', icon: Activity, desc: 'Metrics', image: 'prom/prometheus:latest', port: 9090 },
  { id: 'minio', name: 'MinIO', icon: HardDrive, desc: 'Object storage', image: 'minio/minio:latest', port: 9000 },
  { id: 'uptime-kuma', name: 'Uptime Kuma', icon: ShieldCheck, desc: 'Uptime monitor', image: 'louislam/uptime-kuma:latest', port: 3001 },
]

export default function Settings({ updateInfo: initialUpdateInfo = null, onUpdateChecked }) {
  const { data: status } = useApi('/status')
  const { isInstalled, platform } = usePWAInstall()
  const [settings, setSettings] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saveBanner, setSaveBanner] = useState(null)
  const [updateInfo, setUpdateInfo] = useState(initialUpdateInfo)
  const [checkingUpdates, setCheckingUpdates] = useState(false)

  const [deployingId, setDeployingId] = useState(null)
  const [deployBanner, setDeployBanner] = useState(null)

  const [confirmReset, setConfirmReset] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [copiedSecret, setCopiedSecret] = useState(false)

  useEffect(() => {
    if (initialUpdateInfo) setUpdateInfo(initialUpdateInfo)
  }, [initialUpdateInfo])

  useEffect(() => {
    apiFetch('/settings')
      .then((data) => setSettings(data))
      .catch(() => {})
    if (!initialUpdateInfo) {
      apiFetch('/system/updates')
        .then((res) => {
          setUpdateInfo(res)
          onUpdateChecked?.(res)
        })
        .catch(() => {})
    }
  }, [initialUpdateInfo, onUpdateChecked])

  const handleManualUpdateCheck = async () => {
    setCheckingUpdates(true)
    try {
      const res = await apiPost('/system/check-updates', {})
      setUpdateInfo(res)
      onUpdateChecked?.(res)
    } catch (err) {
      setSaveBanner({ type: 'error', text: err.message || 'Update check failed.' })
    } finally {
      setCheckingUpdates(false)
    }
  }

  const handleSaveSettings = async (e) => {
    e.preventDefault()
    if (!settings) return
    setSaving(true)
    setSaveBanner(null)
    try {
      const updated = await apiPut('/settings', settings)
      setSettings(updated)
      setSaveBanner({ type: 'success', text: 'Operational settings saved and applied.' })
    } catch (err) {
      setSaveBanner({ type: 'error', text: err.message || 'Failed to save settings.' })
    } finally {
      setSaving(false)
    }
  }

  const handleRegenerateSecret = async () => {
    try {
      const res = await apiPost('/settings/regenerate-webhook', {})
      setSettings((prev) => ({ ...prev, webhookSecret: res.webhookSecret }))
      setSaveBanner({ type: 'success', text: 'Webhook secret regenerated.' })
    } catch (err) {
      setSaveBanner({ type: 'error', text: err.message || 'Failed to regenerate secret.' })
    }
  }

  const handleQuickDeploy = async (app) => {
    setDeployingId(app.id)
    setDeployBanner(null)
    try {
      const res = await apiPost('/deploy', {
        name: app.id,
        image: app.image,
        containerPort: app.port,
        autoDomain: true,
        source: 'settings-quick-deploy',
      })
      setDeployBanner({
        type: 'success',
        text: `Deployed ${app.name} (${res.container?.name}) on port ${res.app?.port}${
          res.proxyRoute ? ` · Proxy: ${res.proxyRoute.domain}` : ''
        }`,
      })
    } catch (err) {
      setDeployBanner({ type: 'error', text: err.message || `Failed to deploy ${app.name}` })
    } finally {
      setDeployingId(null)
    }
  }

  const handleResetDashboard = async () => {
    if (!confirmReset) {
      setConfirmReset(true)
      return
    }
    setResetting(true)
    try {
      const res = await apiPost('/settings/reset', {})
      if (res.settings) setSettings(res.settings)
      setConfirmReset(false)
      setSaveBanner({ type: 'success', text: 'Dashboard state and settings restored to defaults.' })
    } catch (err) {
      setSaveBanner({ type: 'error', text: err.message || 'Failed to reset dashboard.' })
    } finally {
      setResetting(false)
    }
  }

  const webhookUrl = `${window.location.origin}/api/v1/git/webhook`

  return (
    <div className="p-6 sm:p-8 max-w-7xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-slate-100">Operational Settings</h1>
        <p className="text-slate-400 text-sm mt-1">
          Configure automatic app domains, HTTPS certificates, deployment pipelines, and health alerts.
        </p>
      </div>

      {/* Operational Configuration Form */}
      {settings && (
        <form onSubmit={handleSaveSettings} className="space-y-6">
          {saveBanner && (
            <div
              className={`p-3 rounded-lg border text-sm ${
                saveBanner.type === 'error'
                  ? 'bg-red-500/10 border-red-500/30 text-red-400'
                  : 'bg-green-500/10 border-green-500/30 text-green-400'
              }`}
            >
              {saveBanner.text}
            </div>
          )}

          {/* Server & Domain Routing */}
          <div className="bg-[#101A10] border border-slate-800/90 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-slate-100 mb-1">Server &amp; Domain Routing</h2>
            <p className="text-xs text-slate-400 mb-4">
              Used when assigning automatic web addresses to newly launched apps.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs text-slate-400 mb-1.5">Server Name</label>
                <input
                  type="text"
                  value={settings.serverName || ''}
                  onChange={(e) => setSettings({ ...settings, serverName: e.target.value })}
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-kathal-500 focus:outline-none"
                  required
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1.5">Primary Panel Domain</label>
                <input
                  type="text"
                  value={settings.serverDomain || ''}
                  onChange={(e) => setSettings({ ...settings, serverDomain: e.target.value })}
                  placeholder="panel.example.com"
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-kathal-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1.5">Wildcard App Domain</label>
                <input
                  type="text"
                  value={settings.wildcardDomain || ''}
                  onChange={(e) => setSettings({ ...settings, wildcardDomain: e.target.value })}
                  placeholder="apps.example.com"
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-kathal-500 focus:outline-none"
                />
              </div>
            </div>
          </div>

          {/* SSL / Reverse Proxy & Deployment Automation */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-[#101A10] border border-slate-800/90 rounded-xl p-6 space-y-4">
              <div>
                <h2 className="text-lg font-semibold text-slate-100">Reverse Proxy &amp; SSL</h2>
                <p className="text-xs text-slate-400 mt-0.5">Automatic HTTPS certificates for routed apps</p>
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1.5">Let&apos;s Encrypt Certificate Email</label>
                <input
                  type="email"
                  value={settings.letsEncryptEmail || ''}
                  onChange={(e) => setSettings({ ...settings, letsEncryptEmail: e.target.value })}
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-kathal-500 focus:outline-none"
                />
              </div>
              <label className="flex items-center justify-between py-2.5 border-t border-slate-800/80 cursor-pointer">
                <div>
                  <p className="text-sm font-medium text-slate-200">Automatic SSL Certificates</p>
                  <p className="text-xs text-slate-400">Issue TLS certificates on new proxy routes</p>
                </div>
                <input
                  type="checkbox"
                  checked={Boolean(settings.autoSsl)}
                  onChange={(e) => setSettings({ ...settings, autoSsl: e.target.checked })}
                  className="w-4 h-4 accent-kathal-500"
                />
              </label>
              <label className="flex items-center justify-between py-2.5 border-t border-slate-800/80 cursor-pointer">
                <div>
                  <p className="text-sm font-medium text-slate-200">Force HTTPS Redirect</p>
                  <p className="text-xs text-slate-400">Redirect incoming HTTP traffic to HTTPS</p>
                </div>
                <input
                  type="checkbox"
                  checked={Boolean(settings.forceHttps)}
                  onChange={(e) => setSettings({ ...settings, forceHttps: e.target.checked })}
                  className="w-4 h-4 accent-kathal-500"
                />
              </label>
            </div>

            <div className="bg-[#101A10] border border-slate-800/90 rounded-xl p-6 space-y-4">
              <div>
                <h2 className="text-lg font-semibold text-slate-100">Deployment Pipeline &amp; Webhooks</h2>
                <p className="text-xs text-slate-400 mt-0.5">Control rollout behavior and Git auto-deploy</p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-400 mb-1.5">Deploy Strategy</label>
                  <select
                    value={settings.defaultDeployStrategy || 'rolling'}
                    onChange={(e) => setSettings({ ...settings, defaultDeployStrategy: e.target.value })}
                    className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-kathal-500 focus:outline-none"
                  >
                    <option value="rolling">Zero-Downtime Rolling</option>
                    <option value="recreate">Stop &amp; Recreate</option>
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1.5">CPU Alert %</label>
                    <input
                      type="number"
                      min={10}
                      max={100}
                      value={settings.cpuAlertThreshold ?? 85}
                      onChange={(e) => setSettings({ ...settings, cpuAlertThreshold: Number(e.target.value) })}
                      className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 tabular-nums focus:border-kathal-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1.5">Mem Alert %</label>
                    <input
                      type="number"
                      min={10}
                      max={100}
                      value={settings.memoryAlertThreshold ?? 85}
                      onChange={(e) => setSettings({ ...settings, memoryAlertThreshold: Number(e.target.value) })}
                      className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 tabular-nums focus:border-kathal-500 focus:outline-none"
                    />
                  </div>
                </div>
              </div>

              <label className="flex items-center justify-between py-2.5 border-t border-slate-800/80 cursor-pointer">
                <div>
                  <p className="text-sm font-medium text-slate-200">Auto-Deploy on Git Webhook</p>
                  <p className="text-xs text-slate-400">Trigger deployments when webhook receives push</p>
                </div>
                <input
                  type="checkbox"
                  checked={Boolean(settings.autoDeployWebhook)}
                  onChange={(e) => setSettings({ ...settings, autoDeployWebhook: e.target.checked })}
                  className="w-4 h-4 accent-kathal-500"
                />
              </label>

              <label className="flex items-center justify-between py-2.5 border-t border-slate-800/80 cursor-pointer">
                <div>
                  <p className="text-sm font-medium text-slate-200">Auto-Prune Stopped Containers</p>
                  <p className="text-xs text-slate-400">Clean up exited containers after each deploy</p>
                </div>
                <input
                  type="checkbox"
                  checked={Boolean(settings.pruneStoppedAfterDeploy)}
                  onChange={(e) => setSettings({ ...settings, pruneStoppedAfterDeploy: e.target.checked })}
                  className="w-4 h-4 accent-kathal-500"
                />
              </label>

              <div className="pt-2 border-t border-slate-800/80 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-400">Webhook Endpoint</span>
                  <code className="text-kathal-400 font-mono truncate max-w-xs">{webhookUrl}</code>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <code className="text-xs bg-slate-900 border border-slate-800 px-2.5 py-1.5 rounded font-mono text-slate-300 truncate flex-1">
                    Secret: {settings.webhookSecret}
                  </code>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard?.writeText(settings.webhookSecret || '')
                      setCopiedSecret(true)
                      setTimeout(() => setCopiedSecret(false), 1500)
                    }}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded text-xs text-slate-200 shrink-0"
                  >
                    {copiedSecret ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                    <span>{copiedSecret ? 'Copied' : 'Copy'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleRegenerateSecret}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded text-xs text-slate-200 shrink-0"
                  >
                    <RotateCw className="w-3 h-3" />
                    <span>Rotate</span>
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={saving}
              className="px-6 py-2.5 bg-kathal-600 hover:bg-kathal-500 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving Settings...' : 'Save Operational Settings'}
            </button>
          </div>
        </form>
      )}

      {/* System Info & Auto-Update Checker */}
      <div id="updates" className="bg-[#101A10] border border-slate-800/90 rounded-xl p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">System &amp; GitHub Release Updates</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Compares <code className="text-slate-300">KATHAL_VERSION</code> against the GitHub Releases API
            </p>
          </div>
          <button
            type="button"
            onClick={handleManualUpdateCheck}
            disabled={checkingUpdates}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-kathal-600 hover:bg-kathal-500 text-white text-xs font-medium transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${checkingUpdates ? 'animate-spin' : ''}`} />
            <span>{checkingUpdates ? 'Checking GitHub...' : 'Check GitHub Releases'}</span>
          </button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <p className="text-xs text-slate-400 mb-1">Platform</p>
            <p className="font-medium text-slate-100">{status?.platform || 'unknown'} ({status?.arch || 'unknown'})</p>
          </div>
          <div>
            <p className="text-xs text-slate-400 mb-1">Runtime</p>
            <p className="font-medium text-slate-100 font-mono text-sm">{status?.goVersion || 'unknown'}</p>
          </div>
          <div>
            <p className="text-xs text-slate-400 mb-1">KATHAL Version</p>
            <p className="font-medium text-slate-100 font-mono text-sm">
              v{updateInfo?.currentVersion || status?.version || '0.1.0'}
              {updateInfo?.versionSource ? (
                <span className="text-xs text-slate-400 font-sans ml-1.5">({updateInfo.versionSource})</span>
              ) : null}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-400 mb-1">Release Repository</p>
            <a
              href={`https://github.com/${updateInfo?.repository || 'Kathal-OS/Kathal'}`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-sm font-mono text-green-400 hover:text-green-300 inline-flex items-center gap-1"
            >
              <span>{updateInfo?.repository || 'Kathal-OS/Kathal'}</span>
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>

        {updateInfo && (
          <div
            className={`p-3.5 rounded-lg border text-xs flex flex-wrap items-center justify-between gap-3 ${
              updateInfo.updateAvailable
                ? 'bg-yellow-500/10 border-yellow-500/35 text-yellow-200'
                : updateInfo.status === 'unavailable'
                ? 'bg-slate-900/70 border-slate-800 text-slate-300'
                : 'bg-green-500/10 border-green-500/30 text-green-300'
            }`}
          >
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 font-semibold">
                {updateInfo.updateAvailable && <ArrowUpCircle className="w-4 h-4 text-yellow-400" />}
                <span>{updateInfo.message}</span>
              </div>
              {updateInfo.releaseNotes && (
                <p className="text-slate-300/90 max-w-3xl line-clamp-2">{updateInfo.releaseNotes}</p>
              )}
            </div>
            {updateInfo.releaseUrl && (
              <a
                href={updateInfo.releaseUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-yellow-500/20 hover:bg-yellow-500/30 border border-yellow-500/40 text-yellow-200 font-medium shrink-0"
              >
                <span>Open Release</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
          </div>
        )}
      </div>

      {/* Desktop App Support */}
      <div className="bg-[#101A10] border border-slate-800/90 rounded-xl p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-kathal-600/15 border border-kathal-500/30 flex items-center justify-center text-kathal-400 shrink-0">
              <Laptop className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-slate-100">Desktop App Support</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Run KATHAL as a standalone desktop window via PWA installation or the Electron launcher.
              </p>
            </div>
          </div>
          <PWAInstallButton />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-2 border-t border-slate-800/80">
          <div className="p-3 rounded-lg bg-slate-900/60 border border-slate-800">
            <p className="text-xs text-slate-400">Display Mode</p>
            <p className="text-sm font-medium text-slate-100 mt-1">
              {isInstalled ? 'Standalone Window' : 'Browser Tab'}
            </p>
          </div>
          <div className="p-3 rounded-lg bg-slate-900/60 border border-slate-800">
            <p className="text-xs text-slate-400">Detected OS</p>
            <p className="text-sm font-medium text-slate-100 capitalize mt-1">{platform}</p>
          </div>
          <div className="p-3 rounded-lg bg-slate-900/60 border border-slate-800">
            <p className="text-xs text-slate-400">Web App Manifest</p>
            <p className="text-xs font-mono text-green-400 mt-1.5">
              {status?.desktopSupport?.pwaManifest || '/manifest.webmanifest'}
            </p>
          </div>
          <div className="p-3 rounded-lg bg-slate-900/60 border border-slate-800">
            <p className="text-xs text-slate-400">Electron Wrapper</p>
            <p className="text-xs font-mono text-slate-200 mt-1.5">
              {status?.desktopSupport?.desktopCommand || 'npm run desktop'}
            </p>
          </div>
        </div>
      </div>

      {/* Quick Deploy */}
      <div className="bg-[#101A10] border border-slate-800/90 rounded-xl p-6">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-semibold text-slate-100">Quick Deploy</h2>
          <Link to="/containers" className="text-xs text-kathal-400 hover:text-kathal-300">
            Open Running Apps →
          </Link>
        </div>
        <p className="text-sm text-slate-400 mb-4">
          Click any service to launch it locally and configure a reverse proxy domain route automatically.
        </p>

        {deployBanner && (
          <div
            className={`mb-4 p-3 rounded-lg border text-xs ${
              deployBanner.type === 'error'
                ? 'bg-red-500/10 border-red-500/30 text-red-400'
                : 'bg-green-500/10 border-green-500/30 text-green-400'
            }`}
          >
            {deployBanner.text}
          </div>
        )}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {QUICK_DEPLOY_CATALOG.map((app) => {
            const Icon = app.icon
            const busy = deployingId === app.id
            return (
              <button
                key={app.id}
                type="button"
                onClick={() => handleQuickDeploy(app)}
                disabled={deployingId !== null}
                className="p-3.5 rounded-xl border text-left transition-colors bg-slate-900/70 hover:bg-slate-800 border-slate-800 hover:border-kathal-500/50 group disabled:opacity-50"
              >
                <div className="w-8 h-8 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center text-slate-300 group-hover:text-kathal-400 mb-2.5 transition-colors">
                  <Icon className="w-4 h-4" />
                </div>
                <p className="text-sm font-medium text-slate-100 group-hover:text-kathal-400">
                  {busy ? 'Deploying...' : app.name}
                </p>
                <p className="text-xs text-slate-400 mt-0.5">{app.desc}</p>
              </button>
            )
          })}
        </div>
      </div>

      {/* Install on any OS (100% self-hosted, zero cloud) */}
      <div className="bg-[#101A10] border border-slate-800/90 rounded-xl p-6">
        <div className="flex items-center gap-2 mb-4">
          <Terminal className="w-4 h-4 text-slate-400" />
          <h2 className="text-lg font-semibold text-slate-100">Install on Windows, macOS & Linux (Zero Cloud)</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-4">
            <p className="font-medium text-slate-200 mb-2">Windows (10 / 11 / Server)</p>
            <code className="text-xs text-slate-300 font-mono block bg-slate-950 border border-slate-800 rounded-lg p-2.5 mb-2 overflow-x-auto">
              powershell -ExecutionPolicy Bypass -File scripts/install.ps1
            </code>
            <p className="text-xs text-slate-400">Runs natively with Node.js & Python. Optional Windows Scheduled Task auto-start, zero Docker required.</p>
          </div>
          <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-4">
            <p className="font-medium text-slate-200 mb-2">macOS (Apple Silicon & Intel)</p>
            <code className="text-xs text-slate-300 font-mono block bg-slate-950 border border-slate-800 rounded-lg p-2.5 mb-2 overflow-x-auto">
              bash scripts/install-mac.sh
            </code>
            <p className="text-xs text-slate-400">Sets up Homebrew Node.js, builds locally, and optionally configures a launchd background service.</p>
          </div>
          <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-4">
            <p className="font-medium text-slate-200 mb-2">Linux (Ubuntu / Debian / Fedora / Arch)</p>
            <code className="text-xs text-slate-300 font-mono block bg-slate-950 border border-slate-800 rounded-lg p-2.5 mb-2 overflow-x-auto">
              bash scripts/install.sh
            </code>
            <p className="text-xs text-slate-400">Builds locally with zero external cloud dependencies and prints a ready-to-enable systemd unit.</p>
          </div>
          <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-4">
            <p className="font-medium text-slate-200 mb-2">Desktop App (Electron + PWA)</p>
            <code className="text-xs text-slate-300 font-mono block bg-slate-950 border border-slate-800 rounded-lg p-2.5 mb-2 overflow-x-auto">
              npm run desktop
            </code>
            <p className="text-xs text-slate-400">Runs the standalone desktop window directly against your local host across Windows, macOS, and Linux.</p>
          </div>
        </div>
      </div>

      {/* Danger Zone */}
      <div className="bg-[#101A10] border border-red-500/30 rounded-xl p-6">
        <div className="flex items-center gap-2 mb-3 text-red-400">
          <AlertTriangle className="w-4 h-4" />
          <h2 className="text-lg font-semibold">Danger Zone</h2>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="font-medium text-slate-100">Reset Dashboard</p>
            <p className="text-sm text-slate-400">Restore default apps, routes, and operational settings.</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleResetDashboard}
              disabled={resetting}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 ${
                confirmReset
                  ? 'bg-red-600 hover:bg-red-500 text-white'
                  : 'bg-red-500/15 hover:bg-red-600 text-red-400 hover:text-white'
              }`}
            >
              {resetting ? 'Resetting...' : confirmReset ? 'Confirm Reset Everything' : 'Reset'}
            </button>
            {confirmReset && !resetting && (
              <button
                type="button"
                onClick={() => setConfirmReset(false)}
                className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-sm"
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
