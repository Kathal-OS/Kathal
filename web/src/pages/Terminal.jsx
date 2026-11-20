import { useState, useEffect, useRef } from 'react'
import { apiFetch, apiPost } from '../hooks/useApi'

export default function Terminal() {
  const termRef = useRef(null)
  const wsRef = useRef(null)
  const [connected, setConnected] = useState(false)
  const [sessionId, setSessionId] = useState(null)
  const [dims, setDims] = useState({ cols: 120, rows: 30 })

  useEffect(() => {
    startSession()
    return () => closeSession()
  }, [])

  async function startSession() {
    try {
      const token = localStorage.getItem('kathal_token')
      const result = await apiPost('/api/v1/terminal/sessions', {
        cols: dims.cols,
        rows: dims.rows,
      })
      const id = result.id || result.session_id
      setSessionId(id)

      // Connect WebSocket
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const wsUrl = `${proto}//${window.location.host}/api/v1/terminal/ws/${id}?token=${token}`
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        setConnected(true)
        initTerminal(id)
      }

      ws.onmessage = (event) => {
        if (window.term) {
          window.term.write(event.data)
        }
      }

      ws.onclose = () => setConnected(false)
      ws.onerror = () => setConnected(false)
    } catch (e) {
      console.error('Failed to start terminal:', e)
    }
  }

  async function initTerminal(sessionId) {
    // Dynamic import xterm
    try {
      const { Terminal } = await import('@xterm/xterm')
      const { FitAddon } = await import('@xterm/addon-fit')
      await import('@xterm/xterm/css/xterm.css')

      if (!termRef.current) return
      if (window.term) { window.term.dispose() }

      const term = new Terminal({
        theme: {
          background: '#0f172a',
          foreground: '#e2e8f0',
          cursor: '#3b82f6',
          selectionBackground: '#334155',
        },
        fontFamily: '"Cascadia Code", "Fira Code", monospace',
        fontSize: 14,
        cursorBlink: true,
      })

      const fitAddon = new FitAddon()
      term.loadAddon(fitAddon)
      term.open(termRef.current)
      window.term = term

      term.onData((data) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'input', data }))
        }
      })

      // Fit after short delay
      setTimeout(() => fitAddon.fit(), 100)

      // Handle resize
      const resizeHandler = () => fitAddon.fit()
      window.addEventListener('resize', resizeHandler)

      term.onResize(({ cols, rows }) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'resize', cols, rows }))
        }
      })
    } catch (e) {
      console.error('Failed to init xterm:', e)
      // Fallback: show text terminal
      termRef.current.innerHTML = '<div style="padding:16px;color:#94a3b8;font-family:monospace">Web terminal requires @xterm/xterm package. Install: npm install @xterm/xterm @xterm/addon-fit</div>'
    }
  }

  async function closeSession() {
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
    if (sessionId) {
      try {
        await apiFetch(`/api/v1/terminal/sessions/${sessionId}`, { method: 'DELETE' })
      } catch (e) { /* ignore */ }
    }
    if (window.term) {
      window.term.dispose()
      window.term = null
    }
    setConnected(false)
  }

  return (
    <div style={{ padding: 24, height: 'calc(100vh - 48px)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Terminal</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{
            display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
            background: connected ? '#22c55e' : '#ef4444'
          }} />
          <span style={{ color: '#94a3b8', fontSize: 13 }}>
            {connected ? 'Connected' : 'Disconnected'}
          </span>
          {!connected && (
            <button onClick={startSession}
              style={{ padding: '6px 12px', background: '#3b82f6', border: 'none', borderRadius: 6, color: 'white', cursor: 'pointer', fontSize: 12 }}>
              Reconnect
            </button>
          )}
        </div>
      </div>

      <div ref={termRef}
        style={{
          flex: 1,
          background: '#0f172a',
          border: '1px solid #334155',
          borderRadius: 8,
          padding: 4,
          overflow: 'hidden',
        }}
      />

      <div style={{ marginTop: 8, display: 'flex', gap: 12, alignItems: 'center' }}>
        <span style={{ color: '#64748b', fontSize: 11 }}>
          Shell: /bin/bash · Session: {sessionId || 'none'}
        </span>
      </div>
    </div>
  )
}
