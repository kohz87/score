import { mkdtempSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, vi } from 'vitest'
import {
  CodingSocketServer,
  type RunSession,
  type SessionOutcome,
} from '../../src/runtimes/coding/coding-socket.ts'

export const servers: CodingSocketServer[] = []
const clients: net.Socket[] = []

export function setupSocketTestLifecycle() {
  afterEach(async () => {
    for (const c of clients.splice(0)) c.destroy()
    for (const s of servers.splice(0)) await s.shutdown()
  })
}

export const INSTALL = '0123456789abcdef'

export async function setup(
  limits: Partial<ConstructorParameters<typeof CodingSocketServer>[0]['limits']> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'score-sock-'))
  const server = new CodingSocketServer({ runtimeDir: dir, installationId: INSTALL, limits })
  await server.start(true)
  servers.push(server)
  return { dir, server }
}

export class FakeSupervisor {
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

export function register(server: CodingSocketServer, launch = 'L1', records: string[] = []) {
  const reg = server.expect({
    launch,
    generation: 1,
    specHash: 'h',
    handlers: { onStdoutRecord: (l) => void records.push(l) },
  })
  return { ...reg, records }
}

export async function connect(server: CodingSocketServer, launch = 'L1') {
  const reg = register(server, launch)
  const sup = new FakeSupervisor(server.path)
  sup.hello(launch, reg.token)
  await vi.waitFor(() => expect(sup.has('welcome')).toBe(true))
  return { ...reg, sup }
}

export async function finishCleanly(
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

// audit4 S4-005: a rejected hello must not let a half-open peer keep its unauthenticated slot.
export function halfOpenClient(path: string) {
  const socket = net.connect({ path, allowHalfOpen: true })
  clients.push(socket)
  const state = { data: '', ended: false }
  socket.setEncoding('utf8')
  socket.on('data', (d: string) => (state.data += d))
  socket.on('end', () => (state.ended = true)) // server's FIN; this peer deliberately never ends its side
  socket.on('error', () => undefined)
  return { socket, state }
}
