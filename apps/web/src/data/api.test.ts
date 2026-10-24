import { afterEach, expect, test, vi } from 'vitest'
import { ApiError, apiFetch, apiUpload } from './api.ts'

afterEach(() => vi.unstubAllGlobals())

test.each(['POST', 'PUT', 'PATCH', 'DELETE', 'post'])(
  '%s sends the mutation header and JSON content type',
  async (method) => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetch)
    expect(
      await apiFetch('/session/pair', {
        method,
        body: '{"token":"example-token"}',
        headers: { 'Idempotency-Key': 'example-key' },
      }),
    ).toBeUndefined()
    const [path, init] = fetch.mock.calls[0]!
    expect(path).toBe('/api/session/pair')
    expect(init.credentials).toBe('same-origin')
    expect(init.method).toBe(method.toUpperCase())
    expect(init.headers.get('X-Score-Client')).toBe('web')
    expect(init.headers.get('content-type')).toBe('application/json')
    expect(init.headers.get('Idempotency-Key')).toBe('example-key')
  },
)

test('GET prefixes /api, parses JSON and does not add mutation headers', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('{"paired":false}'))
  vi.stubGlobal('fetch', fetch)
  expect(await apiFetch('session')).toEqual({ paired: false })
  const [path, init] = fetch.mock.calls[0]!
  expect(path).toBe('/api/session')
  expect(init.credentials).toBe('same-origin')
  expect(init.headers.has('X-Score-Client')).toBe(false)
  expect(init.headers.has('content-type')).toBe(false)
})

test('a bodyless mutation does not add content type', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetch)
  await apiFetch('/session', { method: 'DELETE' })
  const init = fetch.mock.calls[0]![1]
  expect(init.headers.has('content-type')).toBe(false)
  expect(init.headers.get('X-Score-Client')).toBe('web')
})

test('explicit content types are preserved', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetch)
  await apiFetch('/media', {
    method: 'POST',
    body: 'file',
    headers: { 'content-type': 'text/plain' },
  })
  expect(fetch.mock.calls[0]![1].headers.get('content-type')).toBe('text/plain')
})

test('maps the contract error envelope into ApiError', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'not_paired',
            message: 'Pair this browser first',
            details: { reason: 'expired' },
          },
        }),
        { status: 401 },
      ),
    ),
  )
  const error = await apiFetch('/session/pair', { method: 'POST' }).catch((error: unknown) => error)
  expect(error).toBeInstanceOf(ApiError)
  expect(error).toMatchObject({
    name: 'ApiError',
    status: 401,
    code: 'not_paired',
    message: 'Pair this browser first',
  })
})

test.each(['not JSON', '{}', '{"error":null}', '{"error":{"code":42,"message":[]}}'])(
  'malformed errors have a usable fallback (%s)',
  async (payload) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(payload, { status: 502 })))
    await expect(apiFetch('/session')).rejects.toMatchObject({
      status: 502,
      code: 'request_failed',
      message: 'Couldn’t complete that. Try again.',
    })
  },
)

test('passes an AbortSignal through to fetch', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('{}'))
  vi.stubGlobal('fetch', fetch)
  const controller = new AbortController()
  await apiFetch('rooms', { signal: controller.signal })
  expect(fetch.mock.calls[0]![1].signal).toBe(controller.signal)
})

// apiUpload: a PUT with progress. A file goes as octet-stream; a form is left to the browser.
class FakeXhr {
  static last: FakeXhr
  headers: Record<string, string> = {}
  method = ''
  url = ''
  sent: unknown
  status = 200
  responseText = '{"ok":true}'
  responseType = ''
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor() {
    FakeXhr.last = this
  }
  open(method: string, url: string) {
    this.method = method
    this.url = url
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value
  }
  send(body: unknown) {
    this.sent = body
  }
}

test('a Blob upload is a PUT as octet-stream with the mutation header', async () => {
  vi.stubGlobal('XMLHttpRequest', FakeXhr)
  const done = apiUpload('knowledge/files/a.bin', new Blob(['abc']))
  const xhr = FakeXhr.last
  expect([xhr.method, xhr.url]).toEqual(['PUT', '/api/knowledge/files/a.bin'])
  expect(xhr.headers['x-score-client']).toBe('web')
  expect(xhr.headers['content-type']).toBe('application/octet-stream')
  xhr.onload?.()
  expect(await done).toEqual({ ok: true })
})

test('a FormData upload leaves the content type to the browser, keeps the mutation header and adds the given ones', async () => {
  vi.stubGlobal('XMLHttpRequest', FakeXhr)
  const form = new FormData()
  form.append('file', new File([new Uint8Array(3000)], 'idle.png'), 'idle.png')
  form.append('file', new File([new Uint8Array(1000)], 'work.png'), 'work.png')
  const seen: { loaded: number; total: number }[] = []
  const done = apiUpload('agents/lead/pack', form, (progress) => seen.push(progress), {
    'Idempotency-Key': 'key-1',
  })
  const xhr = FakeXhr.last
  expect(xhr.headers['content-type']).toBeUndefined()
  expect(xhr.headers['x-score-client']).toBe('web')
  expect(xhr.headers['idempotency-key']).toBe('key-1')
  expect(xhr.sent).toBe(form)
  // Without a computable total from the browser, the files' sizes stand in for it.
  xhr.upload.onprogress?.({ loaded: 1500, lengthComputable: false, total: 0 } as ProgressEvent)
  xhr.upload.onprogress?.({ loaded: 2000, lengthComputable: true, total: 4200 } as ProgressEvent)
  expect(seen).toEqual([
    { loaded: 1500, total: 4000 },
    { loaded: 2000, total: 4200 },
  ])
  xhr.status = 422
  xhr.responseText = JSON.stringify({
    error: { code: 'pack_rejected', message: 'No.', details: { reasons: ['idle is missing.'] } },
  })
  xhr.onload?.()
  await expect(done).rejects.toMatchObject({ status: 422, code: 'pack_rejected' })
})

test('apiUpload can POST: the method is an option and PUT stays the default', async () => {
  const opened: string[] = []
  class Spy {
    upload = {}
    status = 200
    responseText = '{}'
    responseType = ''
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    open(method: string) {
      opened.push(method)
    }
    setRequestHeader() {}
    send() {
      this.onload?.()
    }
  }
  vi.stubGlobal('XMLHttpRequest', Spy)
  await apiUpload('a', new Blob(['x']))
  await apiUpload('a', new Blob(['x']), undefined, {}, 'POST')
  expect(opened).toEqual(['PUT', 'POST'])
  vi.unstubAllGlobals()
})

test('apiUpload reports that sending is done, also for an empty body', async () => {
  class Empty {
    upload: { onprogress: unknown; onload: (() => void) | null } = {
      onprogress: null,
      onload: null,
    }
    status = 200
    responseText = '{}'
    responseType = ''
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    open() {}
    setRequestHeader() {}
    send() {
      this.upload.onload?.()
      this.onload?.()
    }
  }
  vi.stubGlobal('XMLHttpRequest', Empty)
  const seen: unknown[] = []
  await apiUpload('a', new Blob([]), (progress) => seen.push(progress))
  expect(seen).toEqual([{ loaded: 0, total: 0, done: true }])
  vi.unstubAllGlobals()
})
