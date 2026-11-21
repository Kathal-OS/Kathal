import { useState, useEffect, useCallback } from 'react'

function detectPlatform() {
  if (typeof navigator === 'undefined') return 'desktop'
  const ua = navigator.userAgent.toLowerCase()
  if (/iphone|ipad|ipod/.test(ua)) return 'ios'
  if (/android/.test(ua)) return 'android'
  if (/macintosh|mac os x/.test(ua)) return 'macos'
  if (/windows/.test(ua)) return 'windows'
  return 'linux'
}

function checkStandaloneMode() {
  if (typeof window === 'undefined') return false
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: window-controls-overlay)').matches ||
    window.navigator.standalone === true
  )
}

export function usePWAInstall() {
  const [deferredPrompt, setDeferredPrompt] = useState(null)
  const [isInstalled, setIsInstalled] = useState(() => checkStandaloneMode())
  const [platform] = useState(() => detectPlatform())
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    const mq = window.matchMedia('(display-mode: standalone)')
    const onDisplayChange = () => setIsInstalled(checkStandaloneMode())
    mq.addEventListener?.('change', onDisplayChange)

    const onBeforeInstall = (e) => {
      e.preventDefault()
      setDeferredPrompt(e)
    }

    const onAppInstalled = () => {
      setDeferredPrompt(null)
      setIsInstalled(true)
    }

    window.addEventListener('beforeinstallprompt', onBeforeInstall)
    window.addEventListener('appinstalled', onAppInstalled)

    return () => {
      mq.removeEventListener?.('change', onDisplayChange)
      window.removeEventListener('beforeinstallprompt', onBeforeInstall)
      window.removeEventListener('appinstalled', onAppInstalled)
    }
  }, [])

  const promptInstall = useCallback(async () => {
    if (!deferredPrompt) return 'guide'
    try {
      deferredPrompt.prompt()
      const { outcome } = await deferredPrompt.userChoice
      if (outcome === 'accepted') {
        setDeferredPrompt(null)
        setIsInstalled(true)
      }
      return outcome
    } catch {
      return 'guide'
    }
  }, [deferredPrompt])

  return {
    canInstall: Boolean(deferredPrompt) && !isInstalled,
    isInstalled,
    platform,
    dismissed,
    dismiss: () => setDismissed(true),
    promptInstall,
  }
}
