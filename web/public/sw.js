const CACHE_NAME = 'kathal-shell-v1'
const APP_SHELL_URLS = [
  '/',
  '/manifest.webmanifest',
  '/icon.svg',
  '/pwa-192x192.png',
  '/pwa-512x512.png',
  '/apple-touch-icon.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL_URLS))
      .catch(() => {})
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  )
})

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // Never intercept API calls, WebSockets, or proxied /live/ app routes
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/live/')) {
    return
  }

  // Navigation requests: network-first with cached shell fallback
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put('/', copy)).catch(() => {})
          }
          return response
        })
        .catch(() => caches.match('/') || new Response('Offline', { status: 503 }))
    )
    return
  }

  // Static assets: stale-while-revalidate
  event.respondWith(
    caches.match(request).then((cached) => {
      const fetchPromise = fetch(request)
        .then((networkRes) => {
          if (networkRes && networkRes.ok && networkRes.type === 'basic') {
            const copy = networkRes.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {})
          }
          return networkRes
        })
        .catch(() => cached)

      return cached || fetchPromise
    })
  )
})
