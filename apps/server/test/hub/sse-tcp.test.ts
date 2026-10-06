// Real-socket SSE tests. The other SSE tests use streaming inject(); backpressure, write timeouts
// and shutdown behave differently on a real TCP socket, so these listen on an ephemeral port.
// Sandboxes that forbid listening (EPERM) skip them.
import type { FastifyInstance } from 'fastify'
import { mkdtempSync, rmSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { getEpoch, migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { createIngest, type Ingest, type Observation } from '../../src/hub/ingest.ts'

let dir: string
let db: ScoreDb
let ingest: Ingest
let app: FastifyInstance
let base = ''
let skip = false
const sockets: Socket[] = []
const aborts: AbortController[] = []

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'score-sse-tcp-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  ingest = createIngest(db)
  const database = db
  app = buildApp({
    config: loadConfig({ SCORE_HOME: dir }),
    db,
    ingest,
    getEpoch: () => getEpoch(database),
    streamOptions: {
      heartbeatMs: 60_000,
      fanoutOptions: { byteBudget: 1024 * 1024, writeTimeoutMs: 500 },
    },
  })
  try {
    base = await app.listen({ host: '127.0.0.1', port: 0 })
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EPERM') skip = true
    else throw error
  }
})

afterEach(async () => {
  for (const abort of aborts.splice(0)) abort.abort()
  for (const socket of sockets.splice(0)) socket.destroy()
  await app.close()
  await ingest.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function delta(identity: string, append: string): Observation {
  return {
    source: 'score',
    identity,
    apply: () => [{ type: 'message.delta', data: { roomId: 'room', messageId: identity, append } }],
  }
}

// Reads durable event seqs from a real HTTP stream until `until` seqs arrived.
async function collect(query: string, until: number, timeoutMs = 10_000): Promise<number[]> {
  const abort = new AbortController()
  aborts.push(abort)
  const response = await fetch(`${base}/api/stream${query}`, { signal: abort.signal })
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const seqs: number[] = []
  let pending = ''
  const deadline = Date.now() + timeoutMs
  while (seqs.length < until && Date.now() < deadline) {
    let chunk: Awaited<ReturnType<typeof reader.read>>
    try {
      chunk = await reader.read()
    } catch {
      break // the server closed the connection; callers assert on what arrived
    }
    const { value, done } = chunk
    if (done) break
    pending += decoder.decode(value, { stream: true })
    let end: number
    while ((end = pending.indexOf('\n\n')) >= 0) {
      const id = /^id: (\d+)$/m.exec(pending.slice(0, end))
      if (id) seqs.push(Number(id[1]))
      pending = pending.slice(end + 2)
    }
  }
  abort.abort()
  return seqs
}

test('real sockets: concurrent producers and clients get every event exactly once, in order', async () => {
  if (skip) return
  for (let i = 1; i <= 50; i++) await ingest.submit(delta(`seed-${i}`, 'x'))
  const epoch = getEpoch(db)
  const total = 350
  const producing = (async () => {
    for (let i = 51; i <= total; i++) await ingest.submit(delta(`live-${i}`, 'y'.repeat(200)))
  })()
  const [fromStart, fromMiddle] = await Promise.all([
    collect(`?since=0&epoch=${epoch}`, total),
    collect(`?since=25&epoch=${epoch}`, total - 25),
  ])
  await producing
  const expect1 = Array.from({ length: total }, (_, i) => i + 1)
  expect(fromStart).toEqual(expect1)
  expect(fromMiddle).toEqual(expect1.slice(25))
})

test('real sockets: a client that stops reading is disconnected; a reading client is unaffected', async () => {
  if (skip) return
  const url = new URL(base)
  const slow = connect({ host: url.hostname, port: Number(url.port) })
  sockets.push(slow)
  slow.pause() // never read: kernel buffers fill, then the byte budget or write timeout trips
  await new Promise<void>((resolve) => slow.once('connect', () => resolve()))
  slow.write(`GET /api/stream HTTP/1.1\r\nHost: ${url.host}\r\nAccept: text/event-stream\r\n\r\n`)
  await new Promise((resolve) => setTimeout(resolve, 100))

  // Paced like real traffic: a reading client keeps up, so only the non-reader falls behind.
  const count = 600
  const fast = collect('', count, 25_000)
  await new Promise((resolve) => setTimeout(resolve, 100))
  const chunk = 'z'.repeat(32 * 1024)
  for (let i = 1; i <= count; i++) {
    await ingest.submit(delta(`big-${i}`, chunk))
    if (i % 8 === 0) await new Promise((resolve) => setTimeout(resolve, 5))
  }

  // A paused client socket can't surface 'close' while unread data is buffered, so check the
  // server side: once the reading client is done, no connection may remain open.
  expect(await fast).toHaveLength(count)
  const deadline = Date.now() + 5_000
  let open = -1
  while (Date.now() < deadline) {
    open = await new Promise<number>((resolve, reject) =>
      app.server.getConnections((error, n) => (error ? reject(error) : resolve(n))),
    )
    if (open === 0) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  expect(open).toBe(0)
}, 40_000)

test('real sockets: app.close() finishes promptly with a non-reading stream open', async () => {
  if (skip) return
  const url = new URL(base)
  const stuck = connect({ host: url.hostname, port: Number(url.port) })
  sockets.push(stuck)
  stuck.pause()
  await new Promise<void>((resolve) => stuck.once('connect', () => resolve()))
  stuck.write(`GET /api/stream HTTP/1.1\r\nHost: ${url.host}\r\n\r\n`)
  for (let i = 1; i <= 20; i++) await ingest.submit(delta(`c-${i}`, 'q'.repeat(64 * 1024)))
  const started = Date.now()
  await app.close()
  expect(Date.now() - started).toBeLessThan(2_000)
})
