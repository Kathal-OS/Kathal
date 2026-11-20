import { useState } from 'react'
import { Eye, EyeOff, ArrowRight, Sparkles } from 'lucide-react'

export default function Login({ onLogin }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function submitCredentials(targetEmail, targetPassword) {
    setLoading(true)
    setError('')

    try {
      const res = await fetch('/api/v1/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: targetEmail, password: targetPassword }),
      })

      const data = await res.json()

      if (!res.ok) {
        setError(data.error || 'Invalid email or password')
        return
      }

      localStorage.setItem('kathal_token', data.token)
      localStorage.setItem('kathal_user', JSON.stringify(data.user))
      onLogin(data.token, data.user)
    } catch {
      setError('Could not connect to server')
    } finally {
      setLoading(false)
    }
  }

  function handleSubmit(e) {
    e.preventDefault()
    submitCredentials(email, password)
  }

  function handleDemoSignIn() {
    setEmail('admin@kathal.local')
    setPassword('kathal')
    submitCredentials('admin@kathal.local', 'kathal')
  }

  return (
    <div className="min-h-screen bg-[#0B0F17] flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md space-y-6">
        {/* Brand */}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-kathal-600 shadow-lg mb-2">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <rect x="3" y="4" width="18" height="6" rx="1.5" fill="white" />
              <rect x="3" y="13" width="10" height="7" rx="1.5" fill="white" fillOpacity="0.9" />
              <rect x="16" y="13" width="5" height="7" rx="1.5" fill="white" fillOpacity="0.7" />
            </svg>
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-100">KATHAL</h1>
          <p className="text-sm text-slate-400">
            Zero-code server control panel for your apps, databases, and domains
          </p>
        </div>

        {/* Sign In Card */}
        <form
          onSubmit={handleSubmit}
          className="bg-[#111827] border border-slate-800 rounded-2xl p-7 space-y-5"
        >
          <div>
            <h2 className="text-lg font-semibold text-slate-100">Sign in to your workspace</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Enter your administrator account details below
            </p>
          </div>

          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-xs">
              {error}
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Email address</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@kathal.local"
                required
                className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-lg text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-kathal-500 transition-colors"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Password</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  required
                  className="w-full px-3.5 py-2.5 pr-10 bg-slate-950 border border-slate-800 rounded-lg text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-kathal-500 transition-colors"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((s) => !s)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-200"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 px-4 bg-kathal-600 hover:bg-kathal-500 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 inline-flex items-center justify-center gap-2"
          >
            <span>{loading ? 'Signing in...' : 'Sign In'}</span>
            <ArrowRight className="w-4 h-4" />
          </button>

          <div className="pt-4 border-t border-slate-800/80 space-y-2.5">
            <button
              type="button"
              onClick={handleDemoSignIn}
              disabled={loading}
              className="w-full py-2 px-3 bg-slate-800/80 hover:bg-slate-800 border border-slate-700/80 text-slate-200 text-xs font-medium rounded-lg transition-colors inline-flex items-center justify-center gap-2"
            >
              <Sparkles className="w-3.5 h-3.5 text-kathal-400" />
              <span>One-Click Demo Sign In (admin@kathal.local)</span>
            </button>
            <p className="text-center text-[11px] text-slate-500">
              Default local credentials: <span className="font-mono text-slate-400">admin@kathal.local</span> / <span className="font-mono text-slate-400">kathal</span>
            </p>
          </div>
        </form>
      </div>
    </div>
  )
}
