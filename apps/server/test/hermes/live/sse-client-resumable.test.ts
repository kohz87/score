import { createServer, type ServerResponse } from 'node:http'
import { describe, expect, test, vi } from 'vitest'
import {
  connectSse,
  resumableSse,
  type SseConnection,
  type SseFrame,
} from '../../../src/hermes/live/index.ts'
import { fromText, installSseHooks, wireEvent } from './sse-client-helpers.ts'

installSseHooks()

describe('resumable SSE', () => {
  test.each(['disconnect', 'eof'])(
    'resumes after %s with the last ID and suppresses replayed duplicates',
    async (end) => {
      const connect = vi.fn((lastEventId?: string) =>
        fromText(
          lastEventId === undefined
            ? wireEvent('0') + wireEvent('1')
            : wireEvent('0') + wireEvent('1') + wireEvent('2') + ': stream closed\n',
          { disconnect: lastEventId === undefined && end === 'disconnect' },
        ),
      )
      const onEvent = vi.fn()
      const sleep = vi.fn<(ms: number, signal?: AbortSignal) => Promise<void>>(async () => {})
      expect(
        await resumableSse({
          connect,
          onEvent,
          onTruncated: vi.fn(),
          backoff: { sleep, random: () => 0.5 },
        }),
      ).toEqual({ ended: 'server_closed', lastEventId: '2' })
      expect(connect.mock.calls).toEqual([[undefined], ['1']])
      expect(onEvent.mock.calls.map(([frame]) => frame.id)).toEqual(['0', '1', '2'])
      expect(sleep).toHaveBeenCalledWith(500, undefined)
    },
  )

  test('permanent HTTP errors fail fast; 429 is retried', async () => {
    const respond = (status: number) =>
      vi.fn(() =>
        connectSse({
          url: 'http://hermes.test/v1/runs/run_x/events',
          headers: { Authorization: 'Bearer secret-key' },
          fetch: async () => new Response('nope', { status }),
        }),
      )
    const sleep = vi.fn<(ms: number, signal?: AbortSignal) => Promise<void>>(async () => {})
    for (const status of [401, 403, 404]) {
      const connect = respond(status)
      await expect(
        resumableSse({ connect, onEvent: vi.fn(), onTruncated: vi.fn(), backoff: { sleep } }),
      ).rejects.toMatchObject({ name: 'SseHttpError', status })
      expect(connect).toHaveBeenCalledOnce()
    }
    const throttled = respond(429)
    expect(
      await resumableSse({
        connect: throttled,
        onEvent: vi.fn(),
        onTruncated: vi.fn(),
        backoff: { sleep, maxAttempts: 3 },
      }),
    ).toMatchObject({ ended: 'gave_up' })
    expect(throttled).toHaveBeenCalledTimes(3)
  })

  test('does not reconnect after a close comment', async () => {
    const connect = vi.fn(() => fromText(wireEvent('0') + ': stream closed\n', { open: true }))
    expect(await resumableSse({ connect, onEvent: vi.fn(), onTruncated: vi.fn() })).toEqual({
      ended: 'server_closed',
      lastEventId: '0',
    })
    expect(connect).toHaveBeenCalledOnce()
  })

  test('surfaces truncation with the connection resume ID even when the control frame inherits an ID', async () => {
    const onEvent = vi.fn()
    const onTruncated = vi.fn()
    const connect = vi.fn(() =>
      fromText(
        wireEvent('5') +
          'data: {"event":"replay.truncated","oldest_retained_seq":5}\n\n' +
          wireEvent('6') +
          ': stream closed\n',
      ),
    )
    expect(await resumableSse({ connect, lastEventId: '2', onEvent, onTruncated })).toEqual({
      ended: 'server_closed',
      lastEventId: '6',
    })
    expect(onTruncated).toHaveBeenCalledExactlyOnceWith({ oldestRetainedSeq: 5, requestedSeq: '2' })
    expect(onEvent.mock.calls.map(([frame]) => frame.id)).toEqual(['5', '6'])
  })

  test.each([-1, 1.5, '5', null])(
    'rejects malformed truncation sequence %j before calling consumers',
    async (seq) => {
      const connect = vi.fn(() =>
        fromText(
          `data: ${JSON.stringify({ event: 'replay.truncated', oldest_retained_seq: seq })}\n\n`,
        ),
      )
      const onTruncated = vi.fn()
      await expect(resumableSse({ connect, onEvent: vi.fn(), onTruncated })).rejects.toThrow(
        'Invalid SSE replay truncation signal',
      )
      expect(onTruncated).not.toHaveBeenCalled()
      expect(connect).toHaveBeenCalledOnce()
    },
  )

  test('gives up after eight consecutive failures with exponential delays capped at ten seconds', async () => {
    vi.useFakeTimers()
    const connect = vi.fn(() => {
      throw new Error('offline')
    })
    const onEvent = vi.fn()
    const promise = resumableSse({
      connect,
      lastEventId: '12',
      onEvent,
      onTruncated: vi.fn(),
      backoff: { random: () => 0.5 },
    })
    for (const [index, ms] of [500, 1000, 2000, 4000, 8000, 10000, 10000].entries()) {
      expect(connect).toHaveBeenCalledTimes(index + 1)
      await vi.advanceTimersByTimeAsync(ms - 1)
      expect(connect).toHaveBeenCalledTimes(index + 1)
      await vi.advanceTimersByTimeAsync(1)
    }
    expect(await promise).toEqual({ ended: 'gave_up', lastEventId: '12' })
    expect(connect).toHaveBeenCalledTimes(8)
    expect(onEvent).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('resets backoff and failure count after a successful frame', async () => {
    let calls = 0
    const connect = vi.fn(() => {
      calls++
      if (calls === 3) return fromText(wireEvent('1'), { disconnect: true })
      if (calls === 5) return fromText(': stream closed\n')
      throw new Error('offline')
    })
    const sleep = vi.fn<(ms: number, signal?: AbortSignal) => Promise<void>>(async () => {})
    expect(
      await resumableSse({
        connect,
        onEvent: vi.fn(),
        onTruncated: vi.fn(),
        backoff: { maxAttempts: 3, sleep, random: () => 0.5 },
      }),
    ).toEqual({ ended: 'server_closed', lastEventId: '1' })
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([500, 1000, 500, 1000])
  })

  test.each([0, 1])('applies injectable jitter %s within the delay cap', async (random) => {
    const sleep = vi.fn<(ms: number, signal?: AbortSignal) => Promise<void>>(async () => {})
    await resumableSse({
      connect: () => {
        throw new Error('offline')
      },
      onEvent: vi.fn(),
      onTruncated: vi.fn(),
      backoff: { sleep, random: () => random, maxAttempts: 3, initialMs: 8000 },
    })
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual(random === 0 ? [6400, 8000] : [9600, 10000])
  })

  test('honors upstream retry state when reconnecting', async () => {
    const sleep = vi.fn<(ms: number, signal?: AbortSignal) => Promise<void>>(async () => {})
    let calls = 0
    const connect = () => fromText(++calls === 1 ? 'retry: 1250\n\n' : ': stream closed\n')
    await resumableSse({
      connect,
      onEvent: vi.fn(),
      onTruncated: vi.fn(),
      backoff: { sleep, random: () => 0.5 },
    })
    expect(sleep).toHaveBeenCalledExactlyOnceWith(1250, undefined)
  })

  test('honors retry-only lines received just before a network failure', async () => {
    const sleep = vi.fn<(ms: number, signal?: AbortSignal) => Promise<void>>(async () => {})
    let calls = 0
    await resumableSse({
      connect: () =>
        ++calls === 1
          ? fromText('retry: 1250\n', { disconnect: true })
          : fromText(': stream closed\n'),
      onEvent: vi.fn(),
      onTruncated: vi.fn(),
      backoff: { sleep, random: () => 0.5 },
    })
    expect(sleep).toHaveBeenCalledExactlyOnceWith(1250, undefined)
  })

  test('compares numeric resume IDs exactly above the safe integer range', async () => {
    const onEvent = vi.fn()
    const lastEventId = '9007199254740992'
    expect(
      await resumableSse({
        connect: () =>
          fromText(wireEvent(lastEventId) + wireEvent('9007199254740993') + ': stream closed\n'),
        lastEventId,
        onEvent,
        onTruncated: vi.fn(),
      }),
    ).toEqual({ ended: 'server_closed', lastEventId: '9007199254740993' })
    expect(onEvent.mock.calls.map(([frame]) => frame.id)).toEqual(['9007199254740993'])
  })

  test('pre-abort avoids invoking the connection factory', async () => {
    const controller = new AbortController()
    controller.abort()
    const connect = vi.fn(() => fromText(''))
    expect(
      await resumableSse({
        connect,
        onEvent: vi.fn(),
        onTruncated: vi.fn(),
        signal: controller.signal,
      }),
    ).toEqual({ ended: 'aborted', lastEventId: undefined })
    expect(connect).not.toHaveBeenCalled()
  })

  test('aborting during backoff clears the timer and stops reconnecting', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const connect = vi.fn(() => {
      throw new Error('offline')
    })
    const promise = resumableSse({
      connect,
      onEvent: vi.fn(),
      onTruncated: vi.fn(),
      signal: controller.signal,
    })
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    expect(await promise).toEqual({ ended: 'aborted', lastEventId: undefined })
    expect(connect).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('wrapper abort interrupts and cancels an active connection without its own signal', async () => {
    const controller = new AbortController()
    const onEvent = vi.fn(() => controller.abort())
    const connect = vi.fn(() => fromText(wireEvent('0'), { open: true }))
    expect(
      await resumableSse({ connect, onEvent, onTruncated: vi.fn(), signal: controller.signal }),
    ).toEqual({ ended: 'aborted', lastEventId: '0' })
    expect(connect).toHaveBeenCalledOnce()
  })

  test('wrapper abort interrupts a pending read and a pending connection factory', async () => {
    for (const connect of [
      () => fromText('', { open: true }),
      () => new Promise<SseConnection>(() => {}),
    ]) {
      const controller = new AbortController()
      const promise = resumableSse({
        connect,
        onEvent: vi.fn(),
        onTruncated: vi.fn(),
        signal: controller.signal,
      })
      await Promise.resolve()
      await Promise.resolve()
      controller.abort()
      expect(await promise).toEqual({ ended: 'aborted', lastEventId: undefined })
    }
  })

  test('an aborted connection does not reconnect', async () => {
    const connect = vi.fn(() => {
      const connection = fromText('')
      connection.abort()
      return connection
    })
    expect(await resumableSse({ connect, onEvent: vi.fn(), onTruncated: vi.fn() })).toEqual({
      ended: 'aborted',
      lastEventId: undefined,
    })
    expect(connect).toHaveBeenCalledOnce()
  })

  test('consumer errors propagate without reconnecting or acknowledging their event', async () => {
    const connect = vi.fn(() => fromText(wireEvent('1'), { open: true }))
    const failure = new Error('consumer failed')
    await expect(
      resumableSse({
        connect,
        onEvent: () => {
          throw failure
        },
        onTruncated: vi.fn(),
      }),
    ).rejects.toBe(failure)
    expect(connect).toHaveBeenCalledOnce()
  })

  test('a rejected truncation callback propagates without reconnecting', async () => {
    const connect = vi.fn(() =>
      fromText('data: {"event":"replay.truncated","oldest_retained_seq":5}\n\n', { open: true }),
    )
    const failure = new Error('gap recorder failed')
    const onTruncated = vi.fn(async () => {
      throw failure
    })
    await expect(resumableSse({ connect, onEvent: vi.fn(), onTruncated })).rejects.toBe(failure)
    expect(onTruncated).toHaveBeenCalledExactlyOnceWith({
      oldestRetainedSeq: 5,
      requestedSeq: undefined,
    })
    expect(connect).toHaveBeenCalledOnce()
  })

  test('resumes against a local HTTP server after a mid-stream socket disconnect', async (context) => {
    const cursors: (string | undefined)[] = []
    let first: ServerResponse | undefined
    const server = createServer((request, reply) => {
      const cursor = request.headers['last-event-id'] as string | undefined
      cursors.push(cursor)
      reply.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (cursor === undefined) {
        first = reply
        reply.write(wireEvent('1'))
      } else reply.end(wireEvent('1') + wireEvent('2') + ': stream closed\n')
    })
    try {
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(0, '127.0.0.1', resolve)
        })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM')
          context.skip('Sandbox forbids listening; fake-fetch resume tests cover this path')
        throw error
      }
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing test server address')
      const onEvent = vi.fn((frame: SseFrame) => {
        if (frame.type === 'event' && frame.id === '1') first?.destroy()
      })
      const result = await resumableSse({
        connect: (lastEventId) =>
          connectSse({
            url: `http://127.0.0.1:${address.port}/p/builder/v1/runs/example/events`,
            lastEventId,
          }),
        onEvent,
        onTruncated: vi.fn(),
        backoff: { sleep: async () => {} },
      })
      expect(result).toEqual({ ended: 'server_closed', lastEventId: '2' })
      expect(cursors).toEqual([undefined, '1'])
      expect(onEvent.mock.calls.map(([frame]) => frame.type === 'event' && frame.id)).toEqual([
        '1',
        '2',
      ])
    } finally {
      server.closeAllConnections()
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
