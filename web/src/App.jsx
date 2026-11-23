import { useState, useEffect, useCallback } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import TopBar from './components/TopBar'
import QuickLaunchModal from './components/QuickLaunchModal'
import OfflineIndicator from './components/OfflineIndicator'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Containers from './pages/Containers'
import NativeProcesses from './pages/NativeProcesses'
import Images from './pages/Images'
import ProxyManager from './pages/ProxyManager'
import Databases from './pages/Databases'
import FileManager from './pages/FileManager'
import Backups from './pages/Backups'
import Templates from './pages/Templates'
import AppDetail from './pages/AppDetail'
import GitDeploy from './pages/GitDeploy'
import Terminal from './pages/Terminal'
import Monitoring from './pages/Monitoring'
import Logs from './pages/Logs'
import Compose from './pages/Compose'
import Env from './pages/Env'
import Network from './pages/Network'
import Volumes from './pages/Volumes'
import Registries from './pages/Registries'
import Settings from './pages/Settings'
import UsersRoles from './pages/UsersRoles'
import SecurityConsole from './pages/SecurityConsole'
import AuditLogs from './pages/AuditLogs'
import AccessDenied from './pages/AccessDenied'
import {
  setAuthToken,
  clearAuthToken,
  setUnauthorizedHandler,
  apiFetch,
  hasPermission,
  logoutSession,
} from './hooks/useApi'
import { useTheme } from './hooks/useTheme'

function ProtectedRoute({ children, authenticated }) {
  if (!authenticated) return <Navigate to="/login" replace />
  return children
}

function PermissionRoute({ children, authenticated, user, permission }) {
  if (!authenticated) return <Navigate to="/login" replace />
  if (permission && !hasPermission(user, permission)) {
    return <AccessDenied requiredPermission={permission} user={user} />
  }
  return children
}

export default function App() {
  const { theme, toggleTheme } = useTheme()
  const [token, setToken] = useState(null)
  const [user, setUser] = useState(null)
  const [authChecking, setAuthChecking] = useState(true)
  const [sessionNotice, setSessionNotice] = useState('')
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [quickLaunchOpen, setQuickLaunchOpen] = useState(false)
  const [deploySignal, setDeploySignal] = useState(0)
  const [updateInfo, setUpdateInfo] = useState(null)

  const authenticated = Boolean(user)

  const handleUnauthorized = useCallback((message) => {
    clearAuthToken()
    setToken(null)
    setUser(null)
    setUpdateInfo(null)
    if (message) setSessionNotice(message)
  }, [])

  useEffect(() => {
    // Purge any legacy browser storage tokens so stale JWTs never cause invalid-token errors
    try {
      localStorage.removeItem('kathal_token')
      localStorage.removeItem('kathal_user')
    } catch {
      // ignore storage access issues
    }
    setUnauthorizedHandler(handleUnauthorized)

    let active = true
    fetch('/api/v1/auth/session', {
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (active && data?.user) {
          setUser(data.user)
        }
      })
      .catch(() => {
        // Not signed in yet
      })
      .finally(() => {
        if (active) setAuthChecking(false)
      })

    return () => {
      active = false
      setUnauthorizedHandler(null)
    }
  }, [handleUnauthorized])

  useEffect(() => {
    if (!authenticated) return
    let cancelled = false
    apiFetch('/system/updates')
      .then((res) => {
        if (!cancelled && res) setUpdateInfo(res)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [authenticated, token])

  function handleLogin(newToken, newUser) {
    setAuthToken(newToken)
    setToken(newToken || 'cookie-session')
    setUser(newUser)
    setSessionNotice('')
  }

  async function handleLogout() {
    await logoutSession()
    setToken(null)
    setUser(null)
    setUpdateInfo(null)
    setSessionNotice('')
  }

  if (authChecking) {
    return (
      <div className="min-h-screen bg-[#f4f8f3] dark:bg-[#080C08] text-slate-600 dark:text-slate-400 flex items-center justify-center text-sm">
        Restoring workspace session...
      </div>
    )
  }

  if (!authenticated) {
    return (
      <Routes>
        <Route
          path="/login"
          element={
            <Login
              onLogin={handleLogin}
              sessionNotice={sessionNotice}
              theme={theme}
              onToggleTheme={toggleTheme}
            />
          }
        />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    )
  }

  return (
    <div className="flex h-screen bg-[#f4f8f3] dark:bg-[#080C08] text-slate-900 dark:text-slate-100 overflow-hidden">
      <Sidebar
        user={user}
        onLogout={handleLogout}
        mobileOpen={mobileNavOpen}
        onClose={() => setMobileNavOpen(false)}
      />

      <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
        <OfflineIndicator />
        <TopBar
          user={user}
          theme={theme}
          onToggleTheme={toggleTheme}
          onOpenMobileNav={() => setMobileNavOpen(true)}
          onOpenQuickLaunch={() => setQuickLaunchOpen(true)}
          updateInfo={updateInfo}
        />

        <main className="flex-1 overflow-y-auto">
          <Routes>
            <Route
              path="/"
              element={
                <PermissionRoute authenticated={authenticated} user={user} permission="dashboard.read">
                  <Dashboard
                    externalRefreshKey={deploySignal}
                    onOpenQuickLaunch={hasPermission(user, 'applications.deploy') ? () => setQuickLaunchOpen(true) : undefined}
                    onUpdateChecked={setUpdateInfo}
                  />
                </PermissionRoute>
              }
            />
            <Route
              path="/containers"
              element={
                <PermissionRoute authenticated={authenticated} user={user} permission="containers.read">
                  <Containers key={deploySignal} />
                </PermissionRoute>
              }
            />
            <Route
              path="/processes"
              element={
                <PermissionRoute authenticated={authenticated} user={user} permission="containers.read">
                  <NativeProcesses key={deploySignal} />
                </PermissionRoute>
              }
            />
            <Route
              path="/images"
              element={
                <PermissionRoute authenticated={authenticated} user={user} permission="containers.read">
                  <Images />
                </PermissionRoute>
              }
            />
            <Route
              path="/registries"
              element={
                <PermissionRoute authenticated={authenticated} user={user} permission="containers.read">
                  <Registries />
                </PermissionRoute>
              }
            />
            <Route
              path="/volumes"
              element={
                <PermissionRoute authenticated={authenticated} user={user} permission="containers.read">
                  <Volumes />
                </PermissionRoute>
              }
            />
            <Route
              path="/proxy"
              element={
                <PermissionRoute authenticated={authenticated} user={user} permission="applications.read">
                  <ProxyManager />
                </PermissionRoute>
              }
            />
            <Route
              path="/databases"
              element={
                <PermissionRoute authenticated={authenticated} user={user} permission="databases.read">
                  <Databases />
                </PermissionRoute>
              }
            />
            <Route
              path="/files"
              element={
                <PermissionRoute authenticated={authenticated} user={user} permission="containers.read">
                  <FileManager />
                </PermissionRoute>
              }
            />
            <Route
              path="/backups"
              element={
                <PermissionRoute authenticated={authenticated} user={user} permission="backups.create">
                  <Backups />
                </PermissionRoute>
              }
            />
            <Route
              path="/templates"
              element={
                <PermissionRoute authenticated={authenticated} user={user} permission="applications.read">
                  <Templates />
                </PermissionRoute>
              }
            />
            <Route
              path="/templates/:id"
              element={
                <PermissionRoute authenticated={authenticated} user={user} permission="applications.read">
                  <AppDetail />
                </PermissionRoute>
              }
            />
            <Route
              path="/git"
              element={
                <PermissionRoute authenticated={authenticated} user={user} permission="applications.deploy">
                  <GitDeploy />
                </PermissionRoute>
              }
            />
            <Route
              path="/terminal"
              element={
                <PermissionRoute authenticated={authenticated} user={user} permission="terminal.access">
                  <Terminal />
                </PermissionRoute>
              }
            />
            <Route
              path="/monitoring"
              element={
                <PermissionRoute authenticated={authenticated} user={user} permission="servers.read">
                  <Monitoring currentUser={user} />
                </PermissionRoute>
              }
            />
            <Route
              path="/logs"
              element={
                <PermissionRoute authenticated={authenticated} user={user} permission="containers.read">
                  <Logs />
                </PermissionRoute>
              }
            />
            <Route
              path="/compose"
              element={
                <PermissionRoute authenticated={authenticated} user={user} permission="containers.read">
                  <Compose />
                </PermissionRoute>
              }
            />
            <Route
              path="/env"
              element={
                <PermissionRoute authenticated={authenticated} user={user} permission="secrets.read">
                  <Env />
                </PermissionRoute>
              }
            />
            <Route
              path="/network"
              element={
                <PermissionRoute authenticated={authenticated} user={user} permission="containers.read">
                  <Network />
                </PermissionRoute>
              }
            />
            <Route
              path="/users"
              element={
                <PermissionRoute authenticated={authenticated} user={user} permission="users.read">
                  <UsersRoles currentUser={user} />
                </PermissionRoute>
              }
            />
            <Route
              path="/security"
              element={
                <ProtectedRoute authenticated={authenticated}>
                  <SecurityConsole currentUser={user} />
                </ProtectedRoute>
              }
            />
            <Route
              path="/audit"
              element={
                <PermissionRoute authenticated={authenticated} user={user} permission="audit.read">
                  <AuditLogs />
                </PermissionRoute>
              }
            />
            <Route
              path="/settings"
              element={
                <PermissionRoute authenticated={authenticated} user={user} permission="settings.read">
                  <Settings updateInfo={updateInfo} onUpdateChecked={setUpdateInfo} currentUser={user} />
                </PermissionRoute>
              }
            />
            <Route
              path="/access-denied"
              element={
                <ProtectedRoute authenticated={authenticated}>
                  <AccessDenied user={user} />
                </ProtectedRoute>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>

      {hasPermission(user, 'applications.deploy') && (
        <QuickLaunchModal
          open={quickLaunchOpen}
          onClose={() => setQuickLaunchOpen(false)}
          onDeployed={() => setDeploySignal((n) => n + 1)}
        />
      )}
    </div>
  )
}