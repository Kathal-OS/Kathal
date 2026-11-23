import { useState, useEffect, useRef, useCallback } from 'react'
import { apiFetch, apiPost } from '../hooks/useApi'

export default function Terminal() {
  const termContainerRef = useRef(null)
  const termInstanceRef = useRef(null)
  const wsRef = useRef(null)
  const sessionIdRef = useRef(null)
  const resizeHandlerRef = useRef(null)

  const [connected, setConnected] = useState(false)
  const [sessionId, setSessionId] = useState(null)
  const [error, setError] = useState(null)

  const cleanup = useCallback(() => {
    if (resizeHandlerRef.current) {
      window.removeEventListener('resize', resizeHandlerRef.current)
      resizeHandlerRef.current = null
    }
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
    if (sessionIdRef.current) {
      const idToClose = sessionIdRef.current
      sessionIdRef.current = null
      apiFetch(`/terminal/sessions/${idToClose}`, { method: 'DELETE' }).catch(() => {})
    }
    if (termInstanceRef.current) {
      termInstanceRef.current.dispose()
      termInstanceRef.current = null
    }
    setConnected(false)
  }, [])

  const initTerminal = useCallback(async () => {
    try {
      const { Terminal: XTerm } = await import('@xterm/xterm')
      const { FitAddon } = await import('@xterm/addon-fit')
      await import('@xterm/xterm/css/xterm.css')

      if (!termContainerRef.current) return
      if (termInstanceRef.current) {
        termInstanceRef.current.dispose()
      }

      const term = new XTerm({
        theme: {
          background: '#030712',
          foreground: '#e5e7eb',
          cursor: '#e0644d',
          selectionBackground: '#374151',
        },
        fontFamily: '"Cascadia Code", "Fira Code", monospace',
        fontSize: 14,
        cursorBlink: true,
      })

      const fitAddon = new FitAddon()
      term.loadAddon(fitAddon)
      term.open(termContainerRef.current)
      termInstanceRef.current = term

      term.onData((data) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'input', data }))
        }
      })

      setTimeout(() => fitAddon.fit(), 100)

      const resizeHandler = () => fitAddon.fit()
      resizeHandlerRef.current = resizeHandler
      window.addEventListener('resize', resizeHandler)

      term.onResize(({ cols, rows }) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'resize', cols, rows }))
        }
      })
    } catch (e) {
      setError('Terminal renderer failed to initialize: ' + e.message)
    }
  }, [])

  const startSession = useCallback(async () => {
    cleanup()
    setError(null)
    try {
      const result = await apiPost('/terminal/sessions', { cols: 120, rows: 30 })
      const ticket = result.wsTicket || ''
      const id = result.id || result.session_id
      sessionIdRef.current = id
      setSessionId(id)

      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const wsUrl = `${proto}//${window.location.host}/api/v1/terminal/ws/${id}?ticket=${encodeURIComponent(ticket)}`
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = async () => {
        await initTerminal()
        setConnected(true)
      }

      ws.onmessage = (event) => {
        if (termInstanceRef.current) {
          termInstanceRef.current.write(event.data)
        }
      }

      ws.onclose = () => setConnected(false)
      ws.onerror = () => {
        setConnected(false)
        setError('WebSocket connection closed.')
      }
    } catch (e) {
      setError('Failed to start terminal session: ' + e.message)
    }
  }, [cleanup, initTerminal])

  useEffect(() => {
    startSession()
    return () => cleanup()
  }, [startSession, cleanup])

  return (
    <div className="p-8 h-screen flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
        <div>
          <h1 className="text-2xl font-bold">Web Terminal</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Interactive node shell · Session: {sessionId || 'initializing'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5 text-xs text-gray-300">
            <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-400' : 'bg-red-400'}`} />
            {connected ? 'Connected' : 'Disconnected'}
          </span>
          <button
            onClick={startSession}
            className="px-3 py-1.5 bg-kathal-600 hover:bg-kathal-500 text-white rounded-lg text-xs font-medium"
          >
            {connected ? 'New Session' : 'Reconnect'}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-3 p-3 rounded-lg bg-red-600/10 border border-red-600/30 text-red-400 text-xs">
          {error}
        </div>
      )}

      <div
        ref={termContainerRef}
        className="flex-1 bg-gray-950 border border-gray-800 rounded-xl p-2 overflow-hidden"
      />
    </div>
  )
}
