import { useState, useEffect } from 'react'
import { Eye, EyeOff, ArrowRight, ShieldCheck, KeyRound, UserPlus, Sun, Moon } from 'lucide-react'

export default function Login({ onLogin, sessionNotice = '', theme = 'dark', onToggleTheme }) {
  const [mode, setMode] = useState('login') // 'login' | 'register' | 'reset'
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [resetToken, setResetToken] = useState('')
  const [showPassword, setShowPassword] = useState(false)

  const [needsSetup, setNeedsSetup] = useState(false)
  const [allowSelfRegistration, setAllowSelfRegistration] = useState(false)
  const [checkingStatus, setCheckingStatus] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let active = true
    fetch('/api/v1/auth/status', { credentials: 'same-origin' })
      .then((res) => res.json())
      .then((data) => {
        if (!active) return
        setNeedsSetup(Boolean(data?.needsSetup))
        setAllowSelfRegistration(Boolean(data?.allowSelfRegistration))
        if (data?.adminEmail) setEmail(data.adminEmail)
      })
      .catch(() => {
        // Fallback to standard login view if status check fails
      })
      .finally(() => {
        if (active) setCheckingStatus(false)
      })
    return () => { active = false }
  }, [])

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true)
    setError('')
    setNotice('')

    try {
      if (!needsSetup && mode === 'reset') {
        const res = await fetch('/api/v1/auth/password-reset/confirm', {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: JSON.stringify({ resetToken, newPassword: password }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          setError(data.error || 'Password reset failed')
          return
        }
        setResetToken('')
        setPassword('')
        setMode('login')
        setNotice('Password updated. Sign in using your new password.')
        return
      }

      const endpoint = needsSetup
        ? '/api/v1/auth/setup'
        : mode === 'register'
        ? '/api/v1/auth/register'
        : '/api/v1/login'

      const payload =
        !needsSetup && mode === 'register'
          ? { email, password, displayName }
          : { email, password }

      const res = await fetch(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify(payload),
      })

      const data = await res.json().catch(() => ({}))

      if (!res.ok) {
        if (data?.needsSetup) {
          setNeedsSetup(true)
        }
        setError(data.error || 'Authentication failed')
        return
      }

      onLogin(data.token, data.user)
    } catch {
      setError('Could not connect to server')
    } finally {
      setLoading(false)
    }
  }

  const cardTitle = needsSetup
    ? 'Create Owner Account'
    : mode === 'register'
    ? 'Register Workspace Account'
    : mode === 'reset'
    ? 'Reset Account Password'
    : 'Sign in to your workspace'

  const cardHint = needsSetup
    ? 'First-time setup — create the primary platform Owner credentials.'
    : mode === 'register'
    ? 'Self-registration grants Viewer access until an administrator assigns a role.'
    : mode === 'reset'
    ? 'Enter the one-time reset token issued by your administrator and choose a new password.'
    : 'Enter your account email and password below'

  return (
    <div className="min-h-screen bg-[#f4f8f3] dark:bg-[#080C08] flex items-center justify-center px-4 py-12 relative">
      {onToggleTheme && (
        <button
          type="button"
          onClick={onToggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          className="absolute top-5 right-5 p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#101A10] text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-900"
        >
          {theme === 'dark' ? <Sun className="w-4 h-4 text-yellow-400" /> : <Moon className="w-4 h-4" />}
        </button>
      )}

      <div className="w-full max-w-md space-y-6">
        {/* Brand */}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-kathal-600 shadow-lg mb-2">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 2.5V5" stroke="#FACC15" strokeWidth="2" strokeLinecap="round" />
              <path d="M12.4 4.2c2.2-1.4 5-.9 6 .7-2 1-4.5.8-6-.7z" fill="#86EFAC" />
              <path d="M12 5c4.5 0 7 3.2 7 7.8 0 4.8-2.9 8.7-7 8.7s-7-3.9-7-8.7C5 8.2 7.5 5 12 5z" fill="#113F1B" stroke="#86EFAC" strokeWidth="1.4" />
              <ellipse cx="10.2" cy="11.8" rx="1.6" ry="2.4" transform="rotate(-14 10.2 11.8)" fill="#FACC15" />
              <ellipse cx="13.8" cy="12" rx="1.6" ry="2.4" transform="rotate(14 13.8 12)" fill="#FDE047" />
              <ellipse cx="12" cy="16" rx="1.7" ry="2.2" fill="#EAB308" />
            </svg>
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-100">KATHAL</h1>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Zero-code server control panel for your apps, databases, and domains
          </p>
        </div>

        {/* Auth Card */}
        <form
          onSubmit={handleSubmit}
          className="bg-white dark:bg-[#101A10] border border-slate-200 dark:border-slate-800 rounded-2xl p-7 space-y-5 shadow-sm"
        >
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{cardTitle}</h2>
            <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">{cardHint}</p>
          </div>

          {sessionNotice && !error && !notice && (
            <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg text-amber-800 dark:text-amber-300 text-xs">
              {sessionNotice}
            </div>
          )}

          {notice && (
            <div className="p-3 bg-green-500/10 border border-green-500/30 rounded-lg text-green-800 dark:text-green-300 text-xs">
              {notice}
            </div>
          )}

          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-700 dark:text-red-400 text-xs">
              {error}
            </div>
          )}

          <div className="space-y-4">
            {!needsSetup && mode === 'reset' ? (
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  One-Time Reset Token
                </label>
                <input
                  type="text"
                  value={resetToken}
                  onChange={(e) => setResetToken(e.target.value)}
                  placeholder="Paste reset token"
                  required
                  className="w-full px-3.5 py-2.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-sm font-mono text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:border-kathal-500 transition-colors"
                />
              </div>
            ) : (
              <>
                {!needsSetup && mode === 'register' && (
                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      Display Name
                    </label>
                    <input
                      type="text"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder="Alex Rivera"
                      className="w-full px-3.5 py-2.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-sm text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:border-kathal-500 transition-colors"
                    />
                  </div>
                )}

                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    Email address
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="admin@example.com"
                    required
                    className="w-full px-3.5 py-2.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-sm text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:border-kathal-500 transition-colors"
                  />
                </div>
              </>
            )}

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {needsSetup || mode === 'register' || mode === 'reset'
                  ? 'Password (min. 6 characters)'
                  : 'Password'}
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={needsSetup || mode !== 'login' ? 'At least 6 characters' : 'Enter your password'}
                  minLength={needsSetup || mode !== 'login' ? 6 : undefined}
                  required
                  className="w-full px-3.5 py-2.5 pr-10 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-sm text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:border-kathal-500 transition-colors"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((s) => !s)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-900 dark:hover:text-slate-200"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading || checkingStatus}
            className="w-full py-2.5 px-4 bg-kathal-600 hover:bg-kathal-500 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 inline-flex items-center justify-center gap-2"
          >
            {needsSetup && <ShieldCheck className="w-4 h-4" />}
            {!needsSetup && mode === 'reset' && <KeyRound className="w-4 h-4" />}
            {!needsSetup && mode === 'register' && <UserPlus className="w-4 h-4" />}
            <span>
              {checkingStatus
                ? 'Checking workspace...'
                : loading
                ? 'Submitting...'
                : needsSetup
                ? 'Create Owner Account & Enter'
                : mode === 'register'
                ? 'Register & Sign In'
                : mode === 'reset'
                ? 'Apply New Password'
                : 'Sign In'}
            </span>
            <ArrowRight className="w-4 h-4" />
          </button>

          {!needsSetup && (
            <div className="pt-2 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs">
              {mode !== 'login' ? (
                <button
                  type="button"
                  onClick={() => { setMode('login'); setError('') }}
                  className="text-kathal-700 dark:text-kathal-400 hover:underline font-medium"
                >
                  Back to sign in
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => { setMode('reset'); setError(''); setNotice('') }}
                  className="text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
                >
                  Reset password with token
                </button>
              )}

              {allowSelfRegistration && mode !== 'register' && (
                <button
                  type="button"
                  onClick={() => { setMode('register'); setError(''); setNotice('') }}
                  className="text-kathal-700 dark:text-kathal-400 hover:underline font-medium"
                >
                  Register account
                </button>
              )}
            </div>
          )}
        </form>
      </div>
    </div>
  )
}
