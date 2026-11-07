import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, statSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { CodingSocketServer, SocketStartError } from '../../src/runtimes/coding/coding-socket.ts'
import {
  connect,
  FakeSupervisor,
  INSTALL,
  servers,
  setup,
  setupSocketTestLifecycle,
} from './coding-socket-helpers.ts'

setupSocketTestLifecycle()

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
