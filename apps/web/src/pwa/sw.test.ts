import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { beforeEach, expect, test, vi } from 'vitest'

// The worker is a plain script in public/: run it against a fake worker scope with a mocked fetch and cache.
const source = readFileSync(
  join(import.meta.dirname, '..', '..', 'public', 'sw.js'),
  'utf8',
).replace('__BUILD_ID__', 'test')
const ORIGIN = 'https://score.example.ts.net:8741'

type Handler = (event: Record<string, unknown>) => void
type FakeResponse = {
  ok: boolean
  status: number
  type: string
  body: string
  headers: Headers
  clone(): FakeResponse
  text(): Promise<string>
}
const respond = (
  body: string,
  init: { status?: number; type?: string; html?: boolean } = {},
): FakeResponse => {
  const make = (): FakeResponse => ({
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    type: init.type ?? 'basic',
    body,
    headers: new Headers(init.html ? { 'content-type': 'text/html' } : {}),
    clone: make,
    text: async () => body,
  })
  return make()
}

let handlers: Record<string, Handler>
let stores: Map<string, Map<string, FakeResponse>>
let network: ReturnType<typeof vi.fn<(input: unknown) => Promise<FakeResponse>>>
let clients: {
  matchAll: ReturnType<typeof vi.fn>
  openWindow: ReturnType<typeof vi.fn>
  claim: ReturnType<typeof vi.fn>
}
let skipWaiting: ReturnType<typeof vi.fn>

const keyOf = (input: unknown) =>
  new URL(typeof input === 'string' ? input : (input as { url: string }).url, ORIGIN).pathname

beforeEach(() => {
  handlers = {}
  stores = new Map()
  network = vi.fn<(input: unknown) => Promise<FakeResponse>>(async (input) =>
    respond(`net:${keyOf(input)}`, { html: keyOf(input) === '/index.html' }),
  )
  clients = { matchAll: vi.fn(async () => []), openWindow: vi.fn(), claim: vi.fn() }
  skipWaiting = vi.fn()
  const open = async (name: string) => {
    const store = stores.get(name) ?? new Map<string, FakeResponse>()
    stores.set(name, store)
    return {
      addAll: async (items: unknown[]) => {
        for (const item of items) store.set(keyOf(item), await network(item))
      },
      add: async (input: unknown) => void store.set(keyOf(input), await network(input)),
      put: async (input: unknown, response: FakeResponse) => void store.set(keyOf(input), response),
    }
  }
  const self = {
    location: new URL(ORIGIN),
    clients,
    skipWaiting,
    addEventListener: (type: string, handler: Handler) => (handlers[type] = handler),
  }
  runInNewContext(source, {
    self,
    caches: {
      open,
      keys: async () => [...stores.keys()],
      delete: async (name: string) => stores.delete(name),
      match: async (input: unknown) => {
        for (const store of stores.values())
          if (store.has(keyOf(input))) return store.get(keyOf(input))
        return undefined
      },
    },
    fetch: network,
    Request: class {
      constructor(readonly url: string) {}
    },
    Response: { error: () => respond('error', { status: 0 }) },
    URL,
    Headers,
  })
})

function fetchEvent(
  path: string,
  init: { method?: string; mode?: string; headers?: Record<string, string>; origin?: string } = {},
) {
  const headers = new Headers(init.headers)
  const result: { response?: Promise<FakeResponse> } = {}
  const event = {
    request: {
      method: init.method ?? 'GET',
      url: (init.origin ?? ORIGIN) + path,
      mode: init.mode ?? 'cors',
      headers,
    },
    respondWith: (response: Promise<FakeResponse>) => (result.response = response),
  }
  handlers.fetch!(event)
  return result
}

test('install caches the shell and the hashed assets index.html names; activate drops older builds', async () => {
  network.mockImplementation(async (input: unknown) =>
    respond(
      keyOf(input) === '/index.html'
        ? '<script src="/assets/index-abc.js"></script><link href="/assets/font-1.woff2">'
        : 'x',
      { html: keyOf(input) === '/index.html' },
    ),
  )
  let installed: Promise<void> | undefined
  handlers.install!({ waitUntil: (promise: Promise<void>) => (installed = promise) })
  await installed
  const cache = stores.get('score-shell-test')!
  expect([...cache.keys()].sort()).toEqual(
    [
      '/assets/font-1.woff2',
      '/assets/index-abc.js',
      '/favicon.svg',
      '/icon-192.png',
      '/index.html',
      '/manifest.webmanifest',
      '/offline.html',
      '/offline.js',
    ].sort(),
  )
  stores.set('score-shell-old', new Map())
  stores.set('someone-elses', new Map())
  let activated: Promise<void> | undefined
  handlers.activate!({ waitUntil: (promise: Promise<void>) => (activated = promise) })
  await activated
  expect([...stores.keys()].sort()).toEqual(['score-shell-test', 'someone-elses'])
  expect(clients.claim).toHaveBeenCalled()
})

test.each([
  '/api/session',
  '/api/stream',
  '/api/media/abc',
  '/api/system',
  '/s/anything',
  '/bridge/v1/events',
  '/setup/https',
  '/setup/https/score-ca.crt',
  '/pair',
])('%s is never intercepted or cached', async (path) => {
  for (const mode of ['navigate', 'cors']) {
    const result = fetchEvent(path, { mode })
    expect(result.response).toBeUndefined()
  }
  expect(stores.size).toBe(0)
})

test('mutations, other origins, range requests and event streams are left alone', () => {
  expect(fetchEvent('/assets/a.js', { method: 'POST' }).response).toBeUndefined()
  expect(
    fetchEvent('/assets/a.js', { origin: 'https://elsewhere.example' }).response,
  ).toBeUndefined()
  expect(fetchEvent('/assets/a.mp4', { headers: { range: 'bytes=0-1' } }).response).toBeUndefined()
  expect(fetchEvent('/now', { headers: { accept: 'text/event-stream' } }).response).toBeUndefined()
  expect(
    fetchEvent('/api/stream', { headers: { accept: 'text/event-stream' } }).response,
  ).toBeUndefined()
})

test('hashed assets are cache-first: one network fetch, then the cache', async () => {
  const first = await fetchEvent('/assets/index-abc.js').response
  expect(first!.body).toBe('net:/assets/index-abc.js')
  const second = await fetchEvent('/assets/index-abc.js').response
  expect(second!.body).toBe('net:/assets/index-abc.js')
  expect(network).toHaveBeenCalledTimes(1)
})

test('page loads are network-first, and keep the newest index.html', async () => {
  const page = await fetchEvent('/now', { mode: 'navigate' }).response
  expect(page!.body).toBe('net:/now')
  // The page itself isn't what gets stored under index.html unless it is html: a JSON error must not be cached.
  network.mockResolvedValueOnce(respond('<html>new</html>', { html: true }))
  await fetchEvent('/chat', { mode: 'navigate' }).response
  expect(stores.get('score-shell-test')!.get('/index.html')!.body).toBe('<html>new</html>')
  network.mockResolvedValueOnce(respond('{"error":1}', { status: 401 }))
  await fetchEvent('/chat', { mode: 'navigate' }).response
  expect(stores.get('score-shell-test')!.get('/index.html')!.body).toBe('<html>new</html>')
})

test('when Score cannot be reached a page load shows the offline page, also for a dead proxy', async () => {
  stores.set('score-shell-test', new Map([['/offline.html', respond('offline page')]]))
  network.mockRejectedValue(new Error('offline'))
  expect((await fetchEvent('/now', { mode: 'navigate' }).response)!.body).toBe('offline page')
  network.mockReset()
  network.mockResolvedValue(respond('Bad gateway', { status: 502 }))
  expect((await fetchEvent('/now', { mode: 'navigate' }).response)!.body).toBe('offline page')
})

test('SKIP_WAITING activates a waiting worker', () => {
  handlers.message!({ data: { type: 'SKIP_WAITING' } })
  expect(skipWaiting).toHaveBeenCalled()
  skipWaiting.mockClear()
  handlers.message!({ data: { type: 'other' } })
  expect(skipWaiting).not.toHaveBeenCalled()
})

test('clicking a notification focuses an open Score window and sends it to the page, else opens one', async () => {
  const focus = vi.fn()
  const postMessage = vi.fn()
  clients.matchAll.mockResolvedValue([{ url: `${ORIGIN}/chat`, focus, postMessage }])
  const close = vi.fn()
  let done: Promise<void> | undefined
  handlers.notificationclick!({
    notification: { close, data: { url: '/chat/general' } },
    waitUntil: (promise: Promise<void>) => (done = promise),
  })
  await done
  expect(close).toHaveBeenCalled()
  expect(focus).toHaveBeenCalled()
  expect(postMessage).toHaveBeenCalledWith({ type: 'score:navigate', url: '/chat/general' })

  clients.matchAll.mockResolvedValue([])
  handlers.notificationclick!({
    notification: { close, data: { url: '//evil.example/x' } },
    waitUntil: (promise: Promise<void>) => (done = promise),
  })
  await done
  // A foreign URL in the data is ignored: it falls back to the default shell.
  expect(clients.openWindow).toHaveBeenCalledWith('/b')
})
