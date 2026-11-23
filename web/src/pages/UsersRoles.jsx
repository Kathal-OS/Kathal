import { useState, useEffect, useCallback } from 'react'
import {
  UserPlus,
  Users,
  Shield,
  KeyRound,
  Trash2,
  Power,
  Check,
  Copy,
  Monitor,
  RefreshCw,
} from 'lucide-react'
import { apiFetch, apiPost, apiPut, apiPatch, apiDelete, hasPermission, hasRole } from '../hooks/useApi'

export default function UsersRoles({ currentUser }) {
  const canManage = hasPermission(currentUser, 'users.manage')
  const isOwner = hasRole(currentUser, 'Owner')

  const [users, setUsers] = useState([])
  const [roles, setRoles] = useState([])
  const [permissions, setPermissions] = useState([])
  const [loading, setLoading] = useState(true)
  const [banner, setBanner] = useState(null)

  const [showCreate, setShowCreate] = useState(false)
  const [createForm, setCreateForm] = useState({
    email: '',
    displayName: '',
    password: '',
    role: 'Developer',
  })
  const [creating, setCreating] = useState(false)

  const [resetIssued, setResetIssued] = useState(null)
  const [copiedReset, setCopiedReset] = useState(false)

  const [sessionModalUser, setSessionModalUser] = useState(null)
  const [userSessions, setUserSessions] = useState([])
  const [sessionsLoading, setSessionsLoading] = useState(false)

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [u, r, p] = await Promise.all([
        apiFetch('/users'),
        apiFetch('/roles'),
        apiFetch('/permissions'),
      ])
      setUsers(Array.isArray(u) ? u : [])
      setRoles(Array.isArray(r) ? r : [])
      setPermissions(Array.isArray(p) ? p : [])
    } catch (err) {
      setBanner({ type: 'error', text: err.message || 'Failed to load identity inventory.' })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  async function handleCreateUser(e) {
    e.preventDefault()
    setCreating(true)
    setBanner(null)
    try {
      const created = await apiPost('/users', {
        email: createForm.email,
        displayName: createForm.displayName,
        password: createForm.password,
        roles: [createForm.role],
      })
      setBanner({ type: 'success', text: `Created user ${created.email} with role ${created.roles.join(', ')}.` })
      setCreateForm({ email: '', displayName: '', password: '', role: 'Developer' })
      setShowCreate(false)
      loadData()
    } catch (err) {
      setBanner({ type: 'error', text: err.message || 'Failed to create user.' })
    } finally {
      setCreating(false)
    }
  }

  async function handleRoleChange(userId, nextRole) {
    setBanner(null)
    try {
      const updated = await apiPut(`/users/${userId}/roles`, { roles: [nextRole] })
      setUsers((prev) => prev.map((u) => (u.id === userId ? updated : u)))
      setBanner({ type: 'success', text: `Updated role for ${updated.email} to ${nextRole}.` })
    } catch (err) {
      setBanner({ type: 'error', text: err.message || 'Role update failed.' })
    }
  }

  async function handleToggleActive(u) {
    setBanner(null)
    try {
      const updated = await apiPatch(`/users/${u.id}`, { isActive: !u.isActive })
      setUsers((prev) => prev.map((item) => (item.id === u.id ? updated : item)))
      setBanner({
        type: 'success',
        text: `${updated.email} is now ${updated.isActive ? 'active' : 'deactivated'}.`,
      })
    } catch (err) {
      setBanner({ type: 'error', text: err.message || 'Failed to update account status.' })
    }
  }

  async function handleDeleteUser(u) {
    setBanner(null)
    try {
      await apiDelete(`/users/${u.id}`)
      setUsers((prev) => prev.filter((item) => item.id !== u.id))
      setBanner({ type: 'success', text: `Removed user ${u.email}.` })
    } catch (err) {
      setBanner({ type: 'error', text: err.message || 'Failed to delete user.' })
    }
  }

  async function handleIssueResetToken(u) {
    setBanner(null)
    setResetIssued(null)
    try {
      const res = await apiPost('/auth/password-reset/request', { userId: u.id })
      setResetIssued({ ...res, email: u.email })
    } catch (err) {
      setBanner({ type: 'error', text: err.message || 'Failed to issue password reset token.' })
    }
  }

  async function handleCopyResetToken() {
    if (!resetIssued?.resetToken) return
    try {
      await navigator.clipboard?.writeText(resetIssued.resetToken)
      setCopiedReset(true)
      setTimeout(() => setCopiedReset(false), 1500)
    } catch {
      // ignore clipboard errors
    }
  }

  async function openSessionsModal(u) {
    setSessionModalUser(u)
    setSessionsLoading(true)
    try {
      const list = await apiFetch(`/users/${u.id}/sessions`)
      setUserSessions(Array.isArray(list) ? list : [])
    } catch (err) {
      setBanner({ type: 'error', text: err.message || 'Failed to load sessions.' })
      setSessionModalUser(null)
    } finally {
      setSessionsLoading(false)
    }
  }

  async function handleRevokeUserSession(userId, sessionId) {
    try {
      await apiDelete(`/users/${userId}/sessions/${sessionId}`)
      setUserSessions((prev) => prev.filter((s) => s.id !== sessionId))
    } catch (err) {
      setBanner({ type: 'error', text: err.message || 'Failed to revoke session.' })
    }
  }

  return (
    <div className="p-6 sm:p-8 max-w-7xl mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-slate-100">Users &amp; Access Control</h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            Manage platform accounts, role assignments, password reset tokens, and active sessions.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={loadData}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#101A10] text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-900 whitespace-nowrap"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Refresh</span>
          </button>
          {canManage && (
            <button
              type="button"
              onClick={() => setShowCreate((s) => !s)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-kathal-600 hover:bg-kathal-500 text-white text-xs font-medium whitespace-nowrap transition-colors"
            >
              <UserPlus className="w-4 h-4" />
              <span>{showCreate ? 'Close Form' : 'Create User'}</span>
            </button>
          )}
        </div>
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

      {resetIssued && (
        <div className="p-4 rounded-xl bg-yellow-500/10 border border-yellow-500/35 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-semibold text-yellow-800 dark:text-yellow-300">
              Single-Use Password Reset Token Issued for {resetIssued.email}
            </p>
            <button
              type="button"
              onClick={() => setResetIssued(null)}
              className="text-xs text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
            >
              Dismiss
            </button>
          </div>
          <p className="text-xs text-slate-700 dark:text-slate-300">
            Share this token securely with the user to complete password reset on the sign-in screen. Expires{' '}
            <span className="tabular-nums font-medium">{new Date(resetIssued.expiresAt).toLocaleString()}</span>.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 px-3 py-2 rounded-lg bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 font-mono text-xs text-slate-900 dark:text-slate-100 truncate">
              {resetIssued.resetToken}
            </code>
            <button
              type="button"
              onClick={handleCopyResetToken}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
            >
              {copiedReset ? <Check className="w-3.5 h-3.5 text-green-600 dark:text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copiedReset ? 'Copied' : 'Copy Token'}</span>
            </button>
          </div>
        </div>
      )}

      {showCreate && canManage && (
        <form
          onSubmit={handleCreateUser}
          className="bg-white dark:bg-[#101A10] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4"
        >
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">Create Workspace Account</h2>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">Email</label>
              <input
                type="email"
                required
                value={createForm.email}
                onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })}
                placeholder="operator@example.com"
                className="w-full px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-sm text-slate-900 dark:text-slate-100"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">Display Name</label>
              <input
                type="text"
                value={createForm.displayName}
                onChange={(e) => setCreateForm({ ...createForm, displayName: e.target.value })}
                placeholder="Alex Rivera"
                className="w-full px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-sm text-slate-900 dark:text-slate-100"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">Initial Password</label>
              <input
                type="password"
                required
                minLength={6}
                value={createForm.password}
                onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })}
                placeholder="Min. 6 characters"
                className="w-full px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-sm text-slate-900 dark:text-slate-100"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">Role</label>
              <select
                value={createForm.role}
                onChange={(e) => setCreateForm({ ...createForm, role: e.target.value })}
                className="w-full px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-sm text-slate-900 dark:text-slate-100"
              >
                {roles.map((r) => (
                  <option key={r.id} value={r.name} disabled={r.name === 'Owner' && !isOwner}>
                    {r.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-700 dark:text-slate-300"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={creating}
              className="px-4 py-2 rounded-lg bg-kathal-600 hover:bg-kathal-500 text-white text-xs font-medium disabled:opacity-50"
            >
              {creating ? 'Creating...' : 'Create Account'}
            </button>
          </div>
        </form>
      )}

      {/* Users Table */}
      <div className="bg-white dark:bg-[#101A10] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-kathal-600 dark:text-kathal-400" />
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              Platform Accounts ({users.length})
            </h2>
          </div>
        </div>

        {loading ? (
          <div className="py-10 text-center text-sm text-slate-500">Loading user accounts...</div>
        ) : users.length === 0 ? (
          <div className="py-10 text-center text-sm text-slate-500">No users registered.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
                  <th className="text-left py-2.5 px-3 font-medium">Account</th>
                  <th className="text-left py-2.5 px-3 font-medium">Role</th>
                  <th className="text-left py-2.5 px-3 font-medium">Status</th>
                  <th className="text-left py-2.5 px-3 font-medium">Last Login</th>
                  <th className="text-right py-2.5 px-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const isSelf = u.id === currentUser?.id
                  const targetIsOwner = u.roles?.includes('Owner')
                  const roleEditDisabled = !canManage || (isSelf && !isOwner) || (targetIsOwner && !isOwner)
                  return (
                    <tr
                      key={u.id}
                      className="border-b border-slate-100 dark:border-slate-800/60 hover:bg-slate-50 dark:hover:bg-slate-900/40"
                    >
                      <td className="py-3 px-3">
                        <p className="font-medium text-slate-900 dark:text-slate-100">
                          {u.displayName} {isSelf ? '(You)' : ''}
                        </p>
                        <p className="text-xs font-mono text-slate-500 dark:text-slate-400">{u.email}</p>
                      </td>
                      <td className="py-3 px-3">
                        {canManage ? (
                          <select
                            aria-label={`Role for ${u.email}`}
                            disabled={roleEditDisabled}
                            value={u.roles?.[0] || 'Viewer'}
                            onChange={(e) => handleRoleChange(u.id, e.target.value)}
                            className="px-2.5 py-1.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-xs text-slate-900 dark:text-slate-100 disabled:opacity-50"
                          >
                            {roles.map((r) => (
                              <option key={r.id} value={r.name} disabled={r.name === 'Owner' && !isOwner}>
                                {r.name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="text-xs font-medium text-slate-800 dark:text-slate-200">
                            {u.roles?.join(', ') || 'Viewer'}
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-3 text-xs font-medium">
                        <span className={u.isActive ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>
                          {u.isActive ? 'Active' : 'Deactivated'}
                        </span>
                      </td>
                      <td className="py-3 px-3 text-xs text-slate-500 dark:text-slate-400 tabular-nums whitespace-nowrap">
                        {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'Never'}
                      </td>
                      <td className="py-3 px-3 text-right whitespace-nowrap space-x-1.5">
                        <button
                          type="button"
                          onClick={() => openSessionsModal(u)}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 text-xs text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          <Monitor className="w-3.5 h-3.5" />
                          <span>Sessions</span>
                        </button>
                        {canManage && (
                          <>
                            <button
                              type="button"
                              onClick={() => handleIssueResetToken(u)}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 text-xs text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                            >
                              <KeyRound className="w-3.5 h-3.5" />
                              <span>Reset Token</span>
                            </button>
                            {!isSelf && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => handleToggleActive(u)}
                                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 text-xs text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                                >
                                  <Power className="w-3.5 h-3.5" />
                                  <span>{u.isActive ? 'Disable' : 'Enable'}</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteUser(u)}
                                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-red-500/10 hover:bg-red-600 text-red-700 dark:text-red-400 hover:text-white text-xs transition-colors"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                  <span>Delete</span>
                                </button>
                              </>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Role & Permission Matrix */}
      <div className="bg-white dark:bg-[#101A10] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4 text-yellow-600 dark:text-yellow-400" />
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Role Permission Matrix</h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
          {roles.map((role) => (
            <div
              key={role.id}
              className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 space-y-2"
            >
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{role.name}</h3>
                <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                  {role.userCount} user{role.userCount === 1 ? '' : 's'}
                </span>
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">{role.description}</p>
              <p className="text-xs font-mono text-kathal-700 dark:text-kathal-400 tabular-nums pt-1">
                {role.permissions.length} / {permissions.length} permissions
              </p>
            </div>
          ))}
        </div>

        <div className="overflow-x-auto pt-2">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400">
                <th className="text-left py-2 px-3 font-medium">Permission</th>
                <th className="text-left py-2 px-3 font-medium">Category</th>
                {roles.map((r) => (
                  <th key={r.id} className="text-center py-2 px-3 font-medium">{r.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {permissions.map((perm) => (
                <tr key={perm.id} className="border-b border-slate-100 dark:border-slate-800/50">
                  <td className="py-2 px-3 font-mono text-slate-800 dark:text-slate-200">{perm.name}</td>
                  <td className="py-2 px-3 text-slate-500 dark:text-slate-400">{perm.category}</td>
                  {roles.map((r) => {
                    const granted = r.permissions.includes(perm.name)
                    return (
                      <td key={r.id} className="py-2 px-3 text-center">
                        <span className={granted ? 'text-green-700 dark:text-green-400 font-medium' : 'text-slate-400 dark:text-slate-600'}>
                          {granted ? 'Allowed' : '—'}
                        </span>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* User Sessions Modal */}
      {sessionModalUser && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
          onClick={() => setSessionModalUser(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white dark:bg-[#101A10] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 max-w-2xl w-full space-y-4 max-h-[80vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                  Active Sessions — {sessionModalUser.email}
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Revoking a session immediately invalidates its token and closes active terminal WebSockets.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSessionModalUser(null)}
                className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs text-slate-700 dark:text-slate-300"
              >
                Close
              </button>
            </div>

            {sessionsLoading ? (
              <p className="py-6 text-center text-xs text-slate-500">Loading active sessions...</p>
            ) : userSessions.length === 0 ? (
              <p className="py-6 text-center text-xs text-slate-500">No active sessions found for this user.</p>
            ) : (
              <div className="divide-y divide-slate-200 dark:divide-slate-800">
                {userSessions.map((sess) => (
                  <div key={sess.id} className="py-3 flex flex-wrap items-center justify-between gap-3 text-xs">
                    <div className="space-y-0.5">
                      <p className="font-mono font-medium text-slate-900 dark:text-slate-100">
                        {sess.id} {sess.isCurrent ? '· Current Session' : ''}
                      </p>
                      <p className="text-slate-500 dark:text-slate-400 tabular-nums">
                        {sess.authMethod} · IP {sess.ipAddress} · Last seen {new Date(sess.lastSeenAt).toLocaleString()}
                      </p>
                    </div>
                    {canManage && !sess.isCurrent && (
                      <button
                        type="button"
                        onClick={() => handleRevokeUserSession(sessionModalUser.id, sess.id)}
                        className="px-3 py-1.5 rounded-lg bg-red-500/10 hover:bg-red-600 text-red-700 dark:text-red-400 hover:text-white font-medium transition-colors"
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
      )}
    </div>
  )
}
