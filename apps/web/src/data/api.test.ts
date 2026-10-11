import { afterEach, expect, test, vi } from 'vitest'
import { ApiError, apiFetch } from './api.ts'

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
      message: 'The request failed. Please try again.',
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
