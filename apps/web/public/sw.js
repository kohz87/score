/* Score service worker: caches the app shell only. */
// BUILD is replaced at build time (vite.config.ts) so every new build is a new worker and shows "Update available".
const BUILD = '__BUILD_ID__'
const CACHE = `score-shell-${BUILD}`
const SHELL = [
  '/offline.html',
  '/offline.js',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icon-192.png',
]

// Never cached and never touched: private data, live streams, media, pairing (the token lives in /pair's fragment and
// the page must reach the server untouched), the HTTPS guide and the bridge.
const NEVER = ['/api/', '/s/', '/bridge/', '/setup/', '/pair']
const isNever = (path) =>
  NEVER.some((prefix) => path === prefix.replace(/\/$/, '') || path.startsWith(prefix))
const isAsset = (path) => path.startsWith('/assets/') || SHELL.includes(path)

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      await cache.addAll(SHELL.map((path) => new Request(path, { cache: 'reload' })))
      // Warm the hashed assets the current index.html names, so the shell works from the cache afterwards.
      try {
        const page = await fetch('/index.html', { cache: 'reload' })
        if (page.ok) {
          const text = await page.clone().text()
          await cache.put('/index.html', page)
          const assets = [...new Set(text.match(/\/assets\/[A-Za-z0-9._-]+/g) ?? [])]
          await Promise.all(assets.map((path) => cache.add(path).catch(() => {})))
        }
      } catch {
        // Offline during install: assets are cached as they are first used.
      }
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key.startsWith('score-shell-') && key !== CACHE) await caches.delete(key)
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') void self.skipWaiting()
})

async function navigate(request) {
  try {
    const response = await fetch(request)
    // A proxy answering for a dead Score looks like a response; treat it as unreachable.
    if (response.status === 502 || response.status === 503 || response.status === 504)
      throw new Error('down')
    // Keep the newest app shell page for the next install's asset list; only a plain page, never one with data.
    if (response.ok && (response.headers.get('content-type') ?? '').includes('text/html')) {
      const cache = await caches.open(CACHE)
      await cache.put('/index.html', response.clone())
    }
    return response
  } catch {
    // Score can't be reached: say so (a cached app with no data behind it would only show errors).
    return (await caches.match('/offline.html')) ?? Response.error()
  }
}

async function cacheFirst(request) {
  const hit = await caches.match(request)
  if (hit) return hit
  const response = await fetch(request)
  if (response.ok && response.type === 'basic') {
    const cache = await caches.open(CACHE)
    await cache.put(request, response.clone())
  }
  return response
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin || isNever(url.pathname)) return
  if (
    request.headers.get('range') ||
    (request.headers.get('accept') ?? '').includes('text/event-stream')
  )
    return
  if (request.mode === 'navigate') {
    event.respondWith(navigate(request))
    return
  }
  if (isAsset(url.pathname)) event.respondWith(cacheFirst(request))
})

// A notification click opens (or focuses) Score at the page the notification is about.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = event.notification.data && event.notification.data.url
  const path =
    typeof target === 'string' && target.startsWith('/') && !target.startsWith('//') ? target : '/b'
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue
        await client.focus()
        client.postMessage({ type: 'score:navigate', url: path })
        return
      }
      await self.clients.openWindow(path)
    })(),
  )
})
