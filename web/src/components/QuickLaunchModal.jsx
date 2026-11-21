import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  X,
  Globe,
  FileText,
  Cpu,
  Activity,
  Database,
  GitBranch,
  TerminalSquare,
  Terminal,
  CheckCircle2,
  ArrowRight,
  ExternalLink,
} from 'lucide-react'
import { apiPost } from '../hooks/useApi'

const APP_CHOICES = [
  {
    id: 'static',
    runtime: 'static',
    title: 'Website (Static HTML)',
    desc: 'Instant static web server running locally on Node.js — zero Docker needed.',
    defaultName: 'my-website',
    icon: Globe,
  },
  {
    id: 'cms',
    runtime: 'cms',
    title: 'Blog & CMS',
    desc: 'Built-in publishing studio with live posts API and local JSON storage.',
    defaultName: 'my-blog',
    icon: FileText,
  },
  {
    id: 'node',
    runtime: 'node',
    title: 'Node.js Web App / API',
    desc: 'Live Node.js HTTP server with /healthz and /api/info endpoints.',
    defaultName: 'node-app',
    icon: Cpu,
  },
  {
    id: 'python',
    runtime: 'python',
    title: 'Python 3 Web App',
    desc: 'Native Python 3 HTTP server process managed directly by KATHAL.',
    defaultName: 'python-app',
    icon: TerminalSquare,
  },
  {
    id: 'sqlite',
    runtime: 'sqlite',
    title: 'SQLite Database Studio',
    desc: 'Local SQLite3 database engine with a built-in web browser UI.',
    defaultName: 'sqlite-db',
    icon: Database,
  },
  {
    id: 'monitor',
    runtime: 'monitor',
    title: 'Uptime Status Monitor',
    desc: 'Real-time host & endpoint health monitor running locally.',
    defaultName: 'status-monitor',
    icon: Activity,
  },
  {
    id: 'git',
    runtime: 'git',
    title: 'Deploy from Git Repo',
    desc: 'Clone any public HTTPS repo (Node.js, Python, or static) and run locally.',
    defaultName: 'git-app',
    icon: GitBranch,
  },
  {
    id: 'binary',
    runtime: 'binary',
    title: 'Native Binary Command',
    desc: 'Execute any local binary directly on host (Node, Python, Go, custom CLI) with managed port.',
    defaultName: 'custom-binary',
    icon: Terminal,
  },
]

export default function QuickLaunchModal({ open, onClose, onDeployed }) {
  const [selectedChoice, setSelectedChoice] = useState(APP_CHOICES[0])
  const [appName, setAppName] = useState(APP_CHOICES[0].defaultName)
  const [repoUrl, setRepoUrl] = useState('')
  const [branch, setBranch] = useState('main')
  const [executable, setExecutable] = useState('python3')
  const [args, setArgs] = useState('-m http.server {PORT} --bind 127.0.0.1')
  const [workingDir, setWorkingDir] = useState('')
  const [customDomain, setCustomDomain] = useState('')
  const [autoDomain, setAutoDomain] = useState(false)
  const [deploying, setDeploying] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)

  if (!open) return null

  function choosePreset(choice) {
    setSelectedChoice(choice)
    setAppName(choice.defaultName)
    setError('')
    setResult(null)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setDeploying(true)
    setError('')
    try {
      const payload = {
        name: appName.trim(),
        runtime: selectedChoice.runtime,
        domain: customDomain.trim(),
        autoDomain: !customDomain.trim() && autoDomain,
        source: 'coolify-local-launcher',
      }
      if (selectedChoice.id === 'git') {
        payload.repoUrl = repoUrl.trim()
        payload.branch = branch.trim() || 'main'
      }
      if (selectedChoice.id === 'binary') {
        payload.executable = executable.trim()
        payload.args = args
        if (workingDir.trim()) payload.workingDir = workingDir.trim()
      }
      const res = await apiPost('/deploy', payload)
      setResult(res)
      if (onDeployed) onDeployed(res)
    } catch (err) {
      setError(err.message || 'Could not launch local app')
    } finally {
      setDeploying(false)
    }
  }

  function resetAndClose() {
    setResult(null)
    setError('')
    onClose()
  }

  return (
    <div
      className="fixed inset-0 bg-black/75 backdrop-blur-xs flex items-center justify-center z-50 p-4"
      onClick={resetAndClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-[#111827] border border-slate-800 rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto shadow-2xl"
      >
        <div className="px-6 py-5 border-b border-slate-800 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-slate-100">Install &amp; Launch Local App</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Runs directly on your server without Docker — instant live URL and optional custom domain.
            </p>
          </div>
          <button
            type="button"
            onClick={resetAndClose}
            aria-label="Close launcher"
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {result ? (
          <div className="p-6 space-y-5">
            <div className="p-4 rounded-xl bg-green-500/10 border border-green-500/30 flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-green-400 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <h3 className="text-base font-semibold text-green-300">
                  {result.app?.name} is installed &amp; running live
                </h3>
                <p className="text-xs text-slate-300 mt-1">
                  Local port <span className="font-mono text-white">{result.app?.port}</span>
                  {result.container?.pid && (
                    <>
                      {' '}· PID <span className="font-mono text-white">{result.container.pid}</span>
                    </>
                  )}
                  {result.proxyRoute && (
                    <>
                      {' '}· Domain{' '}
                      <span className="font-mono text-white">{result.proxyRoute.domain}</span>
                    </>
                  )}
                </p>
              </div>
            </div>

            <div className="bg-slate-950/70 border border-slate-800 rounded-xl p-4">
              <p className="text-xs font-medium text-slate-400 mb-2">Live process &amp; install log</p>
              <ul className="space-y-1.5 text-xs text-slate-300 font-mono max-h-48 overflow-y-auto">
                {(result.logs || []).map((line, idx) => (
                  <li key={idx}>{line}</li>
                ))}
              </ul>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setResult(null)}
                className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm text-slate-200"
              >
                Launch Another
              </button>
              {result.liveUrl && (
                <a
                  href={result.liveUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-green-600 hover:bg-green-500 text-white text-sm font-medium"
                >
                  <span>Open Live App</span>
                  <ExternalLink className="w-4 h-4" />
                </a>
              )}
              <Link
                to="/containers"
                onClick={resetAndClose}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-kathal-600 hover:bg-kathal-500 text-white text-sm font-medium"
              >
                <span>Manage Apps</span>
                <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="p-6 space-y-5">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-2">
                1. Choose app runtime or source
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {APP_CHOICES.map((choice) => {
                  const Icon = choice.icon
                  const active = selectedChoice.id === choice.id
                  return (
                    <button
                      key={choice.id}
                      type="button"
                      onClick={() => choosePreset(choice)}
                      className={`p-3.5 rounded-xl border text-left transition-colors flex items-start gap-3 ${
                        active
                          ? 'bg-kathal-600/15 border-kathal-500 text-slate-100'
                          : 'bg-slate-900/60 border-slate-800 text-slate-300 hover:border-slate-700'
                      }`}
                    >
                      <Icon
                        className={`w-5 h-5 shrink-0 mt-0.5 ${
                          active ? 'text-kathal-400' : 'text-slate-400'
                        }`}
                      />
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-100">{choice.title}</p>
                        <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">{choice.desc}</p>
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>

            {selectedChoice.id === 'git' && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 p-3.5 rounded-xl bg-slate-900/70 border border-slate-800">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Public HTTPS Git Repository URL
                  </label>
                  <input
                    type="url"
                    value={repoUrl}
                    onChange={(e) => setRepoUrl(e.target.value)}
                    placeholder="https://github.com/user/my-site.git"
                    required
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm font-mono text-slate-100 focus:border-kathal-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Branch</label>
                  <input
                    type="text"
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    placeholder="main"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm text-slate-100 focus:border-kathal-500 focus:outline-none"
                  />
                </div>
              </div>
            )}

            {selectedChoice.id === 'binary' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3.5 rounded-xl bg-slate-900/70 border border-slate-800">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Binary Executable
                  </label>
                  <input
                    type="text"
                    value={executable}
                    onChange={(e) => setExecutable(e.target.value)}
                    placeholder="python3"
                    required
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm font-mono text-slate-100 focus:border-kathal-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Working Directory (optional)
                  </label>
                  <input
                    type="text"
                    value={workingDir}
                    onChange={(e) => setWorkingDir(e.target.value)}
                    placeholder="Auto workspace folder"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm font-mono text-slate-100 focus:border-kathal-500 focus:outline-none"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Command Arguments (<code className="text-slate-400">{'{PORT}'}</code> injects assigned port)
                  </label>
                  <input
                    type="text"
                    value={args}
                    onChange={(e) => setArgs(e.target.value)}
                    placeholder="-m http.server {PORT} --bind 127.0.0.1"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm font-mono text-slate-100 focus:border-kathal-500 focus:outline-none"
                  />
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  2. App Name
                </label>
                <input
                  type="text"
                  value={appName}
                  onChange={(e) => setAppName(e.target.value)}
                  placeholder="my-website"
                  required
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm text-slate-100 focus:border-kathal-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  3. Connect Domain (optional)
                </label>
                <input
                  type="text"
                  value={customDomain}
                  onChange={(e) => setCustomDomain(e.target.value)}
                  placeholder="mysite.example.com"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm text-slate-100 placeholder:text-slate-500 focus:border-kathal-500 focus:outline-none"
                />
              </div>
            </div>

            {!customDomain.trim() && (
              <label className="flex items-center gap-2.5 text-xs text-slate-300 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={autoDomain}
                  onChange={(e) => setAutoDomain(e.target.checked)}
                  className="w-4 h-4 accent-kathal-500 rounded"
                />
                <span>
                  Also register a local domain route (
                  <span className="font-mono text-slate-200">{appName || 'my-app'}.apps.kathal.local</span>)
                </span>
              </label>
            )}

            {error && (
              <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-400">
                {error}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-800">
              <Link
                to="/templates"
                onClick={resetAndClose}
                className="text-xs text-slate-400 hover:text-kathal-400"
              >
                Explore all one-click local apps →
              </Link>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={resetAndClose}
                  className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={deploying || !appName.trim()}
                  className="px-5 py-2 rounded-lg bg-kathal-600 hover:bg-kathal-500 text-white text-sm font-medium disabled:opacity-50"
                >
                  {deploying ? 'Installing & Starting...' : 'Install & Run Locally'}
                </button>
              </div>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
