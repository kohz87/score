import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { afterEach, expect, test, vi } from 'vitest'
import { terminalLaunch } from '../src/terminal/env.ts'
import {
  TerminalManager,
  type PtyProcess,
  type SpawnPty,
  type TerminalSocket,
} from '../src/terminal/manager.ts'

const launch = terminalLaunch(
  { HOME: '/tmp' },
  { username: 'u', homedir: '/tmp', shell: '/bin/sh' },
)
const lines: { fields: Record<string, unknown>; message: string }[] = []
const audit = {
  info: (fields: Record<string, unknown>, message: string) => lines.push({ fields, message }),
}
const stop: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.useRealTimers()
  lines.length = 0
  for (const close of stop.splice(0)) await close()
})

class FakeSocket extends EventEmitter {
  bufferedAmount = 0
  readyState = 1
  sent: (Buffer | string)[] = []
  terminated = false
  send(data: Buffer | string) {
    this.sent.push(data)
  }
  close() {
    this.readyState = 3
    this.emit('close')
  }
  terminate() {
    this.terminated = true
    this.readyState = 3
    this.emit('close')
  }
}

class FakePty implements PtyProcess {
  paused = 0
  resumed = 0
  written: Buffer[] = []
  resizes: [number, number][] = []
  #data: ((data: Buffer) => void)[] = []
  #exit: ((event: { exitCode: number }) => void)[] = []
  constructor(readonly pid: number) {}
  onData(listener: (data: Buffer) => void) {
    this.#data.push(listener)
  }
  onExit(listener: (event: { exitCode: number }) => void) {
    this.#exit.push(listener)
  }
  write(data: Buffer) {
    this.written.push(data)
  }
  resize(cols: number, rows: number) {
    this.resizes.push([cols, rows])
  }
  pause() {
    this.paused++
  }
  resume() {
    this.resumed++
  }
  emitData(data: Buffer) {
    for (const listener of this.#data) listener(data)
  }
  emitExit(exitCode = 0) {
    for (const listener of this.#exit) listener({ exitCode })
  }
}

function setup(limits = {}, spawnPty?: SpawnPty, stillPaired?: (session: string) => boolean) {
  let now = 1_000_000
  const ptys: FakePty[] = []
  const manager = new TerminalManager(
    spawnPty ??
      (() => {
        // Pid 0 would signal our own group: a number no real process can have keeps `process.kill` harmless.
        const pty = new FakePty(2 ** 22 + 1)
        ptys.push(pty)
        return pty
      }),
    audit,
    launch,
    () => now,
    { tickMs: 100, ...limits },
    stillPaired,
  )
  stop.push(async () => {
    const closing = manager.closeAll()
    // A stand-in PTY has no process to hang up: let it "exit" so the terminal can finish.
    for (const pty of ptys) pty.emitExit()
    await closing
  })
  return { manager, ptys, advance: (ms: number) => (now += ms) }
}

const frames = (socket: FakeSocket) =>
  socket.sent
    .filter((item): item is string => typeof item === 'string')
    .map((item) => JSON.parse(item))

test('input, resize and a bad frame', () => {
  const { manager, ptys } = setup()
  const socket = new FakeSocket()
  manager.open(socket as unknown as TerminalSocket, 's1', 'addr')
  socket.emit('message', Buffer.from('ls\r'), true)
  socket.emit(
    'message',
    Buffer.from(JSON.stringify({ type: 'resize', cols: 100, rows: 30 })),
    false,
  )
  socket.emit('message', Buffer.from('{"type":"resize","cols":0,"rows":-5}'), false)
  socket.emit('message', Buffer.from('not json'), false)
  socket.emit('message', Buffer.alloc(70_000), true)
  expect(ptys[0]!.written.map(String)).toEqual(['ls\r'])
  expect(ptys[0]!.resizes).toEqual([[100, 30]])
})

test('the second terminal is the last; a third is refused with a frame', () => {
  const { manager } = setup()
  const open = () => {
    const socket = new FakeSocket()
    return { socket, id: manager.open(socket as unknown as TerminalSocket, 's', 'a') }
  }
  expect(open().id).toBeTruthy()
  expect(open().id).toBeTruthy()
  const third = open()
  expect(third.id).toBeUndefined()
  expect(frames(third.socket)).toEqual([{ type: 'exit', reason: 'limit', code: null }])
  expect(manager.count).toBe(2)
})

test('idle for 15 minutes and 8 hours absolute end a terminal; activity defers idle', () => {
  vi.useFakeTimers()
  const { manager, ptys, advance } = setup({ killGraceMs: 10 })
  const socket = new FakeSocket()
  manager.open(socket as unknown as TerminalSocket, 's', 'a')
  advance(14 * 60_000)
  socket.emit('message', Buffer.from('x'), true)
  advance(14 * 60_000)
  vi.advanceTimersByTime(200)
  expect(manager.count).toBe(1)
  advance(2 * 60_000)
  vi.advanceTimersByTime(200)
  expect(frames(socket).at(-1)).toMatchObject({ type: 'exit', reason: 'idle' })
  ptys[0]!.emitExit()
  expect(manager.count).toBe(0)

  const second = new FakeSocket()
  manager.open(second as unknown as TerminalSocket, 's', 'a')
  // Output keeps it from going idle, but never past the absolute limit.
  for (let i = 0; i < 40; i++) {
    advance(14 * 60_000)
    ptys[1]!.emitData(Buffer.from('tick'))
    vi.advanceTimersByTime(200)
  }
  expect(frames(second).at(-1)).toMatchObject({ type: 'exit', reason: 'limit' })
})

test('output backpressure: pause above 1 MiB, resume once drained, drop after 60 s', () => {
  vi.useFakeTimers()
  const { manager, ptys, advance } = setup()
  const socket = new FakeSocket()
  manager.open(socket as unknown as TerminalSocket, 's', 'a')
  const pty = ptys[0]!
  socket.bufferedAmount = 512 * 1024
  pty.emitData(Buffer.from('a'))
  expect(pty.paused).toBe(0)
  socket.bufferedAmount = 1024 * 1024 + 1
  pty.emitData(Buffer.from('b'))
  pty.emitData(Buffer.from('c'))
  expect(pty.paused).toBe(1)
  // Still full after 30 s: kept paused.
  advance(30_000)
  vi.advanceTimersByTime(200)
  expect(pty.resumed).toBe(0)
  // Drains: resumes.
  socket.bufferedAmount = 0
  vi.advanceTimersByTime(200)
  expect(pty.resumed).toBe(1)
  // Stalls for 60 s: dropped.
  socket.bufferedAmount = 2 * 1024 * 1024
  pty.emitData(Buffer.from('d'))
  advance(61_000)
  vi.advanceTimersByTime(200)
  expect(socket.terminated).toBe(true)
  pty.emitExit()
  expect(lines.some((line) => line.fields.reason === 'stalled')).toBe(true)
})

test('a session that stops being paired ends its terminals', () => {
  vi.useFakeTimers()
  let paired = true
  const { manager, ptys } = setup({}, undefined, () => paired)
  const socket = new FakeSocket()
  manager.open(socket as unknown as TerminalSocket, 's', 'a')
  const other = new FakeSocket()
  manager.open(other as unknown as TerminalSocket, 'other', 'a')
  manager.closeSession('s')
  expect(frames(socket).at(-1)).toMatchObject({ reason: 'revoked' })
  expect(frames(other)).toHaveLength(1)
  paired = false
  vi.advanceTimersByTime(200)
  expect(frames(other).at(-1)).toMatchObject({ reason: 'revoked' })
  for (const pty of ptys) pty.emitExit()
})

test('SIGHUP first, SIGKILL for the whole group after the grace period', async () => {
  // A shell that ignores SIGHUP, in its own process group (as node-pty gives every shell).
  const child = spawn('bash', ['-c', 'trap "" HUP; while :; do sleep 1; done'], {
    detached: true,
    stdio: 'ignore',
  })
  const exited = new Promise<string | null>((resolve) =>
    child.once('exit', (_code, signal) => resolve(signal)),
  )
  stop.push(async () => {
    try {
      process.kill(-child.pid!, 'SIGKILL')
    } catch {
      // already gone
    }
  })
  const real: SpawnPty = () => ({
    pid: child.pid!,
    onData: () => undefined,
    onExit: (listener) => void child.once('exit', (code) => listener({ exitCode: code ?? 137 })),
    write: () => undefined,
    resize: () => undefined,
    pause: () => undefined,
    resume: () => undefined,
  })
  const { manager } = setup({ killGraceMs: 400 }, real)
  const socket = new FakeSocket()
  manager.open(socket as unknown as TerminalSocket, 's', 'a')
  // Let bash install its trap first.
  await new Promise((resolve) => setTimeout(resolve, 300))
  const started = Date.now()
  manager.close(manager.list()[0]!.id, 'closed')
  await new Promise((resolve) => setTimeout(resolve, 150))
  expect(child.exitCode).toBeNull()
  expect(await exited).toBe('SIGKILL')
  expect(Date.now() - started).toBeGreaterThanOrEqual(350)
  expect(manager.count).toBe(0)
})

test('the audit log names open, close and kill but carries no input or output', () => {
  const { manager, ptys } = setup()
  const socket = new FakeSocket()
  manager.open(socket as unknown as TerminalSocket, 'session-hash-1234', '10.0.0.5')
  socket.emit('message', Buffer.from('hunter2-typed'), true)
  ptys[0]!.emitData(Buffer.from('hunter2-printed'))
  ptys[0]!.emitExit(0)
  const second = new FakeSocket()
  manager.open(second as unknown as TerminalSocket, 'session-hash-1234', '10.0.0.5')
  manager.close(manager.list()[0]!.id, 'idle')
  ptys[1]!.emitExit(1)
  const text = JSON.stringify(lines)
  expect(text).not.toContain('hunter2')
  expect(lines.map((line) => line.fields.event)).toEqual([
    'terminal.open',
    'terminal.close',
    'terminal.open',
    'terminal.kill',
  ])
})
