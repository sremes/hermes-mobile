/* Hermes Mobile — app-shell service worker.
 *
 * Strategy (kept deliberately simple):
 *  - Hashed build assets (/assets/*.js/css) are immutable: cache-first, and
 *    new deploys get fresh names so the cache can never serve stale code.
 *  - Navigation requests (the SPA shell) are network-first with the cached
 *    shell as the offline fallback, so a dead network still shows the app.
 *  - Everything else same-origin (icons, manifest) is stale-while-revalidate.
 *  - /api, /auth, /login and WebSocket upgrades are NEVER intercepted — the
 *    gateway is the source of truth and must not be cached.
 *
 * Version bump on every deploy that changes shell behavior.
 */
const VERSION = 'v1'
const SHELL_CACHE = `hermes-mobile-shell-${VERSION}`
const ASSET_CACHE = `hermes-mobile-assets-${VERSION}`

const NAVIGATION = new Set(['/', '/index.html'])
const NEVER_CACHE = ['/api/', '/auth/', '/login', '/ws']

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(cache => cache.addAll(['/', '/index.html', '/manifest.webmanifest']))
  )
  self.skipWaiting()
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL_CACHE && k !== ASSET_CACHE).map(k => caches.delete(k))))
  )
  self.clients.claim()
})

self.addEventListener('fetch', event => {
  const request = event.request

  if (request.method !== 'GET') {
    return
  }

  const url = new URL(request.url)

  if (url.origin !== self.location.origin) {
    return
  }

  if (NEVER_CACHE.some(prefix => url.pathname.startsWith(prefix))) {
    return
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.open(ASSET_CACHE).then(cache =>
        cache.match(request).then(cached => {
          if (cached) {
            return cached
          }

          return fetch(request).then(response => {
            if (response.ok) {
              cache.put(request, response.clone())
            }

            return response
          })
        })
      )
    )
    return
  }

  if (NAVIGATION.has(url.pathname)) {
    event.respondWith(
      fetch(request)
        .then(response => {
          const copy = response.clone()

          caches.open(SHELL_CACHE).then(cache => cache.put(request, copy))

          return response
        })
        .catch(() => caches.open(SHELL_CACHE).then(cache => cache.match(request).then(hit => hit || cache.match('/index.html'))))
    )
    return
  }

  // Icons, manifest, and other static files: stale-while-revalidate.
  event.respondWith(
    caches.open(SHELL_CACHE).then(cache =>
      cache.match(request).then(cached => {
        const network = fetch(request)
          .then(response => {
            if (response.ok) {
              cache.put(request, response.clone())
            }

            return response
          })
          .catch(() => cached)

        return cached || network
      })
    )
  )
})
