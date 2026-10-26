import { lstat, readFile } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { z } from 'zod'

// Bot Screen (3.3.0, decision 135, docs/briefs/3.3.0-bot-screen.md): a read-only view of a profile's Hermes Bot
// Desktop. Hermes runs Xvnc on `<profile home>/bot-desktop/rfb.sock` (0600, no TCP); this is a minimal RFB 3.8 client
// that only ever sends SetPixelFormat, SetEncodings and FramebufferUpdateRequest — never input — and serves PNG
// snapshots. Hermes' input filter sits on its dashboard bridge, not here, so this module is the filter.

export const MAX_SIDE = 4096
const IDLE_CLOSE_MS = 15_000
const REQUEST_GAP_MS = 500

export type BotScreenState = 'running' | 'off' | 'sandboxed' | 'human' | 'unavailable'
export interface BotScreenStatus {
  state: BotScreenState
  width?: number
  height?: number
  frameSeq?: number
  reason?: string
}
export interface BotScreenFrame {
  seq: number
  png: Buffer
}

// ---- The only bytes the client writes ----
export const CLIENT_VERSION = Buffer.from('RFB 003.008\n', 'latin1')
export const SECURITY_NONE = Buffer.from([1])
export const CLIENT_INIT_SHARED = Buffer.from([1])
/** 32 bpp, little-endian, true colour, shifts 0/8/16: pixels land in memory as R, G, B, X. */
export function setPixelFormat(): Buffer {
  const b = Buffer.alloc(20)
  b[0] = 0
  b[4] = 32 // bits per pixel
  b[5] = 24 // depth
  b[6] = 0 // big-endian flag
  b[7] = 1 // true colour
  b.writeUInt16BE(255, 8)
  b.writeUInt16BE(255, 10)
  b.writeUInt16BE(255, 12)
  b[14] = 0
  b[15] = 8
  b[16] = 16
  return b
}
/** Raw (0) and the DesktopSize pseudo-encoding (−223) only: everything else stays unadvertised. */
export function setEncodings(): Buffer {
  const encodings = [0, -223]
  const b = Buffer.alloc(4 + 4 * encodings.length)
  b[0] = 2
  b.writeUInt16BE(encodings.length, 2)
  encodings.forEach((encoding, i) => b.writeInt32BE(encoding, 4 + 4 * i))
  return b
}
export function framebufferUpdateRequest(
  incremental: boolean,
  width: number,
  height: number,
): Buffer {
  const b = Buffer.alloc(10)
  b[0] = 3
  b[1] = incremental ? 1 : 0
  b.writeUInt16BE(width, 6)
  b.writeUInt16BE(height, 8)
  return b
}

/** Buffered reader over the socket's chunks; `take` returns null until n bytes are there. */
class ByteQueue {
  private chunks: Buffer[] = []
  private length = 0
  push(chunk: Buffer) {
    this.chunks.push(chunk)
    this.length += chunk.length
  }
  get available() {
    return this.length
  }
  take(n: number): Buffer | null {
    if (this.length < n) return null
    const out = Buffer.alloc(n)
    let filled = 0
    while (filled < n) {
      const head = this.chunks[0]!
      const used = Math.min(head.length, n - filled)
      head.copy(out, filled, 0, used)
      filled += used
      if (used === head.length) this.chunks.shift()
      else this.chunks[0] = head.subarray(used)
    }
    this.length -= n
    return out
  }
  peek(n: number): Buffer | null {
    if (this.length < n) return null
    const out = this.take(n)!
    this.chunks.unshift(out)
    this.length += n
    return out
  }
}

class ProtocolError extends Error {}

type Phase =
  | { kind: 'version' }
  | { kind: 'security' }
  | { kind: 'securityResult' }
  | { kind: 'serverInit' }
  | { kind: 'message' }
  | { kind: 'rects'; remaining: number }
  | { kind: 'raw'; x: number; y: number; w: number; h: number; row: number; remaining: number }
  | { kind: 'skip'; bytes: number; remaining: number }

/**
 * One RFB session over a duplex (the Unix socket in production, a pair of streams in tests). It keeps the current
 * framebuffer (RGBX) and a sequence number bumped after each complete FramebufferUpdate.
 */
export class RfbSession {
  width = 0
  height = 0
  seq = 0
  closed = false
  error: string | null = null
  private fb = new Uint8Array(0)
  private queue = new ByteQueue()
  private phase: Phase = { kind: 'version' }
  private outstanding = false
  private wanted = 0
  private timer: NodeJS.Timeout | null = null
  private readyWaiters: Array<(ok: boolean) => void> = []
  constructor(
    private readonly socket: Pick<Socket, 'write' | 'destroy' | 'on'>,
    private readonly clock: () => number = Date.now,
  ) {
    socket.on('data', (chunk: Buffer) => this.receive(chunk))
    socket.on('error', (error: Error) => this.close(error.message))
    socket.on('close', () => this.close('The screen closed the connection.'))
  }
  /** Resolves true once the first full frame arrived, false if the session failed first. */
  ready(): Promise<boolean> {
    if (this.seq > 0) return Promise.resolve(true)
    if (this.closed) return Promise.resolve(false)
    return new Promise((resolve) => this.readyWaiters.push(resolve))
  }
  /** A viewer asked: keep incremental updates coming for a little while. */
  demand() {
    this.wanted = this.clock()
    this.request(true)
  }
  pixels(): Uint8Array {
    return this.fb
  }
  close(reason: string | null = null) {
    if (this.closed) return
    this.closed = true
    this.error ??= reason
    if (this.timer) clearTimeout(this.timer)
    this.fb = new Uint8Array(0)
    this.socket.destroy()
    for (const resolve of this.readyWaiters.splice(0)) resolve(false)
  }
  private write(bytes: Buffer) {
    if (!this.closed) this.socket.write(bytes)
  }
  private request(incremental: boolean) {
    if (this.outstanding || this.closed || this.phase.kind === 'version' || !this.width) return
    this.outstanding = true
    this.write(framebufferUpdateRequest(incremental, this.width, this.height))
  }
  private receive(chunk: Buffer) {
    if (this.closed) return
    this.queue.push(chunk)
    // A raw full frame at the size cap is 64 MiB; more than that unparsed means the screen is misbehaving.
    if (this.queue.available > MAX_SIDE * MAX_SIDE * 4 + (1 << 20)) {
      this.close('The screen sent more than Score can hold.')
      return
    }
    try {
      while (!this.closed && this.step()) {
        /* keep parsing */
      }
    } catch (error) {
      this.close(
        error instanceof Error ? error.message : 'The screen sent something Score can’t read.',
      )
    }
  }
  private resize(width: number, height: number) {
    if (width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE)
      throw new ProtocolError('The screen size is out of range.')
    this.width = width
    this.height = height
    this.fb = new Uint8Array(width * height * 4)
  }
  /** Consumes one unit of input; false when more bytes are needed. */
  private step(): boolean {
    const phase = this.phase
    switch (phase.kind) {
      case 'version': {
        const version = this.queue.take(12)
        if (!version) return false
        if (!/^RFB 003\.00[78]\n$/.test(version.toString('latin1')))
          throw new ProtocolError('The screen speaks an RFB version Score doesn’t support.')
        this.write(CLIENT_VERSION)
        this.phase = { kind: 'security' }
        return true
      }
      case 'security': {
        const head = this.queue.peek(1)
        if (!head) return false
        const count = head[0]!
        const all = this.queue.take(1 + count)
        if (!all) return false
        if (count === 0) throw new ProtocolError('The screen refused the connection.')
        if (!all.subarray(1).includes(1))
          throw new ProtocolError('The screen asks for a sign-in Score doesn’t have.')
        this.write(SECURITY_NONE)
        this.phase = { kind: 'securityResult' }
        return true
      }
      case 'securityResult': {
        const result = this.queue.take(4)
        if (!result) return false
        if (result.readUInt32BE(0) !== 0)
          throw new ProtocolError('The screen refused the connection.')
        this.write(CLIENT_INIT_SHARED)
        this.phase = { kind: 'serverInit' }
        return true
      }
      case 'serverInit': {
        const head = this.queue.peek(24)
        if (!head) return false
        const nameLength = head.readUInt32BE(20)
        if (nameLength > 4096) throw new ProtocolError('The screen sent an oversized name.')
        const init = this.queue.take(24 + nameLength)
        if (!init) return false
        this.resize(init.readUInt16BE(0), init.readUInt16BE(2))
        this.write(setPixelFormat())
        this.write(setEncodings())
        this.phase = { kind: 'message' }
        this.request(false)
        return true
      }
      case 'message': {
        const type = this.queue.peek(1)
        if (!type) return false
        switch (type[0]) {
          case 0: {
            const head = this.queue.take(4)
            if (!head) return false
            this.phase = { kind: 'rects', remaining: head.readUInt16BE(2) }
            return true
          }
          case 1: {
            const head = this.queue.peek(6)
            if (!head) return false
            this.queue.take(6)
            this.phase = { kind: 'skip', bytes: head.readUInt16BE(4) * 6, remaining: 0 }
            return true
          }
          case 2:
            this.queue.take(1)
            return true
          case 3: {
            const head = this.queue.peek(8)
            if (!head) return false
            const length = head.readUInt32BE(4)
            if (length > 1 << 20) throw new ProtocolError('The screen sent an oversized clipboard.')
            this.queue.take(8)
            this.phase = { kind: 'skip', bytes: length, remaining: 0 }
            return true
          }
          default:
            throw new ProtocolError('The screen sent a message Score doesn’t understand.')
        }
      }
      case 'skip': {
        const left = phase.bytes
        if (left === 0) {
          this.phase = { kind: 'message' }
          return true
        }
        const n = Math.min(left, this.queue.available)
        if (n === 0) return false
        this.queue.take(n)
        this.phase = { ...phase, bytes: left - n }
        return true
      }
      case 'rects': {
        if (phase.remaining === 0) {
          this.finishUpdate()
          return true
        }
        const head = this.queue.take(12)
        if (!head) return false
        const x = head.readUInt16BE(0)
        const y = head.readUInt16BE(2)
        const w = head.readUInt16BE(4)
        const h = head.readUInt16BE(6)
        const encoding = head.readInt32BE(8)
        const remaining = phase.remaining - 1
        if (encoding === -223) {
          this.resize(w, h)
          this.phase = { kind: 'rects', remaining }
          return true
        }
        if (encoding !== 0)
          throw new ProtocolError('The screen used an encoding Score didn’t ask for.')
        if (x + w > this.width || y + h > this.height)
          throw new ProtocolError('The screen sent a rectangle outside its own size.')
        this.phase =
          w === 0 || h === 0
            ? { kind: 'rects', remaining }
            : { kind: 'raw', x, y, w, h, row: 0, remaining }
        return true
      }
      case 'raw': {
        const line = this.queue.take(phase.w * 4)
        if (!line) return false
        this.fb.set(line, ((phase.y + phase.row) * this.width + phase.x) * 4)
        const row = phase.row + 1
        this.phase =
          row === phase.h ? { kind: 'rects', remaining: phase.remaining } : { ...phase, row }
        return true
      }
    }
  }
  private finishUpdate() {
    this.phase = { kind: 'message' }
    this.outstanding = false
    this.seq += 1
    for (const resolve of this.readyWaiters.splice(0)) resolve(true)
    // Keep pulling small incremental updates only while someone is looking.
    if (this.clock() - this.wanted < 3000 && !this.timer)
      this.timer = setTimeout(() => {
        this.timer = null
        this.request(true)
      }, REQUEST_GAP_MS)
  }
}

/** RGBX framebuffer → PNG (RGB, filter 0, zlib level 3). */
export function encodePng(width: number, height: number, rgbx: Uint8Array): Buffer {
  const stride = width * 3 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const row = y * stride
    let src = y * width * 4
    for (let x = 0; x < width; x++, src += 4) {
      const dst = row + 1 + x * 3
      raw[dst] = rgbx[src]!
      raw[dst + 1] = rgbx[src + 1]!
      raw[dst + 2] = rgbx[src + 2]!
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'latin1')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0)
    return Buffer.concat([head, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 3 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const LeaseSchema = z.object({ holder: z.enum(['agent', 'human']) }).loose()

/** Hermes' rule (lease.py `_read`): no file = the agent holds; unreadable or corrupt = a human holds. */
export async function leaseHolder(botDir: string): Promise<'agent' | 'human'> {
  let raw: string
  try {
    raw = await readFile(join(botDir, 'lease.json'), 'utf8')
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'agent' : 'human'
  }
  try {
    const parsed = LeaseSchema.safeParse(JSON.parse(raw.replace(/^\uFEFF/u, '')))
    return parsed.success ? parsed.data.holder : 'human'
  } catch {
    return 'human'
  }
}

async function sandboxed(botDir: string): Promise<boolean> {
  try {
    const marker: unknown = JSON.parse(await readFile(join(botDir, 'sandbox.json'), 'utf8'))
    return typeof marker === 'object' && marker !== null && Object.keys(marker).length > 0
  } catch {
    return false
  }
}

export interface BotScreenOptions {
  /** The profile's Hermes home, or null when Score doesn't know the profile. */
  profileHome: (agentId: string) => string | null
  /** Score's own UID: the socket must belong to it. */
  uid?: number
  connect?: (path: string) => Socket
  clock?: () => number
}

/**
 * One shared session per profile, opened on demand and closed after 15 s without a viewer. The lease is read before
 * every status and frame; while a human holds the screen nothing is served and the framebuffer is dropped.
 */
export class BotScreens {
  private sessions = new Map<
    string,
    { session: RfbSession; lastUsed: number; png: BotScreenFrame | null }
  >()
  private sweeper: NodeJS.Timeout | null = null
  constructor(private readonly options: BotScreenOptions) {}

  async status(agentId: string): Promise<BotScreenStatus> {
    const home = this.options.profileHome(agentId)
    if (!home) return { state: 'unavailable', reason: 'Score doesn’t know this agent’s profile.' }
    const botDir = join(home, 'bot-desktop')
    if (await sandboxed(botDir)) {
      this.drop(agentId)
      return { state: 'sandboxed' }
    }
    const socketPath = join(botDir, 'rfb.sock')
    const dirInfo = await lstat(botDir).catch(() => null)
    const info = dirInfo ? await lstat(socketPath).catch(() => null) : null
    if (!dirInfo || !info) {
      this.drop(agentId)
      return { state: 'off' }
    }
    const uid = this.options.uid ?? process.getuid?.()
    const ours = (stats: { uid: number }) => uid === undefined || stats.uid === uid
    if (
      !dirInfo.isDirectory() ||
      !ours(dirInfo) ||
      !info.isSocket() ||
      info.isSymbolicLink() ||
      !ours(info)
    ) {
      this.drop(agentId)
      return { state: 'unavailable', reason: 'The screen’s socket isn’t one Score can trust.' }
    }
    if ((await leaseHolder(botDir)) === 'human') {
      this.drop(agentId)
      return { state: 'human' }
    }
    const entry = await this.open(agentId, socketPath)
    if (!entry) return { state: 'off' }
    entry.lastUsed = this.now()
    entry.session.demand()
    return {
      state: 'running',
      width: entry.session.width,
      height: entry.session.height,
      frameSeq: entry.session.seq,
    }
  }

  /** The current frame as PNG, or the status explaining why there is none. */
  async frame(agentId: string): Promise<BotScreenFrame | BotScreenStatus> {
    const status = await this.status(agentId)
    if (status.state !== 'running') return status
    const entry = this.sessions.get(agentId)!
    const { session } = entry
    if (entry.png?.seq !== session.seq)
      entry.png = {
        seq: session.seq,
        png: encodePng(session.width, session.height, session.pixels()),
      }
    return entry.png
  }

  close() {
    for (const id of [...this.sessions.keys()]) this.drop(id)
    if (this.sweeper) clearInterval(this.sweeper)
    this.sweeper = null
  }

  private now() {
    return (this.options.clock ?? Date.now)()
  }
  private drop(agentId: string) {
    const entry = this.sessions.get(agentId)
    if (!entry) return
    entry.session.close()
    this.sessions.delete(agentId)
  }
  private async open(agentId: string, socketPath: string) {
    let entry = this.sessions.get(agentId)
    if (entry?.session.closed) {
      this.sessions.delete(agentId)
      entry = undefined
    }
    if (!entry) {
      const socket = (this.options.connect ?? ((path) => connect(path)))(socketPath)
      entry = {
        session: new RfbSession(socket, this.options.clock),
        lastUsed: this.now(),
        png: null,
      }
      this.sessions.set(agentId, entry)
      this.sweep()
    }
    // Every caller (not only the one that connected) waits for the first full frame: a session still connecting has
    // no size and no pixels yet.
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), 5000)
    })
    const ready = await Promise.race([entry.session.ready(), timeout])
    clearTimeout(timer)
    if (!ready || entry.session.seq === 0) {
      if (this.sessions.get(agentId) === entry) this.drop(agentId)
      return null
    }
    return entry
  }
  private sweep() {
    if (this.sweeper) return
    this.sweeper = setInterval(() => {
      for (const [id, entry] of this.sessions)
        if (entry.session.closed || this.now() - entry.lastUsed > IDLE_CLOSE_MS) this.drop(id)
      if (this.sessions.size === 0 && this.sweeper) {
        clearInterval(this.sweeper)
        this.sweeper = null
      }
    }, 5000)
    this.sweeper.unref()
  }
}
