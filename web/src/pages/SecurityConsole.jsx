import { useState, useEffect, useCallback } from 'react'
import {
  Lock,
  KeyRound,
  Database,
  ShieldCheck,
  RefreshCw,
  HardDriveDownload,
  CheckCircle2,
  AlertTriangle,
  Monitor,
} from 'lucide-react'
import { apiFetch, apiPost, apiDelete, setAuthToken, hasPermission, hasRole } from '../hooks/useApi'

function formatBytes(bytes) {
  if (!bytes) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
}

export default function SecurityConsole({ currentUser }) {
  const canReadSettings = hasPermission(currentUser, 'settings.read')
  const canManageSettings = hasPermission(currentUser, 'settings.manage')
  const canCreateBackup = hasPermission(currentUser, 'backups.create')
  const isOwner = hasRole(currentUser, 'Owner')

  const [sessions, setSessions] = useState([])
  const [vaultStatus, setVaultStatus] = useState(null)
  const [vaultRecovery, setVaultRecovery] = useState(null)
  const [dbStatus, setDbStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [banner, setBanner] = useState(null)

  const [pwForm, setPwForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' })
  const [changingPw, setChangingPw] = useState(false)

  const [rotatingKey, setRotatingKey] = useState(false)
  const [integrityResult, setIntegrityResult] = useState(null)
  const [backingUpDb, setBackingUpDb] = useState(false)

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      const sessList = await apiFetch('/auth/sessions')
      setSessions(Array.isArray(sessList) ? sessList : [])

      if (canReadSettings) {
        const [vStat, vRec, dStat] = await Promise.all([
          apiFetch('/vault/status').catch(() => null),
          apiFetch('/vault/recovery').catch(() => null),
          apiFetch('/system/database/status').catch(() => null),
        ])
        setVaultStatus(vStat)
        setVaultRecovery(vRec)
        setDbStatus(dStat)
      }
    } catch (err) {
      setBanner({ type: 'error', text: err.message || 'Failed to load security telemetry.' })
    } finally {
      setLoading(false)
    }
  }, [canReadSettings])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  async function handleChangePassword(e) {
    e.preventDefault()
    setBanner(null)
    if (pwForm.newPassword !== pwForm.confirmPassword) {
      setBanner({ type: 'error', text: 'New password and confirmation do not match.' })
      return
    }
    setChangingPw(true)
    try {
      const res = await apiPost('/auth/change-password', {
        currentPassword: pwForm.currentPassword,
        newPassword: pwForm.newPassword,
      })
      if (res?.token) setAuthToken(res.token)
      setPwForm({ currentPassword: '', newPassword: '', confirmPassword: '' })
      setBanner({
        type: 'success',
        text: 'Password updated. All other active sessions have been revoked and your current session rotated.',
      })
      loadAll()
    } catch (err) {
      setBanner({ type: 'error', text: err.message || 'Failed to update password.' })
    } finally {
      setChangingPw(false)
    }
  }

  async function handleRevokeSession(sessionId) {
    setBanner(null)
    try {
      await apiDelete(`/auth/sessions/${sessionId}`)
      setSessions((prev) => prev.filter((s) => s.id !== sessionId))
      setBanner({ type: 'success', text: `Revoked session ${sessionId}.` })
    } catch (err) {
      setBanner({ type: 'error', text: err.message || 'Failed to revoke session.' })
    }
  }

  async function handleRotateVaultKey() {
    setRotatingKey(true)
    setBanner(null)
    try {
      const res = await apiPost('/vault/rotate', {})
      setBanner({
        type: 'success',
        text: `Vault master key rotated from ${res.previousKid} to ${res.newKid} (${res.reencryptedCount} encrypted record(s) re-wrapped).`,
      })
      loadAll()
    } catch (err) {
      setBanner({ type: 'error', text: err.message || 'Vault key rotation failed.' })
    } finally {
      setRotatingKey(false)
    }
  }

  async function handleIntegrityCheck() {
    setBanner(null)
    try {
      const res = await apiPost('/system/database/integrity', {})
      setIntegrityResult(res)
      setBanner({
        type: res.ok ? 'success' : 'error',
        text: res.ok
          ? 'SQLite integrity check and foreign key verification passed cleanly.'
          : `Database check flagged issue: ${res.integrity}`,
      })
    } catch (err) {
      setBanner({ type: 'error', text: err.message || 'Integrity check failed.' })
    }
  }

  async function handleBackupDb() {
    setBackingUpDb(true)
    setBanner(null)
    try {
      const res = await apiPost('/system/database/backup', {})
      setBanner({
        type: 'success',
        text: `Created hot SQLite backup ${res.filename} (${formatBytes(res.sizeBytes)}).`,
      })
    } catch (err) {
      setBanner({ type: 'error', text: err.message || 'Database backup failed.' })
    } finally {
      setBackingUpDb(false)
    }
  }

  return (
    <div className="p-6 sm:p-8 max-w-7xl mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-slate-100">Security, Vault &amp; Database</h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            Manage account credentials, active sessions, encrypted vault keys, and SQLite persistence health.
          </p>
        </div>
        <button
          type="button"
          onClick={loadAll}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#101A10] text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-900 whitespace-nowrap"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Refresh</span>
        </button>
      </div>

      {banner && (
        <div
          className={`p-3.5 rounded-xl border text-xs ${
            banner.type === 'error'
              ? 'bg-red-500/10 border-red-500/30 text-red-700 dark:text-red-400'
              : 'bg-green-500/10 border-green-500/30 text-green-700 dark:text-green-400'
          }`}
        >
          {banner.text}
        </div>
      )}

      {/* Password & Active Sessions */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <form
          onSubmit={handleChangePassword}
          className="bg-white dark:bg-[#101A10] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4"
        >
          <div className="flex items-center gap-2">
            <Lock className="w-4 h-4 text-kathal-600 dark:text-kathal-400" />
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Change Account Password</h2>
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400">
            Updating your password automatically rotates your current session and revokes all other active sessions.
          </p>

          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Current Password</label>
              <input
                type="password"
                required
                value={pwForm.currentPassword}
                onChange={(e) => setPwForm({ ...pwForm, currentPassword: e.target.value })}
                className="w-full px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-sm text-slate-900 dark:text-slate-100"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">New Password (min. 6 characters)</label>
              <input
                type="password"
                required
                minLength={6}
                value={pwForm.newPassword}
                onChange={(e) => setPwForm({ ...pwForm, newPassword: e.target.value })}
                className="w-full px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-sm text-slate-900 dark:text-slate-100"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Confirm New Password</label>
              <input
                type="password"
                required
                minLength={6}
                value={pwForm.confirmPassword}
                onChange={(e) => setPwForm({ ...pwForm, confirmPassword: e.target.value })}
                className="w-full px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-sm text-slate-900 dark:text-slate-100"
              />
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={changingPw}
              className="px-4 py-2 rounded-lg bg-kathal-600 hover:bg-kathal-500 text-white text-xs font-medium disabled:opacity-50"
            >
              {changingPw ? 'Updating Password...' : 'Update Password'}
            </button>
          </div>
        </form>

        <div className="bg-white dark:bg-[#101A10] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Monitor className="w-4 h-4 text-yellow-600 dark:text-yellow-400" />
              <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                Active Sessions ({sessions.length})
              </h2>
            </div>
          </div>

          {loading ? (
            <p className="py-8 text-center text-xs text-slate-500">Loading sessions...</p>
          ) : sessions.length === 0 ? (
            <p className="py-8 text-center text-xs text-slate-500">No active sessions.</p>
          ) : (
            <div className="divide-y divide-slate-200 dark:divide-slate-800 max-h-72 overflow-y-auto">
              {sessions.map((sess) => (
                <div key={sess.id} className="py-3 flex items-center justify-between gap-3 text-xs">
                  <div className="min-w-0 space-y-0.5">
                    <p className="font-mono font-medium text-slate-900 dark:text-slate-100 truncate">
                      {sess.id} {sess.isCurrent ? '· Current' : ''}
                    </p>
                    <p className="text-slate-500 dark:text-slate-400 tabular-nums truncate">
                      {sess.authMethod} · IP {sess.ipAddress} · Expires {new Date(sess.idleExpiresAt).toLocaleString()}
                    </p>
                  </div>
                  {!sess.isCurrent && (
                    <button
                      type="button"
                      onClick={() => handleRevokeSession(sess.id)}
                      className="px-2.5 py-1.5 rounded-lg bg-red-500/10 hover:bg-red-600 text-red-700 dark:text-red-400 hover:text-white font-medium shrink-0 transition-colors"
                    >
                      Revoke
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Vault Status & Key Rotation */}
      {canReadSettings && vaultStatus && (
        <div className="bg-white dark:bg-[#101A10] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-kathal-600 dark:text-kathal-400" />
              <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                Encryption Vault ({vaultStatus.needsRecovery ? 'Recovery Needed' : 'Unlocked'})
              </h2>
            </div>

            {isOwner && canManageSettings && !vaultStatus.needsRecovery && (
              <button
                type="button"
                onClick={handleRotateVaultKey}
                disabled={rotatingKey}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-kathal-600 hover:bg-kathal-500 text-white text-xs font-medium disabled:opacity-50"
              >
                <ShieldCheck className="w-3.5 h-3.5" />
                <span>{rotatingKey ? 'Rotating Key...' : 'Rotate Vault Master Key'}</span>
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800">
              <p className="text-slate-500 dark:text-slate-400">Active Key ID</p>
              <p className="font-mono font-semibold text-slate-900 dark:text-slate-100 mt-1">{vaultStatus.activeKid}</p>
            </div>
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800">
              <p className="text-slate-500 dark:text-slate-400">Key Source</p>
              <p className="font-mono font-semibold text-slate-900 dark:text-slate-100 mt-1">{vaultStatus.keySource}</p>
            </div>
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800">
              <p className="text-slate-500 dark:text-slate-400">Registered Keys</p>
              <p className="font-mono font-semibold tabular-nums text-slate-900 dark:text-slate-100 mt-1">
                {vaultStatus.keys?.length || 0}
              </p>
            </div>
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800">
              <p className="text-slate-500 dark:text-slate-400">Ciphertext Format</p>
              <p className="font-mono font-semibold text-slate-900 dark:text-slate-100 mt-1">AES-256-GCM (enc:v2)</p>
            </div>
          </div>

          {vaultRecovery?.locked && (
            <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/30 space-y-2 text-xs text-red-700 dark:text-red-300">
              <div className="flex items-center gap-2 font-semibold">
                <AlertTriangle className="w-4 h-4" />
                <span>Vault Recovery Required: {vaultRecovery.reason}</span>
              </div>
              <ul className="list-disc pl-5 space-y-1">
                {(vaultRecovery.steps || []).map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* SQLite Persistence & Migrations */}
      {canReadSettings && dbStatus && (
        <div className="bg-white dark:bg-[#101A10] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Database className="w-4 h-4 text-kathal-600 dark:text-kathal-400" />
              <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                SQLite Database &amp; Migrations
              </h2>
            </div>

            <div className="flex items-center gap-2">
              {canManageSettings && (
                <button
                  type="button"
                  onClick={handleIntegrityCheck}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-xs font-medium text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <CheckCircle2 className="w-3.5 h-3.5 text-green-600 dark:text-green-400" />
                  <span>Integrity Check</span>
                </button>
              )}
              {canCreateBackup && (
                <button
                  type="button"
                  onClick={handleBackupDb}
                  disabled={backingUpDb}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-kathal-600 hover:bg-kathal-500 text-white text-xs font-medium disabled:opacity-50"
                >
                  <HardDriveDownload className="w-3.5 h-3.5" />
                  <span>{backingUpDb ? 'Backing Up...' : 'Hot DB Backup'}</span>
                </button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-xs">
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800">
              <p className="text-slate-500 dark:text-slate-400">Schema Version</p>
              <p className="font-mono font-semibold tabular-nums text-slate-900 dark:text-slate-100 mt-1">
                v{dbStatus.migrationVersion}
              </p>
            </div>
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800">
              <p className="text-slate-500 dark:text-slate-400">Journal Mode</p>
              <p className="font-mono font-semibold uppercase text-slate-900 dark:text-slate-100 mt-1">
                {dbStatus.walMode || 'wal'}
              </p>
            </div>
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800">
              <p className="text-slate-500 dark:text-slate-400">Foreign Keys</p>
              <p className="font-semibold text-green-700 dark:text-green-400 mt-1">
                {dbStatus.foreignKeysEnabled ? 'Enforced' : 'Off'}
              </p>
            </div>
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800">
              <p className="text-slate-500 dark:text-slate-400">Database Size</p>
              <p className="font-mono font-semibold tabular-nums text-slate-900 dark:text-slate-100 mt-1">
                {formatBytes(dbStatus.sizeBytes)}
              </p>
            </div>
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 col-span-2 md:col-span-1">
              <p className="text-slate-500 dark:text-slate-400">Integrity</p>
              <p className="font-semibold text-green-700 dark:text-green-400 mt-1">
                {(integrityResult ? integrityResult.ok : dbStatus.integrityOk) ? 'Healthy' : 'Check Needed'}
              </p>
            </div>
          </div>

          <p className="text-xs font-mono text-slate-500 dark:text-slate-400 truncate">
            Database file: {dbStatus.dbPath}
          </p>
        </div>
      )}
    </div>
  )
}
