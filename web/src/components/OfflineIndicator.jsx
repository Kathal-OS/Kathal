import { useState, useEffect } from 'react'
import { WifiOff } from 'lucide-react'

export default function OfflineIndicator() {
  const [online, setOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  )

  useEffect(() => {
    const onOnline = () => setOnline(true)
    const onOffline = () => setOnline(false)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [])

  if (online) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="bg-amber-500/15 border-b border-amber-500/30 px-4 py-2 text-xs text-amber-300 flex items-center justify-center gap-2 shrink-0"
    >
      <WifiOff className="w-3.5 h-3.5 shrink-0" />
      <span>Offline mode — cached interface active. Reconnect to manage host processes.</span>
    </div>
  )
}
