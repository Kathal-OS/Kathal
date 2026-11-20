import { useState, useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import TopBar from './components/TopBar'
import QuickLaunchModal from './components/QuickLaunchModal'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Containers from './pages/Containers'
import Images from './pages/Images'
import ProxyManager from './pages/ProxyManager'
import Databases from './pages/Databases'
import FileManager from './pages/FileManager'
import Backups from './pages/Backups'
import Templates from './pages/Templates'
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

function ProtectedRoute({ children, token }) {
  if (!token) return <Navigate to="/login" replace />
  return children
}

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem('kathal_token'))
  const [user, setUser] = useState(() => {
    try {
      const saved = localStorage.getItem('kathal_user')
      return saved ? JSON.parse(saved) : null
    } catch {
      return null
    }
  })
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [quickLaunchOpen, setQuickLaunchOpen] = useState(false)
  const [deploySignal, setDeploySignal] = useState(0)

  useEffect(() => {
    const savedToken = localStorage.getItem('kathal_token')
    const savedUser = localStorage.getItem('kathal_user')
    if (savedToken) {
      setToken(savedToken)
      try {
        setUser(JSON.parse(savedUser))
      } catch {
        // ignore invalid user payload
      }
    }
  }, [])

  function handleLogin(newToken, newUser) {
    setToken(newToken)
    setUser(newUser)
  }

  function handleLogout() {
    localStorage.removeItem('kathal_token')
    localStorage.removeItem('kathal_user')
    setToken(null)
    setUser(null)
  }

  if (!token) {
    return (
      <Routes>
        <Route path="/login" element={<Login onLogin={handleLogin} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    )
  }

  return (
    <div className="flex h-screen bg-[#0B0F17] text-slate-100 overflow-hidden">
      <Sidebar
        user={user}
        onLogout={handleLogout}
        mobileOpen={mobileNavOpen}
        onClose={() => setMobileNavOpen(false)}
      />

      <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
        <TopBar
          onOpenMobileNav={() => setMobileNavOpen(true)}
          onOpenQuickLaunch={() => setQuickLaunchOpen(true)}
        />

        <main className="flex-1 overflow-y-auto">
          <Routes>
            <Route
              path="/"
              element={
                <ProtectedRoute token={token}>
                  <Dashboard
                    externalRefreshKey={deploySignal}
                    onOpenQuickLaunch={() => setQuickLaunchOpen(true)}
                  />
                </ProtectedRoute>
              }
            />
            <Route path="/containers" element={<ProtectedRoute token={token}><Containers key={deploySignal} /></ProtectedRoute>} />
            <Route path="/images" element={<ProtectedRoute token={token}><Images /></ProtectedRoute>} />
            <Route path="/registries" element={<ProtectedRoute token={token}><Registries /></ProtectedRoute>} />
            <Route path="/volumes" element={<ProtectedRoute token={token}><Volumes /></ProtectedRoute>} />
            <Route path="/proxy" element={<ProtectedRoute token={token}><ProxyManager /></ProtectedRoute>} />
            <Route path="/databases" element={<ProtectedRoute token={token}><Databases /></ProtectedRoute>} />
            <Route path="/files" element={<ProtectedRoute token={token}><FileManager /></ProtectedRoute>} />
            <Route path="/backups" element={<ProtectedRoute token={token}><Backups /></ProtectedRoute>} />
            <Route path="/templates" element={<ProtectedRoute token={token}><Templates /></ProtectedRoute>} />
            <Route path="/git" element={<ProtectedRoute token={token}><GitDeploy /></ProtectedRoute>} />
            <Route path="/terminal" element={<ProtectedRoute token={token}><Terminal /></ProtectedRoute>} />
            <Route path="/monitoring" element={<ProtectedRoute token={token}><Monitoring /></ProtectedRoute>} />
            <Route path="/logs" element={<ProtectedRoute token={token}><Logs /></ProtectedRoute>} />
            <Route path="/compose" element={<ProtectedRoute token={token}><Compose /></ProtectedRoute>} />
            <Route path="/env" element={<ProtectedRoute token={token}><Env /></ProtectedRoute>} />
            <Route path="/network" element={<ProtectedRoute token={token}><Network /></ProtectedRoute>} />
            <Route path="/settings" element={<ProtectedRoute token={token}><Settings /></ProtectedRoute>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>

      <QuickLaunchModal
        open={quickLaunchOpen}
        onClose={() => setQuickLaunchOpen(false)}
        onDeployed={() => setDeploySignal((n) => n + 1)}
      />
    </div>
  )
}