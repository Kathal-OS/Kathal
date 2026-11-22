import { useState, useEffect, useCallback } from 'react'
import {
  Globe,
  Plus,
  Lock,
  Trash2,
  Power,
  Activity,
  ExternalLink,
  Sliders,
  Pencil,
  Server,
  FileJson,
  Save,
  Copy,
  Check,
} from 'lucide-react'
import { apiFetch, apiPost, apiPut, apiDelete } from '../hooks/useApi'

const EMPTY_FORM = {
  domain: '',
  targetMode: 'port',
  appName: '',
  targetHost: 'localhost',
  localPort: '8080',
  ssl: false,
  enabled: true,
}

export default function ProxyManager() {
  const [activeTab, setActiveTab] = useState('routes')
  const [routes, setRoutes] = useState([])
  const [apps, setApps] = useState([])
  const [proxySettings, setProxySettings] = useState(null)
  const [jsonConfig, setJsonConfig] = useState(null)
  const [showJsonPreview, setShowJsonPreview] = useState(true)
  const [copiedJson, setCopiedJson] = useState(false)

  const [editingId, setEditingId] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [savingRoute, setSavingRoute] = useState(false)

  const [savingSettings, setSavingSettings] = useState(false)
  const [loading, setLoading] = useState(true)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [testingId, setTestingId] = useState(null)
  const [testResults, setTestResults] = useState({})
  const [feedback, setFeedback] = useState(null)

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [routesData, appsData, settingsData, configData] = await Promise.all([
        apiFetch('/proxy'),
        apiFetch('/containers?all=true'),
        apiFetch('/settings'),
        apiFetch('/proxy/config'),
      ])
      setRoutes(Array.isArray(routesData) ? routesData : [])
      setApps(Array.isArray(appsData) ? appsData : [])
      if (settingsData) setProxySettings(settingsData)
      if (configData) setJsonConfig(configData)
    } catch {
      setRoutes([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  function resetFormToNew() {
    setEditingId(null)
    setForm({
      ...EMPTY_FORM,
      ssl: proxySettings?.autoSsl ?? false,
    })
  }

  function openEditRouteForm(route) {
    let parsedHost = 'localhost'
    let parsedPort = route.localPort ? String(route.localPort) : ''
    try {
      const u = new URL(route.target)
      parsedHost = u.hostname === '127.0.0.1' ? '127.0.0.1' : 'localhost'
      if (u.port) parsedPort = u.port
    } catch {
      // keep fallback
    }
    setEditingId(route.id)
    setForm({
      domain: route.domain || '',
      targetMode: route.appName ? 'app' : 'port',
      appName: route.appName || '',
      targetHost: parsedHost,
      localPort: parsedPort,
      ssl: Boolean(route.ssl),
      enabled: Boolean(route.enabled),
    })
    setActiveTab('routes')
  }

  function handleSelectApp(appName) {
    const found = apps.find((a) => a.name === appName)
    setForm((prev) => ({
      ...prev,
      appName,
      localPort: found?.port ? String(found.port) : prev.localPort,
    }))
  }

  async function handleSaveRoute(e) {
    e.preventDefault()
    setFeedback(null)
    setSavingRoute(true)
    try {
      const portNum = Number(form.localPort)
      const payload = {
        domain: form.domain.trim(),
        targetHost: form.targetHost,
        localPort: Number.isFinite(portNum) && portNum > 0 ? portNum : undefined,
        appName: form.targetMode === 'app' ? form.appName || undefined : undefined,
        ssl: form.ssl,
        enabled: form.enabled,
      }
      if (editingId) {
        await apiPut(`/proxy/${editingId}`, payload)
        setFeedback({
          type: 'success',
          text: `Updated "${form.domain.trim()}" → ${form.targetHost}:${form.localPort} and saved to JSON config.`,
        })
      } else {
        await apiPost('/proxy', payload)
        setFeedback({
          type: 'success',
          text: `Saved mapping "${form.domain.trim()}" → ${form.targetHost}:${form.localPort} to reverse-proxy.json.`,
        })
      }
      resetFormToNew()
      await loadData()
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to save domain mapping' })
    } finally {
      setSavingRoute(false)
    }
  }

  async function handleSyncConfigJson() {
    setFeedback(null)
    try {
      const updated = await apiPut('/proxy/config', {
        routes,
        settings: proxySettings,
      })
      setJsonConfig(updated)
      setFeedback({
        type: 'success',
        text: `Reverse proxy configuration persisted to ${updated.relativePath}.`,
      })
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to persist JSON config' })
    }
  }

  async function handleSaveSettings(e) {
    e.preventDefault()
    if (!proxySettings) return
    setSavingSettings(true)
    setFeedback(null)
    try {
      const updated = await apiPut('/settings', {
        serverDomain: proxySettings.serverDomain,
        wildcardDomain: proxySettings.wildcardDomain,
        letsEncryptEmail: proxySettings.letsEncryptEmail,
        autoSsl: proxySettings.autoSsl,
        forceHttps: proxySettings.forceHttps,
      })
      setProxySettings(updated)
      await loadData()
      setFeedback({ type: 'success', text: 'Reverse proxy settings saved to reverse-proxy.json.' })
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to save reverse proxy settings' })
    } finally {
      setSavingSettings(false)
    }
  }

  async function handleTest(route) {
    setTestingId(route.id)
    try {
      const res = await apiPost(`/proxy/${route.id}/test`, {})
      setTestResults((prev) => ({ ...prev, [route.id]: res }))
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [route.id]: { ok: false, error: err.message || 'Connection test failed' },
      }))
    } finally {
      setTestingId(null)
    }
  }

  async function handleDelete(id) {
    setFeedback(null)
    try {
      await apiDelete(`/proxy/${id}`)
      setConfirmDeleteId(null)
      setFeedback({ type: 'success', text: 'Domain route removed from reverse-proxy.json.' })
      loadData()
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to delete route' })
    }
  }

  async function handleToggle(id, enabled) {
    setFeedback(null)
    try {
      const endpoint = enabled ? 'disable' : 'enable'
      await apiPost(`/proxy/${id}/${endpoint}`, {})
      loadData()
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to update route' })
    }
  }

  function copyJsonConfig() {
    if (!jsonConfig?.rawJson) return
    navigator.clipboard?.writeText(jsonConfig.rawJson)
    setCopiedJson(true)
    setTimeout(() => setCopiedJson(false), 1500)
  }

  const activeCount = routes.filter((r) => r.enabled).length
  const sslCount = routes.filter((r) => r.ssl).length

  return (
    <div className="p-6 sm:p-8 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-100">Domains &amp; Reverse Proxy</h1>
          <p className="text-slate-400 text-sm mt-1">
            Map domains to local host ports (for example <code className="text-slate-300">myapp.local</code> → <code className="text-slate-300">localhost:8080</code>) and persist rules to JSON for the internal reverse proxy.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setActiveTab(activeTab === 'settings' ? 'routes' : 'settings')}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-sm font-medium whitespace-nowrap shrink-0 transition-colors"
          >
            <Sliders className="w-4 h-4" />
            <span>{activeTab === 'settings' ? 'Domain Mapping' : 'Proxy Settings'}</span>
          </button>
          <button
            type="button"
            onClick={handleSyncConfigJson}
            className="inline-flex items-center gap-2 bg-kathal-600 hover:bg-kathal-500 text-white px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap shrink-0 transition-colors"
          >
            <Save className="w-4 h-4" />
            <span>Save JSON Config</span>
          </button>
        </div>
      </div>

      {/* Summary Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-[#101A10] border border-slate-800/90 rounded-xl p-4">
          <p className="text-xs text-slate-400">Active Proxy Rules</p>
          <p className="text-2xl font-bold text-slate-100 tabular-nums mt-1">
            {activeCount} <span className="text-xs font-normal text-slate-500">/ {routes.length}</span>
          </p>
        </div>
        <div className="bg-[#101A10] border border-slate-800/90 rounded-xl p-4">
          <p className="text-xs text-slate-400">HTTPS Metadata</p>
          <p className="text-2xl font-bold text-slate-100 tabular-nums mt-1">{sslCount}</p>
        </div>
        <div className="bg-[#101A10] border border-slate-800/90 rounded-xl p-4">
          <p className="text-xs text-slate-400">JSON Config File</p>
          <p className="text-xs font-mono font-semibold text-green-400 truncate mt-2">
            {jsonConfig?.relativePath || 'data/reverse-proxy.json'}
          </p>
        </div>
        <div className="bg-[#101A10] border border-slate-800/90 rounded-xl p-4">
          <p className="text-xs text-slate-400">Wildcard Suffix</p>
          <p className="text-sm font-mono font-semibold text-slate-200 truncate mt-2">
            .{proxySettings?.wildcardDomain || 'apps.kathal.local'}
          </p>
        </div>
      </div>

      {/* Segmented Navigation */}
      <div className="flex items-center gap-1 bg-[#101A10] border border-slate-800 p-1 rounded-lg w-fit">
        <button
          type="button"
          onClick={() => setActiveTab('routes')}
          className={`px-3.5 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
            activeTab === 'routes'
              ? 'bg-kathal-600 text-white'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          Domain-to-Port Mapping
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('settings')}
          className={`px-3.5 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
            activeTab === 'settings'
              ? 'bg-kathal-600 text-white'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          Reverse Proxy Settings
        </button>
      </div>

      {feedback && (
        <div
          className={`p-3 rounded-lg border text-sm ${
            feedback.type === 'error'
              ? 'bg-red-500/10 border-red-500/30 text-red-400'
              : 'bg-green-500/10 border-green-500/30 text-green-400'
          }`}
        >
          {feedback.text}
        </div>
      )}

      {activeTab === 'settings' ? (
        <form
          onSubmit={handleSaveSettings}
          className="bg-[#101A10] border border-slate-800/90 rounded-xl p-6 space-y-5"
        >
          <div>
            <h2 className="text-lg font-semibold text-slate-100">Reverse Proxy Global Settings</h2>
            <p className="text-xs text-slate-400 mt-1">
              Settings saved here are stored inside <code className="text-slate-300">{jsonConfig?.relativePath || 'data/reverse-proxy.json'}</code> and used by the internal reverse proxy.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Primary Panel Domain</label>
              <input
                type="text"
                value={proxySettings?.serverDomain || ''}
                onChange={(e) =>
                  setProxySettings((prev) => ({ ...prev, serverDomain: e.target.value }))
                }
                placeholder="panel.example.com"
                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3.5 py-2 text-sm text-slate-100 focus:border-kathal-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Wildcard App Domain</label>
              <input
                type="text"
                value={proxySettings?.wildcardDomain || ''}
                onChange={(e) =>
                  setProxySettings((prev) => ({ ...prev, wildcardDomain: e.target.value }))
                }
                placeholder="apps.kathal.local"
                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3.5 py-2 text-sm font-mono text-slate-100 focus:border-kathal-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Let&apos;s Encrypt Email</label>
              <input
                type="email"
                value={proxySettings?.letsEncryptEmail || ''}
                onChange={(e) =>
                  setProxySettings((prev) => ({ ...prev, letsEncryptEmail: e.target.value }))
                }
                placeholder="ops@example.com"
                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3.5 py-2 text-sm text-slate-100 focus:border-kathal-500 focus:outline-none"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-slate-800/80">
            <label className="flex items-center justify-between p-3.5 rounded-lg bg-slate-900/60 border border-slate-800 cursor-pointer">
              <div>
                <p className="text-sm font-medium text-slate-200">Automatic HTTPS Metadata</p>
                <p className="text-xs text-slate-400">Enable TLS certificate metadata by default on new routes</p>
              </div>
              <input
                type="checkbox"
                checked={Boolean(proxySettings?.autoSsl)}
                onChange={(e) =>
                  setProxySettings((prev) => ({ ...prev, autoSsl: e.target.checked }))
                }
                className="w-4 h-4 accent-kathal-500"
              />
            </label>

            <label className="flex items-center justify-between p-3.5 rounded-lg bg-slate-900/60 border border-slate-800 cursor-pointer">
              <div>
                <p className="text-sm font-medium text-slate-200">Force HTTPS Redirect</p>
                <p className="text-xs text-slate-400">Redirect plain HTTP requests to HTTPS when behind TLS</p>
              </div>
              <input
                type="checkbox"
                checked={Boolean(proxySettings?.forceHttps)}
                onChange={(e) =>
                  setProxySettings((prev) => ({ ...prev, forceHttps: e.target.checked }))
                }
                className="w-4 h-4 accent-kathal-500"
              />
            </label>
          </div>

          <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 flex items-start gap-3">
            <Server className="w-4 h-4 text-kathal-400 shrink-0 mt-0.5" />
            <div className="text-xs text-slate-300 leading-relaxed">
              <p className="font-semibold text-slate-100">Internal JSON-Backed Reverse Proxy Active</p>
              <p className="text-slate-400 mt-0.5">
                Incoming <code className="text-slate-200">Host</code> headers are matched against <code className="text-slate-200">{jsonConfig?.relativePath || 'data/reverse-proxy.json'}</code> and forwarded directly to loopback targets (<code className="text-slate-200">localhost</code> / <code className="text-slate-200">127.0.0.1</code> ports <code className="text-slate-200">1024–65535</code>).
              </p>
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={savingSettings}
              className="px-5 py-2 bg-kathal-600 hover:bg-kathal-500 text-white rounded-lg text-sm font-medium disabled:opacity-50"
            >
              {savingSettings ? 'Saving Settings...' : 'Save Settings to JSON'}
            </button>
          </div>
        </form>
      ) : (
        <>
          {/* Persistent Domain-to-Port Configuration Panel */}
          <form
            onSubmit={handleSaveRoute}
            className="bg-[#101A10] border border-slate-800/90 rounded-xl p-6 space-y-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-slate-100">
                  {editingId ? 'Edit Domain-to-Port Mapping' : 'Map Domain Name to Local Port'}
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Example: map <code className="text-slate-200">myapp.local</code> → <code className="text-slate-200">localhost:8080</code> and save directly to <code className="text-slate-200">reverse-proxy.json</code>.
                </p>
              </div>
              <div className="flex items-center gap-1 bg-slate-900 border border-slate-800 p-1 rounded-lg">
                <button
                  type="button"
                  onClick={() => setForm((prev) => ({ ...prev, targetMode: 'port', appName: '' }))}
                  className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                    form.targetMode === 'port'
                      ? 'bg-kathal-600 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Direct Local Port
                </button>
                <button
                  type="button"
                  onClick={() => setForm((prev) => ({ ...prev, targetMode: 'app' }))}
                  className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                    form.targetMode === 'app'
                      ? 'bg-kathal-600 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Managed Process
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="md:col-span-2">
                <label className="block text-xs text-slate-400 mb-1.5">Domain Name</label>
                <input
                  value={form.domain}
                  onChange={(e) => setForm({ ...form, domain: e.target.value })}
                  placeholder="myapp.local"
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3.5 py-2 text-sm text-slate-100 focus:border-kathal-500 focus:outline-none"
                  required
                />
              </div>

              {form.targetMode === 'app' ? (
                <div className="md:col-span-1">
                  <label className="block text-xs text-slate-400 mb-1.5">Native Process / App</label>
                  <select
                    value={form.appName}
                    onChange={(e) => handleSelectApp(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3.5 py-2 text-sm text-slate-100 focus:border-kathal-500 focus:outline-none"
                    required
                  >
                    <option value="">-- Choose process --</option>
                    {apps.map((a) => (
                      <option key={a.id} value={a.name}>
                        {a.name} (:{a.port})
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div>
                  <label className="block text-xs text-slate-400 mb-1.5">Local Host</label>
                  <select
                    value={form.targetHost}
                    onChange={(e) => setForm({ ...form, targetHost: e.target.value })}
                    className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3.5 py-2 text-sm font-mono text-slate-100 focus:border-kathal-500 focus:outline-none"
                  >
                    <option value="localhost">localhost</option>
                    <option value="127.0.0.1">127.0.0.1</option>
                  </select>
                </div>
              )}

              <div>
                <label className="block text-xs text-slate-400 mb-1.5">Local Port (1024–65535)</label>
                <input
                  type="number"
                  min={1024}
                  max={65535}
                  value={form.localPort}
                  onChange={(e) => setForm({ ...form, localPort: e.target.value })}
                  placeholder="8080"
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3.5 py-2 text-sm font-mono tabular-nums text-slate-100 focus:border-kathal-500 focus:outline-none"
                  required
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4 pt-2 border-t border-slate-800/80">
              <div className="flex flex-wrap items-center gap-5">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.ssl}
                    onChange={(e) => setForm({ ...form, ssl: e.target.checked })}
                    className="w-4 h-4 rounded accent-kathal-500"
                  />
                  <span className="text-xs text-slate-300">HTTPS Metadata</span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                    className="w-4 h-4 rounded accent-kathal-500"
                  />
                  <span className="text-xs text-slate-300">Active Immediately</span>
                </label>

                <span className="text-xs font-mono text-slate-400 tabular-nums">
                  Rule: <span className="text-slate-200">{form.domain.trim() || 'myapp.local'}</span> →{' '}
                  <span className="text-kathal-400">
                    {form.targetHost}:{form.localPort || '8080'}
                  </span>
                </span>
              </div>

              <div className="flex items-center gap-2">
                {editingId && (
                  <button
                    type="button"
                    onClick={resetFormToNew}
                    className="bg-slate-800 hover:bg-slate-700 px-3.5 py-2 rounded-lg text-xs text-slate-300"
                  >
                    Cancel Edit
                  </button>
                )}
                <button
                  type="submit"
                  disabled={savingRoute}
                  className="inline-flex items-center gap-1.5 bg-kathal-600 hover:bg-kathal-500 text-white px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap disabled:opacity-50"
                >
                  <Plus className="w-4 h-4" />
                  <span>{savingRoute ? 'Saving...' : editingId ? 'Update & Save JSON' : 'Add & Save to JSON'}</span>
                </button>
              </div>
            </div>
          </form>

          {/* Active Routes List */}
          {loading ? (
            <div className="bg-[#101A10] border border-slate-800/90 rounded-xl p-12 text-center text-slate-400 text-sm">
              Loading domain routes...
            </div>
          ) : routes.length === 0 ? (
            <div className="bg-[#101A10] border border-slate-800/90 rounded-xl p-10 text-center space-y-2">
              <Globe className="w-9 h-9 text-slate-600 mx-auto" />
              <p className="text-slate-200 text-base font-semibold">No domain mappings saved yet</p>
              <p className="text-slate-400 text-sm">
                Use the configuration panel above to map a domain like <code className="text-slate-300">myapp.local</code> to <code className="text-slate-300">localhost:8080</code>.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {routes.map((route) => {
                const probe = testResults[route.id]
                return (
                  <div
                    key={route.id}
                    className="bg-[#101A10] border border-slate-800/90 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3"
                  >
                    <div className="flex items-center gap-3.5 min-w-0">
                      <span
                        className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                          route.enabled ? 'bg-green-500' : 'bg-slate-600'
                        }`}
                        aria-hidden="true"
                      />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-semibold text-slate-100 truncate">{route.domain}</p>
                          {route.ssl && (
                            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-green-400">
                              <Lock className="w-3 h-3" />
                              <span>HTTPS</span>
                            </span>
                          )}
                          {route.appName ? (
                            <span className="text-xs text-slate-400">
                              · Process <span className="text-slate-200 font-medium">{route.appName}</span>
                            </span>
                          ) : (
                            <span className="text-xs text-slate-500">· Direct Local Port</span>
                          )}
                        </div>
                        <p className="text-xs text-slate-400 font-mono tabular-nums mt-0.5 truncate">
                          → {route.target}
                        </p>
                        {probe && (
                          <p
                            className={`text-xs mt-1 font-mono tabular-nums ${
                              probe.ok ? 'text-green-400' : 'text-red-400'
                            }`}
                          >
                            {probe.ok
                              ? `Reachable · HTTP ${probe.statusCode} · ${probe.latencyMs}ms`
                              : `Unreachable · ${probe.error || `HTTP ${probe.statusCode}`}`}
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                      {route.liveUrl && route.appState === 'running' && (
                        <a
                          href={route.liveUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium bg-green-600/20 hover:bg-green-600 text-green-300 hover:text-white border border-green-500/30 transition-colors"
                        >
                          <span>Open Preview</span>
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                      <button
                        type="button"
                        onClick={() => openEditRouteForm(route)}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 transition-colors"
                      >
                        <Pencil className="w-3 h-3" />
                        <span>Edit</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleTest(route)}
                        disabled={testingId === route.id}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 transition-colors disabled:opacity-50"
                      >
                        <Activity className="w-3 h-3" />
                        <span>{testingId === route.id ? 'Testing...' : 'Test Route'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleToggle(route.id, route.enabled)}
                        className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
                          route.enabled
                            ? 'bg-amber-500/15 hover:bg-amber-500/25 text-amber-400'
                            : 'bg-green-500/15 hover:bg-green-500/25 text-green-400'
                        }`}
                      >
                        <Power className="w-3 h-3" />
                        <span>{route.enabled ? 'Disable' : 'Enable'}</span>
                      </button>
                      {confirmDeleteId === route.id ? (
                        <>
                          <button
                            type="button"
                            onClick={() => handleDelete(route.id)}
                            className="px-2.5 py-1.5 rounded-md text-xs font-medium bg-red-600 hover:bg-red-500 text-white"
                          >
                            Confirm
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            className="px-2.5 py-1.5 rounded-md text-xs bg-slate-800 hover:bg-slate-700 text-slate-300"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(route.id)}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium bg-red-500/15 hover:bg-red-600 text-red-400 hover:text-white transition-colors"
                        >
                          <Trash2 className="w-3 h-3" />
                          <span>Delete</span>
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Persisted JSON File Preview Card */}
          <div className="bg-[#101A10] border border-slate-800/90 rounded-xl p-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <FileJson className="w-4 h-4 text-kathal-400" />
                <div>
                  <h3 className="text-sm font-semibold text-slate-100">
                    Internal Reverse Proxy JSON Configuration
                  </h3>
                  <p className="text-xs text-slate-400 font-mono">
                    {jsonConfig?.relativePath || 'data/reverse-proxy.json'}
                    {jsonConfig?.updatedAt
                      ? ` · Updated ${new Date(jsonConfig.updatedAt).toLocaleTimeString()}`
                      : ''}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={copyJsonConfig}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200"
                >
                  {copiedJson ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                  <span>{copiedJson ? 'Copied' : 'Copy JSON'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setShowJsonPreview((v) => !v)}
                  className="px-2.5 py-1.5 rounded-md text-xs bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200"
                >
                  {showJsonPreview ? 'Hide JSON' : 'Inspect JSON'}
                </button>
              </div>
            </div>
            {showJsonPreview && (
              <pre className="bg-slate-950 border border-slate-800 rounded-lg p-3.5 text-xs font-mono text-slate-300 overflow-x-auto max-h-64">
                {jsonConfig?.rawJson || 'Loading JSON configuration...'}
              </pre>
            )}
          </div>
        </>
      )}
    </div>
  )
}
