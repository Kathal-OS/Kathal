import { useState, useEffect } from 'react'
import { Routes, Route, NavLink, Navigate } from 'react-router-dom'
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
import Settings from './pages/Settings'

const nav = [
  { to: '/',           icon: '📊', label: 'Dashboard' },
  { to: '/containers', icon: '🐳', label: 'Containers' },
  { to: '/images',     icon: '📦', label: 'Images' },
  { to: '/proxy',      icon: '🔀', label: 'Proxy' },
  { to: '/databases',  icon: '🗄️', label: 'Databases' },
  { to: '/files',      icon: '📂', label: 'Files' },
  { to: '/backups',    icon: '💾', label: 'Backups' },
  { to: '/templates',  icon: '🧩', label: 'Templates' },
  { to: '/git',        icon: '📦', label: 'Git Deploy' },
  { to: '/terminal',   icon: '💻', label: 'Terminal' },
  { to: '/monitoring', icon: '📈', label: 'Monitoring' },
  { to: '/logs',       icon: '📋', label: 'Logs' },
  { to: '/compose',    icon: '📦', label: 'Compose' },
  { to: '/env',        icon: '🔐', label: 'Environment' },
  { to: '/network',    icon: '🌐', label: 'Network' },
  { to: '/settings',   icon: '⚙️', label: 'Settings' },
]

function ProtectedRoute({ children, token }) {
  if (!token) return <Navigate to="/login" replace />
  return children
}

export default function App() {
  const [token, setToken] = useState(null)
  const [user, setUser] = useState(null)

  useEffect(() => {
    const savedToken = localStorage.getItem('kathal_token')
    const savedUser = localStorage.getItem('kathal_user')
    if (savedToken) {
      setToken(savedToken)
      try { setUser(JSON.parse(savedUser)) } catch {}
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
    <div className="flex h-screen bg-gray-950">
      {/* Sidebar */}
      <aside className="w-64 bg-gray-900 border-r border-gray-800 flex flex-col">
        {/* Logo */}
        <div className="p-6 border-b border-gray-800">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <span className="text-3xl">🍈</span>
            <span className="bg-gradient-to-r from-kathal-400 to-kathal-600 bg-clip-text text-transparent">
              KATHAL
            </span>
          </h1>
          <p className="text-xs text-gray-500 mt-1">Portable OS Dashboard</p>
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
          {nav.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 px-4 py-3 rounded-lg text-sm transition-colors ${
                  isActive
                    ? 'bg-kathal-600/20 text-kathal-400'
                    : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                }`
              }
            >
              <span className="text-lg">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        {/* User */}
        <div className="p-4 border-t border-gray-800">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">{user?.email || 'admin'}</p>
              <p className="text-xs text-gray-600">KATHAL v0.1.0</p>
            </div>
            <button
              onClick={handleLogout}
              className="text-gray-500 hover:text-red-400 transition-colors text-sm"
              title="Logout"
            >
              🚪
            </button>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <Routes>
          <Route path="/" element={<ProtectedRoute token={token}><Dashboard /></ProtectedRoute>} />
          <Route path="/containers" element={<ProtectedRoute token={token}><Containers /></ProtectedRoute>} />
          <Route path="/images" element={<ProtectedRoute token={token}><Images /></ProtectedRoute>} />
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
  )
}