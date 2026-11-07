import { expect, test, vi } from 'vitest'
import { rewindingRooms } from '../../src/domain/room-rewinding.ts'
import {
  access,
  bridge,
  call,
  connect,
  db,
  enable,
  hermes,
  ingest,
  post,
  setupMcpTest,
  url,
  type McpTestState,
} from './mcp-helpers.ts'

let now: number
let failTaskAction = false
const state: McpTestState = {
  get now() {
    return now
  },
  set now(value) {
    now = value
  },
  get failTaskAction() {
    return failTaskAction
  },
  set failTaskAction(value) {
    failTaskAction = value
  },
}
setupMcpTest(state)

test('batches are refused and concurrent calls are bounded', async () => {
  const token = enable('builder')
  const batch = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(
      Array.from({ length: 100 }, (_, id) => ({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'knowledge.read', arguments: { path: 'a.md' } },
      })),
    ),
  })
  expect(batch.status).toBe(400)
  // Hold four posts inside the queue: the fifth request is refused until one finishes.
  access.patch('builder', { writesEnabled: true })
  let release = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  const real = ingest.submit.bind(ingest)
  vi.spyOn(ingest, 'submit').mockImplementation(async (observation) => {
    await gate
    return real(observation)
  })
  const call1 = (id: number) =>
    fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'rooms.post', arguments: { roomId: 'r1', text: `p${id}` } },
      }),
    })
  const held = [1, 2, 3, 4].map(call1)
  await vi.waitFor(() => expect(ingest.submit).toHaveBeenCalledTimes(4))
  expect((await post(token)).status).toBe(429)
  release()
  expect((await Promise.all(held)).map((response) => response.status)).toEqual([200, 200, 200, 200])
  expect((await post(token)).status).toBe(200)
})

test('post limits are bytes, not characters', async () => {
  const client = await connect(enable('builder', true))
  // 3 bytes each: 2,730 of them fit under 8 KiB, 2,731 do not, though both are under 8,192 characters.
  const fits = await call(client, 'rooms.post', { roomId: 'r1', text: '€'.repeat(2730) })
  expect(fits.error).toBe(false)
  const over = await call(client, 'rooms.post', { roomId: 'r1', text: '€'.repeat(2731) })
  expect(over.error).toBe(true)
  expect(over.text).toContain('payload_too_large')
  const comment = await call(client, 'tasks.comment', { taskId: 't1', text: '€'.repeat(501) })
  expect(comment.error).toBe(true)
  expect(access.postsLastHour('builder')).toBe(1)
})

test('a rewind that starts while a post waits in the queue stops the post', async () => {
  const client = await connect(enable('builder', true))
  const real = ingest.submit.bind(ingest)
  vi.spyOn(ingest, 'submit').mockImplementationOnce((observation) => {
    rewindingRooms.add('r1')
    return real(observation)
  })
  try {
    const result = await call(client, 'rooms.post', { roomId: 'r1', text: 'late' })
    expect(result.error).toBe(true)
    expect(result.text).toContain('rewound')
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 })
    expect(access.postsLastHour('builder')).toBe(0)
  } finally {
    rewindingRooms.delete('r1')
  }
})

test('SCORE-024: permits are released when the tools finish, not when the client disconnects', async () => {
  const token = enable('builder', true)
  let release!: () => void
  hermes.hold = new Promise<void>((resolve) => (release = resolve))
  const arrived = (n: number) =>
    new Promise<void>((resolve) => {
      const check = () => (hermes.started >= n ? resolve() : void hermes.waiters.push(check))
      check()
    })
  const comment = (id: number, signal?: AbortSignal) =>
    fetch(url, {
      method: 'POST',
      ...(signal ? { signal } : {}),
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'tasks.comment', arguments: { taskId: 't1', text: `c${id}` } },
      }),
    })
  const aborts = [1, 2, 3, 4].map(() => new AbortController())
  const first = aborts.map((abort, i) => comment(i + 1, abort.signal).catch(() => undefined))
  await arrived(4)
  for (const abort of aborts) abort.abort()
  await Promise.all(first)
  // Wait until the server has seen every connection go away (its response-close handlers have run).
  while ((await new Promise<number>((r) => bridge.server.getConnections((_e, n) => r(n)))) > 0)
    await new Promise((r) => setImmediate(r))
  // The four clients are gone but their tools still run: a fifth call must still be refused, not started.
  const outcome = await Promise.race([
    comment(5).then((res) => res.status),
    arrived(5).then(() => 'started'),
  ])
  expect(outcome).toBe(429)
  expect(hermes.peak).toBeLessThanOrEqual(4)
  expect(hermes.active).toBe(4)
  release()
})
