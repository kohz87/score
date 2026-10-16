import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, statSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import {
  CodingSocketServer,
  SocketStartError,
  type RunSession,
  type SessionOutcome,
} from '../../src/runtimes/coding/coding-socket.ts'

// 7.7a part 2: the Score side of the wire protocol against a fake supervisor (raw frames). Fake-boundary tests.

const servers: CodingSocketServer[] = []
const clients: net.Socket[] = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.destroy()
  for (const s of servers.splice(0)) await s.shutdown()
})

const INSTALL = '0123456789abcdef'
async function setup(
  limits: Partial<ConstructorParameters<typeof CodingSocketServer>[0]['limits']> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'score-sock-'))
  const server = new CodingSocketServer({ runtimeDir: dir, installationId: INSTALL, limits })
  await server.start(true)
  servers.push(server)
  return { dir, server }
}

class FakeSupervisor {
  frames: Record<string, unknown>[] = []
  closed = false
  private buf = ''
  readonly socket: net.Socket
  constructor(path: string) {
    this.socket = net.connect(path)
    clients.push(this.socket)
    this.socket.setEncoding('utf8')
    this.socket.on('data', (d: string) => {
      this.buf += d
      let i
      while ((i = this.buf.indexOf('\n')) >= 0) {
        this.frames.push(JSON.parse(this.buf.slice(0, i)))
        this.buf = this.buf.slice(i + 1)
      }
    })
    this.socket.on('close', () => (this.closed = true))
    this.socket.on('error', () => undefined)
  }
  send(frame: Record<string, unknown>) {
    this.socket.write(JSON.stringify({ v: 1, ...frame }) + '\n')
  }
  hello(launch: string, token: string, specHash = 'h', generation = 1) {
    this.send({ t: 'hello', launch, generation, token, specHash })
  }
  out(stream: 'stdout' | 'stderr', seq: number, text: string | Buffer) {
    this.send({ t: 'out', stream, seq, data: Buffer.from(text).toString('base64') })
  }
  has(t: string) {
    return this.frames.some((f) => f['t'] === t)
  }
}

function register(server: CodingSocketServer, launch = 'L1', records: string[] = []) {
  const reg = server.expect({
    launch,
    generation: 1,
    specHash: 'h',
    handlers: { onStdoutRecord: (l) => void records.push(l) },
  })
  return { ...reg, records }
}

async function connect(server: CodingSocketServer, launch = 'L1') {
  const reg = register(server, launch)
  const sup = new FakeSupervisor(server.path)
  sup.hello(launch, reg.token)
  await vi.waitFor(() => expect(sup.has('welcome')).toBe(true))
  return { ...reg, sup }
}

async function finishCleanly(
  sup: FakeSupervisor,
  session: RunSession,
  lastOut = 0,
): Promise<SessionOutcome> {
  sup.send({ t: 'eof', stream: 'stdout', lastSeq: lastOut })
  sup.send({ t: 'eof', stream: 'stderr', lastSeq: 0 })
  sup.send({ t: 'exit', code: 0, signal: null })
  sup.send({ t: 'end' })
  await vi.waitFor(() => expect(sup.has('ack-end')).toBe(true))
  sup.socket.end()
  return session.outcome
}

test('hello with the right token is welcomed; ready, go and the terminal order work end to end', async () => {
  const { server } = await setup()
  const { sup, session, records } = await connect(server)
  sup.send({ t: 'ready', pid: 4242, start: '777', cgroup: '/user.slice/x.service' })
  expect(await session.ready).toEqual({ pid: 4242, start: '777', cgroup: '/user.slice/x.service' })
  session.go()
  await vi.waitFor(() => expect(sup.has('go')).toBe(true))
  sup.out('stdout', 1, 'one\ntwo\n')
  const outcome = await finishCleanly(sup, session, 1)
  expect(records).toEqual(['one', 'two'])
  expect(outcome).toMatchObject({ kind: 'ended', eligible: true, reasons: [], ackFlushed: true })
})

test('a token is single-use: a replay and a second connection for the same launch are rejected', async () => {
  const { server } = await setup()
  const { sup, token } = await connect(server)
  const second = new FakeSupervisor(server.path)
  second.hello('L1', token)
  await vi.waitFor(() =>
    expect(second.frames[0]).toMatchObject({ t: 'reject', reason: 'already-connected' }),
  )
  expect(sup.closed).toBe(false)
  // After the first connection ended, the launch is forgotten: a later replay is just unknown.
  sup.socket.destroy()
  await vi.waitFor(() => expect(sup.closed).toBe(true))
  const third = new FakeSupervisor(server.path)
  third.hello('L1', token)
  await vi.waitFor(() =>
    expect(third.frames[0]).toMatchObject({ t: 'reject', reason: 'unknown-launch' }),
  )
})

test('wrong token, wrong generation, wrong spec hash and unknown launch are rejected without echoing the token', async () => {
  const { server } = await setup()
  const { token } = register(server)
  for (const [launch, tok, hash, gen, reason] of [
    ['L1', 'f'.repeat(64), 'h', 1, 'mismatch'],
    ['L1', token, 'other', 1, 'mismatch'],
    ['L1', token, 'h', 2, 'mismatch'],
    ['nope', token, 'h', 1, 'unknown-launch'],
  ] as const) {
    const s = new FakeSupervisor(server.path)
    s.hello(launch, tok, hash, gen)
    await vi.waitFor(() => expect(s.frames[0]).toMatchObject({ t: 'reject', reason }))
    expect(JSON.stringify(s.frames)).not.toContain(tok)
  }
  // None of those burned the real token.
  const ok = new FakeSupervisor(server.path)
  ok.hello('L1', token)
  await vi.waitFor(() => expect(ok.has('welcome')).toBe(true))
})

test('a token from another Score incarnation does not verify', async () => {
  const a = await setup()
  const b = await setup()
  const { token } = register(a.server)
  register(b.server)
  const s = new FakeSupervisor(b.server.path)
  s.hello('L1', token)
  await vi.waitFor(() => expect(s.frames[0]).toMatchObject({ t: 'reject' }))
})

test('frames over 64 KB and malformed hellos are refused; a silent connection is dropped after the hello timeout', async () => {
  const { server } = await setup({ helloTimeoutMs: 200 })
  const big = new FakeSupervisor(server.path)
  big.socket.write('x'.repeat(70 * 1024))
  await vi.waitFor(() => expect(big.closed).toBe(true))
  const junk = new FakeSupervisor(server.path)
  junk.socket.write('not json\n')
  await vi.waitFor(() => expect(junk.frames[0]).toMatchObject({ t: 'reject', reason: 'bad-hello' }))
  const silent = new FakeSupervisor(server.path)
  await vi.waitFor(() => expect(silent.closed).toBe(true))
})

test('an oversize frame after hello destroys the connection: socket loss, ineligible', async () => {
  const { server } = await setup()
  const { sup, session } = await connect(server)
  sup.socket.write('y'.repeat(70 * 1024))
  const outcome = await session.outcome
  expect(outcome).toMatchObject({ kind: 'lost', eligible: false })
  expect(outcome.reasons).toContain('frame-too-large')
})

test('stdout reassembles lines across chunks and across a split multibyte character', async () => {
  const { server } = await setup()
  const { sup, session, records } = await connect(server)
  const bytes = Buffer.from('{"t":"€x"}\n{"t":"😀"}\n')
  const cut = bytes.indexOf(0xe2) + 1 // inside the euro sign
  const cut2 = bytes.indexOf(0xf0) + 2 // inside the emoji
  sup.out('stdout', 1, bytes.subarray(0, cut))
  sup.out('stdout', 2, bytes.subarray(cut, cut2))
  sup.out('stdout', 3, bytes.subarray(cut2))
  const outcome = await finishCleanly(sup, session, 3)
  expect(records).toEqual(['{"t":"€x"}', '{"t":"😀"}'])
  expect(outcome.eligible).toBe(true)
})

test('a sequence gap or repeat makes the run ineligible and stops it', async () => {
  const { server } = await setup()
  const { sup, session } = await connect(server)
  sup.out('stdout', 1, 'a\n')
  sup.out('stdout', 3, 'c\n')
  await vi.waitFor(() => expect(sup.frames.some((f) => f['t'] === 'stop')).toBe(true))
  sup.socket.destroy() // the supervisor, told to stop, goes away
  const outcome = await session.outcome
  expect(outcome.eligible).toBe(false)
  expect(outcome.reasons).toContain('seq-stdout')
})

test('eof.lastSeq must match what was received; a partial stdout line at eof is a dropped record', async () => {
  const { server } = await setup()
  const { sup, session } = await connect(server)
  sup.out('stdout', 1, '{"a":1}\n{"par')
  sup.send({ t: 'eof', stream: 'stdout', lastSeq: 2 })
  sup.send({ t: 'eof', stream: 'stderr', lastSeq: 0 })
  sup.send({ t: 'exit', code: 0, signal: null })
  sup.send({ t: 'end' })
  await vi.waitFor(() => expect(sup.has('ack-end')).toBe(true))
  sup.socket.end()
  const outcome = await session.outcome
  expect(outcome.eligible).toBe(false)
  expect(outcome.reasons).toEqual(expect.arrayContaining(['eof-seq-stdout', 'dropped-record']))
  expect(outcome.droppedRecords).toBe(1)
})

test('ack-end is sent only after every stdout record is processed; a failing handler makes the result ineligible', async () => {
  const { server } = await setup()
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const { token, session } = server.expect({
    launch: 'L9',
    generation: 1,
    specHash: 'h',
    handlers: {
      onStdoutRecord: async (line) => {
        await gate
        if (line === 'bad') throw new Error('x')
      },
    },
  })
  const sup = new FakeSupervisor(server.path)
  sup.hello('L9', token)
  await vi.waitFor(() => expect(sup.has('welcome')).toBe(true))
  sup.out('stdout', 1, 'good\nbad\n')
  sup.send({ t: 'eof', stream: 'stdout', lastSeq: 1 })
  sup.send({ t: 'eof', stream: 'stderr', lastSeq: 0 })
  sup.send({ t: 'exit', code: 0, signal: null })
  sup.send({ t: 'end' })
  await new Promise((r) => setTimeout(r, 150))
  expect(sup.has('ack-end')).toBe(false)
  release()
  await vi.waitFor(() => expect(sup.has('ack-end')).toBe(true))
  sup.socket.end()
  const outcome = await session.outcome
  expect(outcome.eligible).toBe(false)
  expect(outcome.reasons).toContain('ingest-failure')
})

test('any close other than after ack-end is socket loss', async () => {
  const { server } = await setup()
  const { sup, session } = await connect(server)
  sup.out('stdout', 1, 'partial\n')
  sup.socket.destroy()
  const outcome = await session.outcome
  expect(outcome.reasons).toEqual(expect.arrayContaining(['socket-loss']))
  expect(outcome.eligible).toBe(false)
})

test('an oversize stdout record is dropped (lossy) and the run is stopped (review #15)', async () => {
  const { server } = await setup({ maxRecordBytes: 100 })
  const { sup, session, records } = await connect(server)
  sup.out('stdout', 1, 'ok\n' + 'z'.repeat(5000) + '\nafter\n')
  await vi.waitFor(() => expect(sup.frames.some((f) => f['t'] === 'stop')).toBe(true))
  const outcome = await finishCleanly(sup, session, 1)
  expect(records).toEqual(['ok', 'after'])
  expect(outcome).toMatchObject({ eligible: false, droppedRecords: 1 })
  expect(outcome.reasons).toContain('record-too-large')
})

test('partial records count against the installation memory budget (review #15)', async () => {
  const { server } = await setup({ memoryBudgetBytes: 1000, pauseBytes: 1_000_000 })
  const mk = (id: string) =>
    server.expect({
      launch: id,
      generation: 1,
      specHash: 'h',
      handlers: { onStdoutRecord: () => undefined },
    })
  const a = mk('A')
  const b = mk('B')
  const sa = new FakeSupervisor(server.path)
  const sb = new FakeSupervisor(server.path)
  sa.hello('A', a.token)
  sb.hello('B', b.token)
  await vi.waitFor(() => expect(sa.has('welcome') && sb.has('welcome')).toBe(true))
  sa.out('stdout', 1, 'a'.repeat(600))
  await vi.waitFor(() => expect(server.bufferedBytes).toBe(600))
  sb.out('stdout', 1, 'b'.repeat(600))
  await vi.waitFor(() => expect(sb.frames.some((f) => f['t'] === 'stop')).toBe(true))
  expect(server.bufferedBytes).toBeLessThanOrEqual(1000)
  sb.socket.destroy()
  expect((await b.session.outcome).reasons).toContain('memory-budget')
  // The completed line releases the charge.
  sa.out('stdout', 2, '\n')
  await vi.waitFor(() => expect(server.bufferedBytes).toBe(0))
})

test('queue entries carry per-record overhead against the memory budget (review #15)', async () => {
  const { server } = await setup({ memoryBudgetBytes: 1000, pauseBytes: 1_000_000 })
  const never = new Promise<void>(() => undefined)
  const reg = server.expect({
    launch: 'Q',
    generation: 1,
    specHash: 'h',
    handlers: { onStdoutRecord: () => never },
  })
  const sup = new FakeSupervisor(server.path)
  sup.hello('Q', reg.token)
  await vi.waitFor(() => expect(sup.has('welcome')).toBe(true))
  sup.out('stdout', 1, '\n'.repeat(40)) // empty records: zero text bytes, still queue entries
  await vi.waitFor(() => expect(sup.frames.some((f) => f['t'] === 'stop')).toBe(true))
  expect(server.bufferedBytes).toBeLessThanOrEqual(1000)
  sup.socket.destroy()
  expect((await reg.session.outcome).reasons).toContain('memory-budget')
})

test('the installation-wide memory budget caps buffered records across runs', async () => {
  const { server } = await setup({ memoryBudgetBytes: 1000, pauseBytes: 1_000_000 })
  const never = new Promise<void>(() => undefined)
  const mk = (id: string) =>
    server.expect({
      launch: id,
      generation: 1,
      specHash: 'h',
      handlers: { onStdoutRecord: () => never },
    })
  const a = mk('A')
  const b = mk('B')
  const sa = new FakeSupervisor(server.path)
  const sb = new FakeSupervisor(server.path)
  sa.hello('A', a.token)
  sb.hello('B', b.token)
  await vi.waitFor(() => expect(sa.has('welcome') && sb.has('welcome')).toBe(true))
  sa.out('stdout', 1, 'a'.repeat(600) + '\n')
  sb.out('stdout', 1, 'b'.repeat(600) + '\n')
  await vi.waitFor(() => expect(sb.frames.some((f) => f['t'] === 'stop')).toBe(true))
  expect(server.bufferedBytes).toBeLessThanOrEqual(1000)
  sb.socket.destroy()
  expect((await b.session.outcome).reasons).toContain('memory-budget')
})

test('the socket path: <runtime>/score/<installation8>.sock, directory 0700, too-long paths refused', async () => {
  const { dir, server } = await setup()
  expect(server.path).toBe(join(dir, 'score', '01234567.sock'))
  expect(statSync(join(dir, 'score')).mode & 0o777).toBe(0o700)
  expect(statSync(server.path).mode & 0o777).toBe(0o600)
  const long = new CodingSocketServer({
    runtimeDir: join(dir, 'a'.repeat(120)),
    installationId: INSTALL,
  })
  await expect(long.start(true)).rejects.toMatchObject({ code: 'path-too-long' })
})

test('a stale socket is removed only while holding the installation lock; a live foreign listener is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'score-stale-'))
  const path = CodingSocketServer.socketPath(dir, INSTALL)
  mkdirSync(join(dir, 'score'), { mode: 0o700 })
  // A stale socket file: bind then abandon without unlinking.
  const stale = spawn(
    process.execPath,
    ['-e', `require('net').createServer().listen(process.argv[1], () => console.log('up'))`, path],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  )
  await new Promise<void>((r) => stale.stdout.once('data', () => r()))
  stale.kill('SIGKILL') // our own child; the kernel leaves the socket file behind
  await new Promise((r) => stale.once('exit', r))
  expect(existsSync(path)).toBe(true)
  const noLock = new CodingSocketServer({ runtimeDir: dir, installationId: INSTALL })
  await expect(noLock.start(false)).rejects.toBeInstanceOf(SocketStartError)
  expect(existsSync(path)).toBe(true)
  const withLock = new CodingSocketServer({ runtimeDir: dir, installationId: INSTALL })
  await withLock.start(true)
  servers.push(withLock)
  // Now a live listener holds the path.
  const other = new CodingSocketServer({ runtimeDir: dir, installationId: INSTALL })
  await expect(other.start(true)).rejects.toMatchObject({ code: 'foreign-listener' })
  // A non-socket in the way is never deleted.
  const dir2 = mkdtempSync(join(tmpdir(), 'score-notsock-'))
  mkdirSync(join(dir2, 'score'), { mode: 0o700 })
  writeFileSync(CodingSocketServer.socketPath(dir2, INSTALL), 'x')
  await expect(
    new CodingSocketServer({ runtimeDir: dir2, installationId: INSTALL }).start(true),
  ).rejects.toMatchObject({
    code: 'not-a-socket',
  })
  chmodSync(dir, 0o700)
})

test('shutdown sends stop to attached runs and destroys the accepted sockets explicitly', async () => {
  const { server } = await setup()
  const { sup, session } = await connect(server)
  await server.shutdown()
  expect(sup.frames.some((f) => f['t'] === 'stop' && f['cause'] === 'score-shutdown')).toBe(true)
  await vi.waitFor(() => expect(sup.closed).toBe(true))
  expect((await session.outcome).kind).toBe('lost')
  expect(existsSync(server.path)).toBe(false)
})

test('FT #5: a held Score drops the sockets at shutdown without sending its own Stop frame', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'score-sock-'))
  const server = new CodingSocketServer({
    runtimeDir: dir,
    installationId: INSTALL,
    frozen: () => 'Score is holding all agent work.',
  })
  await server.start(true)
  servers.push(server)
  const { sup, session } = await connect(server)
  await server.shutdown()
  await vi.waitFor(() => expect(sup.closed).toBe(true))
  expect(sup.frames.some((f) => f['t'] === 'stop')).toBe(false)
  expect((await session.outcome).kind).toBe('lost')
})

// ---- review 2026-10-12 #1 and #7: terminal order and forced closure ------------------------------------------------

test('#7: an early end (before EOF and exit) is never acknowledged and is not eligible', async () => {
  const { server } = await setup()
  const { sup, session } = await connect(server)
  sup.out('stdout', 1, 'one\n')
  sup.send({ t: 'end' })
  await vi.waitFor(() => expect(sup.closed).toBe(true))
  expect(sup.has('ack-end')).toBe(false)
  const outcome = await session.outcome
  expect(outcome.eligible).toBe(false)
  expect(outcome.reasons).toContain('socket-loss')
})

test('#7: output after end is refused and the connection is dropped', async () => {
  const { server } = await setup()
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const { token, session } = server.expect({
    launch: 'L7',
    generation: 1,
    specHash: 'h',
    handlers: { onStdoutRecord: () => gate },
  })
  const sup = new FakeSupervisor(server.path)
  sup.hello('L7', token)
  await vi.waitFor(() => expect(sup.has('welcome')).toBe(true))
  sup.out('stdout', 1, 'a\n')
  sup.send({ t: 'eof', stream: 'stdout', lastSeq: 1 })
  sup.send({ t: 'eof', stream: 'stderr', lastSeq: 0 })
  sup.send({ t: 'exit', code: 0, signal: null })
  sup.send({ t: 'end' })
  sup.out('stderr', 1, 'late\n') // after end
  await vi.waitFor(() => expect(sup.closed).toBe(true))
  release()
  const outcome = await session.outcome
  expect(sup.has('ack-end')).toBe(false)
  expect(outcome.eligible).toBe(false)
})

test('#1: an eof the supervisor forced (a pipe it closed itself) is loss, not a clean end of stream', async () => {
  const { server } = await setup()
  const { sup, session } = await connect(server)
  sup.out('stdout', 1, '{"ok":1}\n')
  sup.send({ t: 'eof', stream: 'stdout', lastSeq: 1, forced: true })
  sup.send({ t: 'eof', stream: 'stderr', lastSeq: 0 })
  sup.send({ t: 'exit', code: 0, signal: null })
  sup.send({ t: 'end' })
  await vi.waitFor(() => expect(sup.has('ack-end')).toBe(true))
  sup.socket.end()
  const outcome = await session.outcome
  expect(outcome.eligible).toBe(false)
  expect(outcome.reasons).toContain('forced-eof-stdout')
  expect(outcome.droppedRecords).toBeGreaterThan(0)
})

test('#15: what an active run keeps in memory is reserved from the installation budget and released at its end', async () => {
  const { server } = await setup({ memoryBudgetBytes: 1000 })
  const a = server.expect({
    launch: 'A',
    generation: 1,
    specHash: 'h',
    handlers: { onStdoutRecord: () => undefined },
    retainedBytes: 400,
  })
  expect(server.bufferedBytes).toBe(400)
  server.expect({
    launch: 'B',
    generation: 1,
    specHash: 'h',
    handlers: { onStdoutRecord: () => undefined },
    retainedBytes: 400,
  })
  expect(server.bufferedBytes).toBe(800)
  // A third does not fit: the launch is refused, nothing is left reserved for it.
  expect(() =>
    server.expect({
      launch: 'C',
      generation: 1,
      specHash: 'h',
      handlers: { onStdoutRecord: () => undefined },
      retainedBytes: 400,
    }),
  ).toThrow('memory-budget')
  expect(server.bufferedBytes).toBe(800)
  server.forget('B')
  expect(server.bufferedBytes).toBe(400)
  const sup = new FakeSupervisor(server.path)
  sup.hello('A', a.token)
  await vi.waitFor(() => expect(sup.has('welcome')).toBe(true))
  sup.socket.destroy()
  await a.session.outcome
  await vi.waitFor(() => expect(server.bufferedBytes).toBe(0))
})

test('re-review 2 #10: an ack-end that was queued but never delivered is not a normal end', async () => {
  const { server } = await setup()
  const { sup, session } = await connect(server)
  sup.send({ t: 'ready', pid: 1, start: '1', cgroup: '/x' })
  await session.ready
  // The write of the acknowledgment fails (peer gone): the supervisor never saw it and exits for socket loss.
  const socket = (session as unknown as { socket: net.Socket }).socket
  const write = socket.write.bind(socket) as (...args: unknown[]) => boolean
  socket.write = ((data: string, cb?: (error?: Error) => void) => {
    if (typeof data === 'string' && data.includes('"ack-end"')) {
      queueMicrotask(() => cb?.(new Error('EPIPE')))
      return true
    }
    return write(data, cb)
  }) as typeof socket.write
  sup.send({ t: 'eof', stream: 'stdout', lastSeq: 0 })
  sup.send({ t: 'eof', stream: 'stderr', lastSeq: 0 })
  sup.send({ t: 'exit', code: 0, signal: null })
  sup.send({ t: 'end' })
  // The supervisor gives up on the acknowledgment it never saw and closes.
  sup.socket.end()
  const outcome = await session.outcome
  expect(outcome.ackFlushed).toBe(false)
  expect(outcome.eligible).toBe(false)
  expect(outcome.reasons).toContain('ack-not-flushed')
})

test('re-review 2 #17: Score-side stops (broken bound, ingestion failure, shutdown) are reported to the hook before the frame goes out', async () => {
  const { server } = await setup()
  const causes: { cause: string; frameSeen: boolean }[] = []
  const supRef: { sup?: FakeSupervisor } = {}
  const note = (cause: string) =>
    causes.push({ cause, frameSeen: supRef.sup?.has('stop') ?? false })
  const reg = server.expect({
    launch: 'L1',
    generation: 1,
    specHash: 'h',
    handlers: {
      onStdoutRecord: (line) => {
        if (line === 'boom') throw new Error('cannot save')
      },
      onStop: note,
    },
  })
  const sup = new FakeSupervisor(server.path)
  supRef.sup = sup
  sup.hello('L1', reg.token)
  await vi.waitFor(() => expect(sup.has('welcome')).toBe(true))
  sup.out('stdout', 1, 'boom\n')
  await vi.waitFor(() => expect(causes.map((c) => c.cause)).toEqual(['ingest-failure']))
  // A gap in the sequence is a violation: its cause is reported too (the first stop cause already won, so none follows).
  expect(causes[0]!.frameSeen).toBe(false)
  await vi.waitFor(() => expect(sup.has('stop')).toBe(true))
  const seen: string[] = []
  const second = server.expect({
    launch: 'L2',
    generation: 1,
    specHash: 'h',
    handlers: { onStdoutRecord: () => undefined, onStop: (cause) => void seen.push(cause) },
  })
  const sup2 = new FakeSupervisor(server.path)
  sup2.hello('L2', second.token)
  await vi.waitFor(() => expect(sup2.has('welcome')).toBe(true))
  sup2.out('stdout', 2, 'gap\n')
  await vi.waitFor(() => expect(seen).toEqual(['seq-stdout']))
  await server.shutdown()
  servers.splice(servers.indexOf(server), 1)
})

test('FU #8: stderr diagnostics and commentary the handlers keep are charged to the budget as they change', async () => {
  const { server } = await setup({ memoryBudgetBytes: 1024 * 1024 })
  let diagnostics = 0
  const reg = server.expect({
    launch: 'L1',
    generation: 1,
    specHash: 'h',
    handlers: {
      onStdoutRecord: () => undefined,
      onStderr: (text: string) => {
        diagnostics += text.length
      },
      retainedBytes: () => diagnostics,
    },
    retainedBytes: 1024,
  })
  const sup = new FakeSupervisor(server.path)
  sup.hello('L1', reg.token)
  await vi.waitFor(() => expect(sup.has('welcome')).toBe(true))
  // Nothing from stdout arrives: only stderr grows what the handlers keep, and that alone is charged.
  sup.out('stderr', 1, 'x'.repeat(4000))
  await vi.waitFor(() => expect(server.bufferedBytes).toBe(4000))
  sup.socket.destroy()
  await reg.session.outcome
})

test('re-review 2 #18: a run is charged for what its parser really retains, and stopped past the installation budget', async () => {
  const { server } = await setup({ memoryBudgetBytes: 1024 * 1024 })
  let retained = 0
  const reg = server.expect({
    launch: 'L1',
    generation: 1,
    specHash: 'h',
    handlers: { onStdoutRecord: () => undefined, retainedBytes: () => retained },
    retainedBytes: 1024,
  })
  const sup = new FakeSupervisor(server.path)
  sup.hello('L1', reg.token)
  await vi.waitFor(() => expect(sup.has('welcome')).toBe(true))
  expect(server.bufferedBytes).toBe(1024)
  retained = 300 * 1024
  sup.out('stdout', 1, 'a\n')
  await vi.waitFor(() => expect(server.bufferedBytes).toBe(300 * 1024))
  // Many short ids were cheap in the old count; large retained values are charged by their bytes.
  retained = 5 * 1024 * 1024
  sup.out('stdout', 2, 'b\n')
  await vi.waitFor(() => expect(sup.has('stop')).toBe(true))
  // FV #3: the run stops, but the bytes it really holds stay charged (debt past the limit) until its state is cleared, so
  // nothing else is admitted on top of them.
  expect(server.bufferedBytes).toBe(5 * 1024 * 1024)
  expect(() =>
    server.expect({
      launch: 'L2',
      generation: 1,
      specHash: 'h',
      handlers: { onStdoutRecord: () => undefined },
      retainedBytes: 1024,
    }),
  ).toThrow('memory-budget')
  sup.socket.destroy()
  const outcome = await reg.session.outcome
  expect(outcome.eligible).toBe(false)
  expect(outcome.reasons).toContain('memory-budget')
  expect(server.bufferedBytes).toBe(0)
})

// audit4 S4-005: a rejected hello must not let a half-open peer keep its unauthenticated slot.
function halfOpenClient(path: string) {
  const socket = net.connect({ path, allowHalfOpen: true })
  clients.push(socket)
  const state = { data: '', ended: false }
  socket.setEncoding('utf8')
  socket.on('data', (d: string) => (state.data += d))
  socket.on('end', () => (state.ended = true)) // server's FIN; this peer deliberately never ends its side
  socket.on('error', () => undefined)
  return { socket, state }
}

test('rejected hellos (unknown, malformed, mismatched, replayed) free their slots even for half-open peers', async () => {
  const { server } = await setup({ maxUnauthenticated: 1, helloTimeoutMs: 30_000 })
  const priv = server as unknown as { unauthenticated: number; sockets: Set<net.Socket> }
  const reg = register(server, 'LX')
  const good = (launch: string, token: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      v: 1,
      t: 'hello',
      launch,
      generation: 1,
      token,
      specHash: 'h',
      ...extra,
    }) + '\n'
  const bad: [string, string][] = [
    [good('NOPE', reg.token), 'unknown-launch'],
    ['{not json\n', 'bad-hello'],
    [good('LX', 'wrong-token'), 'mismatch'],
  ]
  for (const [line, reason] of bad) {
    const c = halfOpenClient(server.path)
    c.socket.write(line)
    await vi.waitFor(() => expect(c.state.data).toContain(reason), { timeout: 3000 })
    // the slot is released within a bounded time, without the peer ever closing its side
    await vi.waitFor(() => expect(priv.unauthenticated).toBe(0), { timeout: 3000 })
    expect(priv.sockets.size).toBe(0)
    expect(c.state.ended).toBe(true)
  }
  // a valid supervisor connects (replay protection: the second use of its token is then rejected)
  const sup = new FakeSupervisor(server.path)
  sup.hello('LX', reg.token)
  await vi.waitFor(() => expect(sup.has('welcome')).toBe(true))
  const replay = halfOpenClient(server.path)
  replay.socket.write(good('LX', reg.token))
  await vi.waitFor(() => expect(replay.state.data).toContain('already-connected'), {
    timeout: 3000,
  })
  await vi.waitFor(() => expect(priv.sockets.size).toBe(1), { timeout: 3000 })
  expect(priv.unauthenticated).toBe(0)
})

test('(control) a partial first line is dropped at the hello deadline', async () => {
  const { server } = await setup({ helloTimeoutMs: 150, maxUnauthenticated: 1 })
  const priv = server as unknown as { unauthenticated: number }
  const c = halfOpenClient(server.path)
  c.socket.write('{"v":1,"t":"hello"') // no newline: partial frame, then silence
  await vi.waitFor(() => expect(priv.unauthenticated).toBe(0), { timeout: 3000 })
  await vi.waitFor(() => expect(c.state.ended || c.socket.destroyed).toBe(true), { timeout: 3000 })
})

// audit5 S5-C01: socket loss while a record is still being ingested resolves the outcome and releases the launch's
// reservation; the ingestion that finishes afterwards must not charge the budget again (nobody would ever release it).
test('a record that finishes ingesting after socket loss does not recharge the released reservation', async () => {
  const { server } = await setup()
  let unblock!: () => void
  const gate = new Promise<void>((resolve) => (unblock = resolve))
  let started!: () => void
  const startedSeen = new Promise<void>((resolve) => (started = resolve))
  let retained = 0
  const reg = server.expect({
    launch: 'L1',
    generation: 1,
    specHash: 'h',
    retainedBytes: 100,
    handlers: {
      onStdoutRecord: async () => {
        started()
        await gate
        retained = 5000 // what the parser holds once the record is applied
      },
      retainedBytes: () => retained,
    },
  })
  const sup = new FakeSupervisor(server.path)
  sup.hello('L1', reg.token)
  await vi.waitFor(() => expect(sup.has('welcome')).toBe(true))
  expect(server.bufferedBytes).toBe(100)
  sup.out('stdout', 1, 'one\n')
  await startedSeen
  sup.socket.destroy()
  const outcome = await reg.session.outcome
  expect(outcome.reasons).toContain('ingestion-incomplete')
  // The launch reservation is released with the outcome; only the record still in flight stays charged.
  await vi.waitFor(() => expect(server.bufferedBytes).toBeLessThan(100))
  unblock()
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(server.bufferedBytes).toBe(0)
})
