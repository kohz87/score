import { StreamHelloSchema, StreamResetSchema } from '@score/contract'
import type { FastifyInstance } from 'fastify'
import { mkdtempSync, rmSync } from 'node:fs'
import type { OutgoingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { getEpoch, migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { createIngest, type Observation } from '../../src/hub/ingest.ts'
import { pruneEvents } from '../../src/hub/retention.ts'
import { headSeq } from '../../src/hub/snapshot.ts'
import { getSystemStatus } from '../../src/system-status.ts'
import { readStream } from './sse-helpers.ts'

let dir: string
let db: ScoreDb
let ingest: ReturnType<typeof createIngest>
let app: FastifyInstance
let now: number
const controllers: AbortController[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-stream-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  now = Date.parse('2026-10-06T12:00:00.000Z')
  ingest = createIngest(db, { clock: () => now })
})

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort()
  await app?.close()
  await ingest.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function start(
  overrides: Partial<Parameters<typeof buildApp>[0]> = {},
  configure?: (app: FastifyInstance) => void,
) {
  app = buildApp({
    config: loadConfig({}),
    logger: false,
    db,
    ingest,
    getEpoch: () => getEpoch(db),
    ...overrides,
  })
  configure?.(app)
  await app.ready()
}

async function client(query = '', headers?: OutgoingHttpHeaders) {
  const controller = new AbortController()
  controllers.push(controller)
  return readStream(app, `/api/stream${query}`, controller.signal, headers)
}

function observation(identity: string, append?: string): Observation {
  return {
    source: 'score',
    identity,
    apply: () => [
      append === undefined
        ? { type: 'message.completed', data: { roomId: 'room', messageId: identity } }
        : { type: 'message.delta', data: { roomId: 'room', messageId: identity, append } },
    ],
  }
}

async function seed(count: number) {
  for (let i = 1; i <= count; i++) await ingest.submit(observation(String(i)))
}

const waitFor = (assertion: () => void) => vi.waitFor(assertion, { timeout: 5000, interval: 2 })

test('fresh connection starts at head, sends hello first without ID, then durable frames and heartbeat', async () => {
  await seed(3)
  await start({ streamOptions: { heartbeatMs: 10 } })
  const stream = await client()
  const hello = StreamHelloSchema.parse(stream.frames[0]?.data)
  expect(stream.frames[0]?.type).toBe('stream.hello')
  expect(stream.frames[0]?.raw).not.toContain('id:')
  expect(hello.data).toEqual({
    epoch: getEpoch(db),
    headSeq: 3,
    mode: 'fake',
    system: (await app.inject('/api/system')).json(),
  })
  await ingest.submit(observation('four', 'first\nsecond'))
  await waitFor(() => {
    expect(stream.seqs).toEqual([4])
    expect(stream.frames.some((frame) => frame.raw === ': hb')).toBe(true)
  })
  const durable = stream.frames.find((frame) => frame.id === 4)!
  expect(durable.type).toBe('message.delta')
  expect(durable.raw.split('\n')).toHaveLength(3)
  expect(durable.raw).toContain('first\\nsecond')
  expect(stream.failure).toBeUndefined()
})

test.each([
  ['missing', '', 'epoch'],
  ['different', '&epoch=foreign', 'epoch'],
  ['future', '&epoch=current', 'future_cursor'],
  ['pruned', '&epoch=current', 'pruned'],
] as const)(
  '%s cursor sends reset without ID, then lives from head',
  async (kind, epochQuery, reason) => {
    await seed(4)
    if (kind === 'pruned') {
      now += 8 * 24 * 60 * 60 * 1000
      await ingest.submit(observation('new'))
      expect(pruneEvents(db, { olderThan: new Date(now - 1000).toISOString(), batchSize: 2 })).toBe(
        4,
      )
    }
    await start()
    const cursor = kind === 'future' ? 100 : 0
    const stream = await client(`?since=${cursor}${epochQuery.replace('current', getEpoch(db))}`)
    await waitFor(() => expect(stream.frames).toHaveLength(2))
    expect(stream.frames.map((frame) => frame.type)).toEqual(['stream.hello', 'stream.reset'])
    expect(stream.frames.every((frame) => frame.id === undefined)).toBe(true)
    expect(StreamResetSchema.parse(stream.frames[1]?.data).data.reason).toBe(reason)
    const next = headSeq(db.sqlite) + 1
    await ingest.submit(observation('after-reset'))
    await waitFor(() => expect(stream.seqs).toEqual([next]))
  },
)

test('epoch reset wins over future and retention checks', async () => {
  await seed(3)
  await start()
  const stream = await client('?since=99&epoch=foreign')
  await waitFor(() => expect(stream.frames).toHaveLength(2))
  expect(StreamResetSchema.parse(stream.frames[1]?.data).data.reason).toBe('epoch')
})

test('Last-Event-ID wins over since, even when since is not a valid cursor', async () => {
  await seed(4)
  await start()
  const stream = await client(`?since=invalid&epoch=${getEpoch(db)}`, { 'Last-Event-ID': '2' })
  await waitFor(() => expect(stream.seqs).toEqual([3, 4]))
  expect(stream.frames[0]?.type).toBe('stream.hello')
})

test.each([
  '?since=-1',
  '?since=1.2',
  '?since=1e2',
  '?since=',
  '?since=9007199254740992',
  '?since=one',
  '?since=1&since=2',
  '?epoch=one&epoch=two',
])('invalid query %s returns JSON before hijack', async (query) => {
  await start()
  const response = await app.inject(`/api/stream${query}`)
  expect(response.statusCode).toBe(400)
  expect(response.headers['content-type']).toContain('application/json')
  expect(response.json().error.code).toBe('bad_request')
})

test.each(['-1', '', '2.5', '9007199254740992', '1, 2'])(
  'invalid Last-Event-ID %j cannot fall back to since',
  async (cursor) => {
    await start()
    const response = await app.inject({
      url: '/api/stream?since=0',
      headers: { 'last-event-id': cursor },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('bad_request')
  },
)

test('stream route is absent when ingest dependencies are omitted', async () => {
  app = buildApp({ config: loadConfig({}), logger: false })
  expect((await app.inject('/api/stream')).statusCode).toBe(404)
})

test('fence replays in pages while producers commit: several cursors have no omissions or duplicates', async () => {
  await seed(1100)
  const pageHeads: { live: number; fence: number }[] = []
  const prepare = db.sqlite.prepare.bind(db.sqlite)
  vi.spyOn(db.sqlite, 'prepare').mockImplementation((sql) => {
    const statement = prepare(sql)
    if (sql.includes('ORDER BY seq LIMIT 500')) {
      const all = statement.all.bind(statement)
      vi.spyOn(statement, 'all').mockImplementation((...args) => {
        pageHeads.push({ live: headSeq(db.sqlite), fence: Number(args[1]) })
        return all(...args)
      })
    }
    return statement
  })
  await start()
  const epoch = getEpoch(db)
  let producing = true
  const producer = (async () => {
    for (let i = 1101; i <= 1550 && producing; i++) {
      await ingest.submit(observation(String(i)))
      await setImmediate()
    }
  })()
  try {
    const cursors = [0, 17, 499, 900]
    const streams = await Promise.all(
      cursors.map((cursor) => client(`?since=${cursor}&epoch=${epoch}`)),
    )
    await producer
    await ingest.flushListeners()
    const stored = db.sqlite.prepare('SELECT seq FROM events ORDER BY seq').all()
    const last = headSeq(db.sqlite)
    for (const [index, stream] of streams.entries()) {
      await waitFor(() => expect(stream.seqs.at(-1)).toBe(last))
      const expected = stored.flatMap((row) =>
        Number(row.seq) > cursors[index]! ? [Number(row.seq)] : [],
      )
      expect(stream.seqs).toEqual(expected)
      expect(new Set(stream.seqs).size).toBe(stream.seqs.length)
      expect(stream.frames[0]?.id).toBeUndefined()
      expect(stream.failure).toBeUndefined()
    }
    expect(pageHeads.some((head) => head.live > head.fence)).toBe(true)
    expect(last).toBe(1550)
  } finally {
    producing = false
    await producer
  }
})

test('listener deliveries committed before the fence are dropped even if delivered after release', async () => {
  const gate = Promise.withResolvers<void>()
  const register = ingest.onCommitted.bind(ingest)
  vi.spyOn(ingest, 'onCommitted').mockImplementation((listener) =>
    register(async (events) => {
      await gate.promise
      await listener(events)
    }),
  )
  try {
    await start()
    await seed(3)
    const stream = await client(`?since=1&epoch=${getEpoch(db)}`)
    await waitFor(() => expect(stream.seqs).toEqual([2, 3]))
    await setImmediate()
    gate.resolve()
    await ingest.flushListeners()
    await ingest.submit(observation('four'))
    await waitFor(() => expect(stream.seqs).toEqual([2, 3, 4]))
  } finally {
    gate.resolve()
  }
})

test('retention preserves unread replay pages while pruning and keeps the head watermark', async () => {
  await seed(1100)
  const prune = vi.fn(() =>
    pruneEvents(db, { olderThan: '2026-10-07T00:00:00.000Z', batchSize: 200 }),
  )
  await start({
    getSystemStatus() {
      setImmediate().then(prune)
      return getSystemStatus(loadConfig({}))
    },
  })
  const stream = await client(`?since=0&epoch=${getEpoch(db)}`)
  await waitFor(() => expect(stream.seqs).toHaveLength(1100))
  expect(stream.seqs).toEqual(Array.from({ length: 1100 }, (_, i) => i + 1))
  expect(prune).toHaveBeenCalledOnce()
  expect(headSeq(db.sqlite)).toBe(1100)
  prune()
  expect(db.sqlite.prepare('SELECT seq FROM events').all()).toEqual([])
  expect(headSeq(db.sqlite)).toBe(1100)
})

test('fully pruned log resets old cursors but accepts the preserved head and the floor minus one', async () => {
  await seed(3)
  expect(pruneEvents(db, { olderThan: '2026-10-07T00:00:00.000Z', batchSize: 1 })).toBe(3)
  await start({ streamOptions: { heartbeatMs: 10 } })
  const old = await client(`?since=2&epoch=${getEpoch(db)}`)
  const head = await client(`?since=3&epoch=${getEpoch(db)}`)
  await waitFor(() => {
    expect(old.frames[1]?.type).toBe('stream.reset')
    expect(head.frames.some((frame) => frame.comment === 'hb')).toBe(true)
  })
  expect(StreamResetSchema.parse(old.frames[1]?.data).data.reason).toBe('pruned')
  expect(head.frames.some((frame) => frame.type === 'stream.reset')).toBe(false)
  await ingest.submit(observation('four'))
  await waitFor(() => expect(head.seqs).toEqual([4]))
})

test('SSE response uses the required headers and app.close ends open streams promptly', async () => {
  await start()
  const streams = await Promise.all([client(), client(), client()])
  const headers = streams[0]!.response.headers
  expect(headers['content-type']).toBe('text/event-stream; charset=utf-8')
  expect(headers['cache-control']).toBe('no-cache, no-transform')
  expect(headers['x-accel-buffering']).toBe('no')
  const closing = app.close()
  await waitFor(() => expect(streams.every((stream) => stream.ended)).toBe(true))
  await closing
})

test('app.close wakes a blocked replay and releases its retention protection', async () => {
  await seed(1100)
  await start({}, (app) => {
    app.addHook('onRequest', (_request, reply, done) => {
      const write = reply.raw.write.bind(reply.raw)
      vi.spyOn(reply.raw, 'write').mockImplementation((chunk) => {
        write(chunk)
        return false
      })
      done()
    })
  })
  const slow = await app.inject({
    url: `/api/stream?since=0&epoch=${getEpoch(db)}`,
    payloadAsStream: true,
  })
  slow.stream().on('error', () => undefined)
  const closing = app.close()
  await waitFor(() => expect(slow.raw.res.destroyed).toBe(true))
  await closing
  await setImmediate()
  expect(pruneEvents(db, { olderThan: '2026-10-07T00:00:00.000Z' })).toBe(1100)
})

test('corrupt replay logs the failure and closes the connection', async () => {
  await seed(2)
  db.sqlite.prepare('UPDATE events SET data = ? WHERE seq = 2').run('{broken')
  await start()
  const log = vi.spyOn(app.log, 'error')
  const stream = await client(`?since=0&epoch=${getEpoch(db)}`)
  await waitFor(() => expect(stream.ended).toBe(true))
  expect(log).toHaveBeenCalledExactlyOnceWith(
    { err: expect.any(Error) },
    'Stream replay failed; closing connection',
  )
  expect(stream.seqs).toEqual([1])
})

test('a client that stops reading exceeds its byte budget while a fast client receives every event', async () => {
  await start({ streamOptions: { fanoutOptions: { byteBudget: 256 * 1024 } } })
  let slowClosed = false
  const slow = await app.inject({ url: '/api/stream', payloadAsStream: true })
  slow.raw.res.once('close', () => (slowClosed = true))
  slow.stream().on('error', () => undefined)
  const fast = await client()
  const append = 'x'.repeat(64 * 1024)
  for (let i = 1; i <= 200; i++) {
    await ingest.submit(observation(String(i), append))
    await waitFor(() => expect(fast.seqs.at(-1)).toBe(i))
  }
  await waitFor(() => expect(slowClosed).toBe(true))
  expect(fast.ended).toBe(false)
  expect(fast.failure).toBeUndefined()
  expect(fast.seqs).toEqual(Array.from({ length: 200 }, (_, i) => i + 1))
}, 15_000)

test('replay turns an event too large to send into a reset instead of looping on it', async () => {
  await start({ streamOptions: { fanoutOptions: { maxFrameBytes: 4096 } } })
  await ingest.submit(observation('one'))
  await ingest.submit(observation('two', 'y'.repeat(8000)))
  await ingest.submit(observation('three'))
  const stream = await client(`?since=0&epoch=${getEpoch(db)}`)
  await waitFor(() => expect(stream.seqs).toEqual([1, 3]))
  const types = stream.frames.map((frame) => frame.type)
  expect(types).toContain('stream.reset')
  expect(stream.ended).toBe(false)
  expect(stream.failure).toBeUndefined()
})
