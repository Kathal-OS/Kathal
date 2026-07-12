import { useState, useEffect } from 'react'
import { apiFetch } from '../hooks/useApi'

export default function Monitoring() {
  const [current, setCurrent] = useState(null)
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedContainer, setSelectedContainer] = useState(null)

  useEffect(() => {
    loadData()
    const interval = setInterval(loadData, 2000)
    return () => clearInterval(interval)
  }, [])

  async function loadData() {
    try {
      const [curr, hist] = await Promise.all([
        apiFetch('/api/v1/monitoring/current'),
        apiFetch('/api/v1/monitoring/history'),
      ])
      setCurrent(curr)
      setHistory(hist || [])
      setLoading(false)
    } catch (e) {
      console.error(e)
      setLoading(false)
    }
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
  }

  function formatPercent(p) {
    return p ? p.toFixed(1) + '%' : 'N/A'
  }

  const cpuColor = current?.cpu?.percent > 80 ? '#ef4444' : current?.cpu?.percent > 50 ? '#eab308' : '#22c55e'
  const memColor = current?.memory?.percent > 80 ? '#ef4444' : current?.memory?.percent > 50 ? '#eab308' : '#22c55e'

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ margin: '0 0 24px' }}>System Monitoring</h2>

      {/* Overview Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16, marginBottom: 24 }}>
        <MetricCard
          icon="💻"
          label="CPU"
          value={formatPercent(current?.cpu?.percent)}
          color={cpuColor}
          detail={`${current?.cpu?.cores || 0} cores`}
        />
        <MetricCard
          icon="🧠"
          label="Memory"
          value={formatPercent(current?.memory?.percent)}
          color={memColor}
          detail={`${formatBytes(current?.memory?.used)} / ${formatBytes(current?.memory?.total)}`}
        />
        <MetricCard
          icon="💾"
          label="Disk"
          value={formatPercent(current?.disk?.percent)}
          color="#3b82f6"
          detail={`${formatBytes(current?.disk?.used)} / ${formatBytes(current?.disk?.total)}`}
        />
        <MetricCard
          icon="🌐"
          label="Network"
          value={formatBytes(current?.network?.bytesRecv || 0) + ' ↓ / ' + formatBytes(current?.network?.bytesSent || 0) + ' ↑'}
          color="#8b5cf6"
          detail="Since boot"
        />
      </div>

      {/* Container Stats */}
      <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: 16 }}>
        <h3 style={{ margin: '0 0 16px' }}>Container Resource Usage</h3>
        {current?.containers?.length === 0 ? (
          <p style={{ color: '#64748b', textAlign: 'center', padding: 32 }}>No containers running</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #334155' }}>
                  <th style={thStyle}>Container</th>
                  <th style={thStyle}>CPU %</th>
                  <th style={thStyle}>Memory</th>
                  <th style={thStyle}>Network</th>
                  <th style={thStyle}>Block I/O</th>
                  <th style={thStyle}>PIDs</th>
                </tr>
              </thead>
              <tbody>
                {current?.containers?.map(c => (
                  <tr key={c.id} style={{ borderBottom: '1px solid #1e293b', cursor: 'pointer' }} onClick={() => setSelectedContainer(c)}>
                    <td style={tdStyle}>{c.name}</td>
                    <td style={tdStyle}>{c.cpuPercent?.toFixed(1) || 'N/A'}</td>
                    <td style={tdStyle}>
                      {c.memoryUsage ? formatBytes(c.memoryUsage) : 'N/A'}
                      {c.memoryLimit ? ` / ${formatBytes(c.memoryLimit)}` : ''}
                    </td>
                    <td style={tdStyle}>
                      ↓{formatBytes(c.netIO?.rxBytes)} ↑{formatBytes(c.netIO?.txBytes)}
                    </td>
                    <td style={tdStyle}>
                      R:{formatBytes(c.blockIO?.readBytes)} W:{formatBytes(c.blockIO?.writeBytes)}
                    </td>
                    <td style={tdStyle}>{c.pids || 'N/A'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* History Charts (simplified) */}
      {history.length > 0 && (
        <div style={{ marginTop: 24, background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: 16 }}>
          <h3 style={{ margin: '0 0 16px' }}>History (last {history.length} samples)</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
            <Sparkline data={history.map(h => h.cpu?.percent || 0)} color={cpuColor} label="CPU %" />
            <Sparkline data={history.map(h => h.memory?.percent || 0)} color={memColor} label="Memory %" />
            <Sparkline data={history.map(h => (h.network?.bytesRecv || 0) / 1024)} color="#3b82f6" label="Net Recv KB/s" />
            <Sparkline data={history.map(h => (h.network?.bytesSent || 0) / 1024)} color="#8b5cf6" label="Net Sent KB/s" />
          </div>
        </div>
      )}

      {/* Container Logs Modal */}
      {selectedContainer && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }} onClick={() => setSelectedContainer(null)}>
          <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 16, padding: 24, width: '80%', maxWidth: 800, maxHeight: '70vh', overflow: 'auto' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
              <h3 style={{ margin: 0 }}>{selectedContainer.name} - Logs</h3>
              <button onClick={() => setSelectedContainer(null)} style={{ background: '#334155', border: 'none', borderRadius: 6, color: 'white', padding: '8px 16px', cursor: 'pointer' }}>Close</button>
            </div>
            <pre style={{ color: '#94a3b8', fontSize: 12, whiteSpace: 'pre-wrap', maxHeight: '60vh', overflow: 'auto' }}>
              Loading logs...
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}

function MetricCard({ icon, label, value, color, detail }) {
  return (
    <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <span style={{ fontSize: 28 }}>{icon}</span>
        <div>
          <div style={{ color: '#94a3b8', fontSize: 13 }}>{label}</div>
          <div style={{ color: color, fontSize: 24, fontWeight: 600 }}>{value}</div>
        </div>
      </div>
      <div style={{ color: '#64748b', fontSize: 12 }}>{detail}</div>
    </div>
  )
}

function Sparkline({ data, color, label }) {
  if (!data.length) return null
  const max = Math.max(...data) || 1
  const min = Math.min(...data)
  const height = 60
  const width = data.length * 3
  const points = data.map((v, i) => `${i * 3},${height - ((v - min) / (max - min) * height)}`).join(' ')
  
  return (
    <div>
      <div style={{ color: '#94a3b8', fontSize: 12, marginBottom: 8 }}>{label}</div>
      <svg width="100%" height={height} style={{ background: '#0f172a', borderRadius: 8 }}>
        <polyline
          fill="none"
          stroke={color}
          strokeWidth="2"
          points={points}
        />
      </svg>
      <div style={{ color: '#64748b', fontSize: 11, marginTop: 4 }}>Latest: {data[data.length-1]?.toFixed(1) || 0}</div>
    </div>
  )
}

const thStyle = { textAlign: 'left', padding: '12px', color: '#94a3b8', fontSize: 12, fontWeight: 600 }
const tdStyle = { padding: '12px', color: '#e2e8f0', fontSize: 13 }