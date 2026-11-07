import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import { CodingSocketServer } from '../../src/runtimes/coding/coding-socket.ts'
import { UNIT_CAPABLE_FILE } from '../../src/runtimes/coding/unit-backend.ts'
import {
  INSTALLATION,
  addAgent,
  afterEachHarness,
  app,
  backend,
  beforeEachHarness,
  boot,
  coding,
  db,
  dir,
  fake,
  finished,
  launches,
  makeBackend,
  makeRoom,
  namespace,
  processLaunches,
  request,
  runs,
  say,
} from './coding-units-runtime-helpers.ts'

beforeEach(beforeEachHarness)
afterEach(afterEachHarness)

// ---- backend selection and the card -----------------------------------------------------------------------------------

test('an installation that never passed the check keeps the process-group backend; Check again follows the host', async () => {
  // Never passed: no marker, and the host fails the check from the start.
  await coding.close()
  await app.close()
  rmSync(join(namespace, UNIT_CAPABLE_FILE), { force: true })
  fake.hooks.lingerOff = true
  await boot()
  const recheck = await request('POST', '/api/coding-agents/backend/check', {})
  expect(recheck.statusCode, recheck.body).toBe(200)
  expect(recheck.json()).toMatchObject({ kind: 'process-group' })
  expect(recheck.json().checks.find((c: { name: string }) => c.name === 'linger')).toMatchObject({
    ok: false,
  })
  expect(recheck.json().note).toContain('tools a coding CLI started may keep running')
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:basic] go')
  await finished()
  expect(runs()[0]!.status).toBe('completed')
  expect(processLaunches).toBe(1)
  // No unit launch: the fallback keeps no journal.
  expect(launches()).toEqual([])
  fake.hooks.lingerOff = false
  const again = await request('POST', '/api/coding-agents/backend/check', {})
  expect(again.json()).toMatchObject({ kind: 'unit', note: 'Runs as a supervised system service.' })
  const read = await request('GET', '/api/coding-agents/backend')
  expect(read.json().kind).toBe('unit')
})

// audit4 S4-006: "Check again" retries a listener that failed to bind.
async function bootWithSocketDir(rt: string) {
  await coding.close()
  await app.close()
  mkdirSync(join(rt, 'score'), { recursive: true, mode: 0o700 })
  await boot({ unit: { runtimeDir: rt } })
  return CodingSocketServer.socketPath(rt, INSTALLATION)
}
const socketCheck = (body: { checks: { name: string; ok: boolean; detail: string }[] }) =>
  body.checks.find((c) => c.name === 'socket')!
const connects = (path: string) =>
  new Promise<boolean>((resolve) => {
    const c = net.connect(path)
    c.once('connect', () => (c.destroy(), resolve(true)))
    c.once('error', () => resolve(false))
  })

test('Check again rebinds a listener that failed to start; concurrent rechecks share one bind', async () => {
  const rt = join(dir, 'rt2')
  const path = await bootWithSocketDir(rt)
  expect(socketCheck((await request('GET', '/api/coding-agents/backend')).json())).toMatchObject({
    ok: true,
  })
  // Fresh backend whose first bind fails: a non-socket occupies the path.
  await coding.close()
  await app.close()
  const rt3 = join(dir, 'rt3')
  mkdirSync(join(rt3, 'score'), { recursive: true, mode: 0o700 })
  const blocked = CodingSocketServer.socketPath(rt3, INSTALLATION)
  writeFileSync(blocked, 'not a socket')
  await boot({ unit: { runtimeDir: rt3 } })
  const first = await request('GET', '/api/coding-agents/backend')
  expect(socketCheck(first.json())).toMatchObject({ ok: false })
  expect(await connects(blocked)).toBe(false)
  expect(path).not.toBe(blocked)
  // The obstacle goes away; three simultaneous rechecks bind exactly once.
  rmSync(blocked)
  const starts = vi.spyOn(backend.socket, 'start')
  const results = await Promise.all(
    [1, 2, 3].map(() => request('POST', '/api/coding-agents/backend/check', {})),
  )
  for (const r of results) expect(socketCheck(r.json())).toMatchObject({ ok: true })
  expect(starts).toHaveBeenCalledTimes(1)
  expect(await connects(blocked)).toBe(true)
  expect(results[0]!.json()).toMatchObject({ kind: 'unit' })
  // Idempotent: another recheck does not rebind or mistake our own listener for a foreign one.
  const again = await request('POST', '/api/coding-agents/backend/check', {})
  expect(socketCheck(again.json())).toMatchObject({ ok: true })
  expect(starts).toHaveBeenCalledTimes(1)
})

test('Check again still refuses a foreign listener on the socket path', async () => {
  await coding.close()
  await app.close()
  const rt = join(dir, 'rt4')
  mkdirSync(join(rt, 'score'), { recursive: true, mode: 0o700 })
  const foreignPath = CodingSocketServer.socketPath(rt, INSTALLATION)
  const foreign = net.createServer((c) => c.destroy())
  await new Promise<void>((resolve) => foreign.listen(foreignPath, () => resolve()))
  try {
    await boot({ unit: { runtimeDir: rt } })
    for (let i = 0; i < 2; i++) {
      const r = await request('POST', '/api/coding-agents/backend/check', {})
      expect(socketCheck(r.json())).toMatchObject({ ok: false })
      expect(socketCheck(r.json()).detail).toContain('another process is listening')
    }
    expect(backend.socket.listening).toBe(false)
  } finally {
    await new Promise<void>((resolve) => foreign.close(() => resolve()))
  }
})

// audit5 S5-006: close() owns the listener's whole lifecycle, including a bind that is still in flight.
test('close() during an in-flight bind leaves no listener; a later Check again does not rebind', async () => {
  const rt = join(dir, 'rt-close')
  mkdirSync(join(rt, 'score'), { recursive: true, mode: 0o700 })
  const path = CodingSocketServer.socketPath(rt, INSTALLATION)
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  let held!: () => void
  const heldSeen = new Promise<void>((resolve) => (held = resolve))
  const realCreate = net.createServer.bind(net)
  let first = true
  vi.spyOn(net, 'createServer').mockImplementation(((...args: never[]) => {
    const server = realCreate(...args)
    if (!first) return server
    first = false
    const listen = server.listen.bind(server) as (...a: unknown[]) => net.Server
    // A real server whose bind is held: the supervisor socket cannot finish listening until released.
    server.listen = ((...a: unknown[]) => {
      held()
      void gate.then(() => listen(...a))
      return server
    }) as typeof server.listen
    return server
  }) as typeof net.createServer)
  const other = makeBackend({ unit: { runtimeDir: rt } })
  const checking = other.check()
  await heldSeen
  const closing = other.close()
  const closingAgain = other.close()
  release()
  await Promise.all([closing, closingAgain, checking])
  expect(other.socket.listening).toBe(false)
  expect(await connects(path)).toBe(false)
  expect(existsSync(path)).toBe(false)
  // "Check again" after shutdown must not bring the listener back.
  await other.check()
  expect(other.socket.listening).toBe(false)
  expect(await connects(path)).toBe(false)
})

// audit4 S4-C01: two same-turn admissions never diverge from the persisted run.
for (const pending of [false, true]) {
  test(`two concurrent same-turn startRun calls share one persisted run and one execution (${pending ? 'with' : 'without'} a pending intent)`, async () => {
    await addAgent()
    const turnId = `turn-conc-${pending}`
    if (pending) {
      const now = new Date().toISOString()
      db.sqlite
        .prepare(
          `INSERT INTO command_intents (id, kind, idempotency_key, payload, state, created_at, updated_at)
           VALUES (?, 'start_coding_run', ?, ?, 'pending', ?, ?)`,
        )
        .run(
          'intent-pre',
          turnId,
          JSON.stringify({
            agentId: 'coder',
            input: '[fixture:basic] go',
            sessionId: null,
            model: null,
          }),
          now,
          now,
        )
    }
    const req = { agentId: 'coder', input: '[fixture:basic] go', turnId }
    const [a, b] = await Promise.all([coding.startRun(req), coding.startRun(req)])
    expect(a.runId).toBe(b.runId)
    const rows = runs()
    expect(rows.map((r) => r.id)).toEqual([a.runId])
    const intent = db.sqlite
      .prepare('SELECT state, result FROM command_intents WHERE idempotency_key = ?')
      .all(turnId)
    expect(intent).toEqual([{ state: 'accepted', result: a.runId }])
    await finished()
    expect(launches()).toHaveLength(1)
    expect(runs()).toHaveLength(1)
  })
}

test('without a unit backend the card says so (fake mode and old hosts)', async () => {
  await coding.close()
  await app.close()
  await boot({ noUnit: true })
  const read = await request('GET', '/api/coding-agents/backend')
  expect(read.json()).toMatchObject({ kind: 'process-group', checks: [] })
})
