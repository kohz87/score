import { describe, expect, test, vi } from 'vitest'
import { connectSse, SseHttpError } from '../../../src/hermes/live/index.ts'
import {
  collect,
  comment,
  encoder,
  event,
  fromText,
  installSseHooks,
  response,
  url,
} from './sse-client-helpers.ts'

installSseHooks()

describe('SSE connection', () => {
  test('sends auth, Accept, and Last-Event-ID without mutating supplied headers', async () => {
    const headers = new Headers({ Authorization: 'Bearer example-key' })
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(': stream closed\n'))
    const connection = connectSse({ url, headers, lastEventId: '0', fetch })
    expect(fetch).not.toHaveBeenCalled()
    expect(await collect(connection)).toEqual([comment('stream closed')])
    const sent = new Headers(fetch.mock.calls[0]?.[1]?.headers)
    expect(sent.get('authorization')).toBe('Bearer example-key')
    expect(sent.get('accept')).toBe('text/event-stream')
    expect(sent.get('last-event-id')).toBe('0')
    expect(headers.has('last-event-id')).toBe(false)
    expect(await connection.closed).toEqual({ reason: 'server_closed', streamClosed: true })
  })

  test('an explicitly empty resume ID clears a supplied Last-Event-ID', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(''))
    await collect(connectSse({ url, headers: { 'Last-Event-ID': 'old' }, lastEventId: '', fetch }))
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has('last-event-id')).toBe(false)
  })

  test.each([
    { status: 401, type: 'text/event-stream' },
    { status: 200, type: 'application/json' },
    { status: 200, type: 'text/event-streamish' },
    { status: 200, type: '' },
  ])(
    'rejects status/content type $status $type with a typed, bounded, redacted error',
    async ({ status, type }) => {
      const secret = 'example-private-key'
      const connection = connectSse({
        url,
        headers: { Authorization: `Bearer ${secret}`, 'X-Private': 'private-value' },
        fetch: async () =>
          new Response(`Bearer ${secret} private-value ${'x'.repeat(700)}`, {
            status,
            headers: { 'content-type': type },
          }),
      })
      let caught: unknown
      try {
        await collect(connection)
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(SseHttpError)
      const error = caught as SseHttpError
      expect(error.status).toBe(status)
      expect(error.bodySnippet).toHaveLength(500)
      expect(JSON.stringify(error)).not.toContain(secret)
      expect(JSON.stringify(error)).not.toContain('private-value')
      expect(error.message).not.toContain(secret)
      expect(await connection.closed).toEqual({ reason: 'error', error })
    },
  )

  test('redacts a bearer key crossing the snippet boundary', async () => {
    const key = 'example-secret-key'
    const connection = connectSse({
      url,
      headers: { authorization: `Bearer ${key}` },
      fetch: async () => new Response('x'.repeat(495) + key, { status: 403 }),
    })
    await expect(collect(connection)).rejects.toMatchObject({
      bodySnippet: 'x'.repeat(495) + '[reda',
    })
  })

  test('cancels a rejected response after reading a bounded prefix', async () => {
    const cancel = vi.fn()
    const connection = connectSse({
      url,
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode('x'.repeat(700)))
            },
            cancel,
          }),
          { status: 500 },
        ),
    })
    await expect(collect(connection)).rejects.toBeInstanceOf(SseHttpError)
    expect(cancel).toHaveBeenCalledOnce()
  })

  test('keeps the typed HTTP status when the rejected body also fails', async () => {
    const connection = connectSse({
      url,
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('Bearer private-key'))
            },
          }),
          { status: 403 },
        ),
    })
    await expect(collect(connection)).rejects.toMatchObject({
      name: 'SseHttpError',
      status: 403,
      bodySnippet: '',
    })
    expect(await connection.closed).toMatchObject({ reason: 'error' })
  })

  test('invalid header errors settle closed without exposing header values', async () => {
    const connection = connectSse({
      url,
      headers: { Authorization: 'Bearer private-key\ninvalid' },
    })
    await expect(collect(connection)).rejects.toThrow('SSE connection failed')
    expect(JSON.stringify(await connection.closed)).not.toContain('private-key')
  })

  test('parses the client response incrementally across every UTF-8 byte', async () => {
    const bytes = [
      ...encoder.encode('\uFEFF: open\r\nid: 0\r\ndata: café 🐈\r\n\r\n: stream closed\r\n'),
    ]
    const connection = connectSse({
      url,
      fetch: async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              const byte = bytes.shift()
              if (byte === undefined) controller.close()
              else controller.enqueue(Uint8Array.of(byte))
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    })
    expect(await collect(connection)).toEqual([
      comment('open'),
      event('café 🐈', '0'),
      comment('stream closed'),
    ])
    expect(await connection.closed).toEqual({ reason: 'server_closed', streamClosed: true })
  })

  test('plain EOF closes while retaining the distinction needed for reconnection', async () => {
    const connection = fromText('data: first\n\ndata: incomplete')
    expect(await collect(connection)).toEqual([event('first')])
    expect(await connection.closed).toEqual({ reason: 'server_closed', streamClosed: false })
  })

  test('the close comment stops an open body and cancels its reader', async () => {
    const cancel = vi.fn()
    const connection = connectSse({
      url,
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(': stream closed\n'))
            },
            cancel,
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    })
    expect(await collect(connection)).toEqual([comment('stream closed')])
    expect(await connection.closed).toEqual({ reason: 'server_closed', streamClosed: true })
    expect(cancel).toHaveBeenCalledOnce()
  })

  test('sanitizes network errors, including errors from a body reader', async () => {
    for (const fetch of [
      async () => {
        throw new Error('Bearer secret')
      },
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('Bearer secret'))
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    ]) {
      const connection = connectSse({ url, fetch })
      await expect(collect(connection)).rejects.toThrow('SSE connection failed')
      expect(JSON.stringify(await connection.closed)).not.toContain('secret')
    }
  })

  test('pre-abort avoids fetching', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetch = vi.fn<typeof globalThis.fetch>()
    const connection = connectSse({ url, signal: controller.signal, fetch })
    expect(await collect(connection)).toEqual([])
    expect(await connection.closed).toEqual({ reason: 'aborted' })
    expect(fetch).not.toHaveBeenCalled()
  })

  test('abort interrupts a pending fetch even when a fake fetch ignores the signal', async () => {
    const controller = new AbortController()
    const connection = connectSse({
      url,
      signal: controller.signal,
      fetch: () => new Promise<Response>(() => {}),
    })
    const frames = collect(connection)
    controller.abort('Bearer private-abort-reason')
    expect(await frames).toEqual([])
    expect(await connection.closed).toEqual({ reason: 'aborted' })
  })

  test('abort cancels a pending body read', async () => {
    const controller = new AbortController()
    const cancel = vi.fn()
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(new ReadableStream({ cancel }), {
          headers: { 'content-type': 'text/event-stream' },
        }),
    )
    const connection = connectSse({ url, signal: controller.signal, fetch })
    const frames = collect(connection)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    controller.abort()
    expect(await frames).toEqual([])
    expect(await connection.closed).toEqual({ reason: 'aborted' })
    expect(cancel).toHaveBeenCalledOnce()
  })

  test('breaking iteration releases the reader and settles closed', async () => {
    const connection = fromText('data: first\n\n', { open: true })
    for await (const frame of connection) {
      expect(frame).toEqual(event('first'))
      break
    }
    expect(await connection.closed).toEqual({ reason: 'aborted' })
  })
})
