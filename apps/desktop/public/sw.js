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
 *  - Web Share Target: a POST navigation to /share (the OS delivering shared
 *    media/text) is captured, the payload is stashed in a dedicated cache,
 *    and the client is redirected to /?shared=1 where the app picks it up.
 *
 * Version bump on every deploy that changes shell behavior.
 */
const VERSION = 'v2'
const SHELL_CACHE = `hermes-mobile-shell-${VERSION}`
const ASSET_CACHE = `hermes-mobile-assets-${VERSION}`
const SHARE_CACHE = `hermes-mobile-share-${VERSION}`

const NAVIGATION = new Set(['/', '/index.html'])
const NEVER_CACHE = ['/api/', '/auth/', '/login', '/ws']

// A Web Share Target POST. The browser delivers multipart form data; stash the
// payload in the share cache and bounce to the app (a navigation POST body
// cannot be read by the page itself, so the SW is the only reader).
async function ingestShare(request) {
  try {
    const form = await request.formData()
    const cache = await caches.open(SHARE_CACHE)

    await cache.delete('/share/meta')

    const items = []
    let index = 0

    for (const [field, value] of form.entries()) {
      if (value instanceof File && value.size > 0) {
        const key = `/share/items/${index++}`
        await cache.put(
          key,
          new Response(value, { headers: { 'Content-Type': value.type || 'application/octet-stream' } })
        )
        items.push({ key, name: value.name || 'shared', type: value.type || 'application/octet-stream', size: value.size })
      } else if (typeof value === 'string' && value.trim()) {
        items.push({ field, value: value.trim() })
      }
    }

    if (items.length > 0) {
      await cache.put(
        '/share/meta',
        new Response(JSON.stringify({ items, ts: Date.now() }), { headers: { 'Content-Type': 'application/json' } })
      )
    }

    return Response.redirect('/?shared=1', 303)
  } catch (error) {
    return Response.redirect('/?shared=failed', 303)
  }
}

// Serve a stashed share item/meta from the share cache ONLY — never touch the
// network for /share/* (there is no such server path; a network revalidate
// would overwrite the stash with the SPA's index.html).
async function serveShare(key) {
  const cache = await caches.open(SHARE_CACHE)
  const hit = await cache.match(key)

  return hit || new Response(JSON.stringify({ items: [] }), { headers: { 'Content-Type': 'application/json' } })
}

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
      .then(keys =>
        Promise.all(
          keys.filter(k => k !== SHELL_CACHE && k !== ASSET_CACHE && k !== SHARE_CACHE).map(k => caches.delete(k))
        )
      )
  )
  self.clients.claim()
})

self.addEventListener('message', event => {
  if (event.data?.type === 'clear-share') {
    event.waitUntil(caches.open(SHARE_CACHE).then(cache => cache.keys().then(keys => Promise.all(keys.map(k => cache.delete(k))))))
  }
})

self.addEventListener('fetch', event => {
  const request = event.request
  const url = new URL(request.url)

  if (url.origin !== self.location.origin) {
    return
  }

  // Web Share Target intake — the OS POSTing shared media/text to /share.
  if (request.method === 'POST' && url.pathname === '/share') {
    event.respondWith(ingestShare(request))
    return
  }

  // Stashed share payload reads: cache-only, no network revalidation.
  if (url.pathname.startsWith('/share/')) {
    event.respondWith(serveShare(url.pathname))
    return
  }

  if (request.method !== 'GET') {
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
