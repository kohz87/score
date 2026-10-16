import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import net from 'node:net'
import { dirname, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { z } from 'zod'

// The Score side of the supervisor wire protocol (7.7a design v7 section 4). The supervisor side is supervisor.mjs.

export const PROTOCOL_VERSION = 1
export const MAX_FRAME_BYTES = 64 * 1024
export const MAX_CHUNK_BYTES = 32 * 1024
/** sun_path is 108 bytes including the terminating NUL; keep a margin. */
export const MAX_SOCKET_PATH_BYTES = 100

const Stream = z.enum(['stdout', 'stderr'])
const SupervisorFrame = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    v: z.literal(PROTOCOL_VERSION),
    launch: z.string().min(1).max(128),
    generation: z.number().int().nonnegative(),
    token: z.string().min(1).max(256),
    specHash: z.string().min(1).max(128),
  }),
  z.object({
    t: z.literal('ready'),
    pid: z.number().int().positive(),
    start: z.string().regex(/^\d+$/),
    cgroup: z.string().min(1).max(1024),
  }),
  z.object({
    t: z.literal('out'),
    stream: Stream,
    seq: z.number().int().positive(),
    data: z.string().max(Math.ceil((MAX_CHUNK_BYTES * 4) / 3) + 4),
  }),
  z.object({
    t: z.literal('eof'),
    stream: Stream,
    lastSeq: z.number().int().nonnegative(),
    /** The supervisor closed its end of the pipe itself: unread output may be lost, so this is not a clean EOF. */
    forced: z.boolean().optional(),
  }),
  z.object({
    t: z.literal('exit'),
    code: z.number().int().nullable(),
    signal: z.string().max(32).nullable(),
  }),
  z.object({
    t: z.literal('end'),
    survivorsKilled: z.boolean().optional(),
    stopCause: z.string().max(64).nullable().optional(),
  }),
  z.object({ t: z.literal('error'), code: z.string().max(64) }),
])
type SupervisorFrame = z.infer<typeof SupervisorFrame>

export interface ReadyInfo {
  pid: number
  start: string
  cgroup: string
}

export interface SessionOutcome {
  kind: 'ended' | 'lost'
  /** True only when the completeness rule holds (design section 4 "Completeness"): the result may be eligible. */
  eligible: boolean
  reasons: string[]
  exit: { code: number | null; signal: string | null } | null
  stopCause: string | null
  survivorsKilled: boolean
  /** Records dropped for size or because the last stdout line was partial at eof. */
  droppedRecords: number
  /** The `ack-end` frame reached the kernel's socket buffer (not merely queued): only then can the close be a normal one. */
  ackFlushed: boolean
}

export interface RunHandlers {
  /** One complete stdout record (a decoded line). Processed strictly in order; a throw/reject makes the run ineligible. */
  onStdoutRecord(line: string): void | Promise<void>
  /** Diagnostic stderr text (bounded, never parsed as records). */
  onStderr?(text: string): void
  /**
   * Score's side is about to stop the run on its own account (a broken bound, an ingestion failure, shutdown). Called
   * BEFORE the stop frame goes out so the cause can be made durable first (review 2026-10-12 #17). It must not throw.
   */
  onStop?(cause: string): void
  /** What the run keeps in memory besides queued records right now (the parser's retained values), in bytes. */
  retainedBytes?(): number
}

export interface SocketLimits {
  /** Decoded stdout record limit (the driver's per-line allowance). */
  maxRecordBytes: number
  maxStreamBytes: number
  maxRunBytes: number
  maxStderrKeptBytes: number
  /** Pause reading the socket while this many record bytes wait for the handler; resume at half. */
  pauseBytes: number
  /** Installation-wide cap on buffered, unprocessed record bytes across runs. */
  memoryBudgetBytes: number
  helloTimeoutMs: number
  maxUnauthenticated: number
}

export const DEFAULT_LIMITS: SocketLimits = {
  maxRecordBytes: 1024 * 1024,
  maxStreamBytes: 64 * 1024 * 1024,
  maxRunBytes: 128 * 1024 * 1024,
  maxStderrKeptBytes: 256 * 1024,
  pauseBytes: 1024 * 1024,
  memoryBudgetBytes: 64 * 1024 * 1024,
  helloTimeoutMs: 5000,
  maxUnauthenticated: 16,
}

export class SocketStartError extends Error {
  constructor(
    readonly code:
      'path-too-long' | 'bad-directory' | 'foreign-listener' | 'stale-needs-lock' | 'not-a-socket',
    message: string,
  ) {
    super(message)
  }
}

/** Bookkeeping cost charged per queued record on top of its text (array slot, string header). */
export const QUEUE_ENTRY_OVERHEAD_BYTES = 64

interface Budget {
  used: number
  limit: number
}

/** One launch's connection: Score drives it with go/cancel/stop/ackEnd-by-protocol and reads its outcome. */
export class RunSession {
  /** Resolves when the supervisor reported its identity; rejects when the connection ended before. */
  readonly ready: Promise<ReadyInfo>
  /** Resolves once, when the connection is over (after ack-end, or on loss). Never rejects. */
  readonly outcome: Promise<SessionOutcome>

  private socket: net.Socket | null = null
  private lineBuffer = ''
  private frameBytes = 0
  private resolveReady!: (info: ReadyInfo) => void
  private rejectReady!: (error: Error) => void
  private resolveOutcome!: (outcome: SessionOutcome) => void
  private settled = false
  private readySeen = false

  private readonly lastSeq = { stdout: 0, stderr: 0 }
  private readonly eofSeen = { stdout: false, stderr: false }
  private readonly bytes = { stdout: 0, stderr: 0 }
  private readonly decoders = {
    stdout: new StringDecoder('utf8'),
    stderr: new StringDecoder('utf8'),
  }
  private stdoutPartial = ''
  /** Budget bytes charged for `stdoutPartial` (released and recharged as it changes). */
  private partialCharge = 0
  private skippingOversize = false
  private stderrKept = 0
  private exitInfo: { code: number | null; signal: string | null } | null = null
  private endFrame: Extract<SupervisorFrame, { t: 'end' }> | null = null
  private ackSent = false
  private ackFlushed = false
  private violations: string[] = []
  private dropped = 0
  private ingestFailed = false
  private queue: string[] = []
  private queueBytes = 0
  private pumping = false
  private readPaused = false
  private lastStopCause: string | null = null

  /** @internal */
  constructor(
    readonly launch: string,
    readonly generation: number,
    private readonly handlers: RunHandlers,
    private readonly limits: SocketLimits,
    private readonly budget: Budget,
    /** Bytes charged to the budget for what the run retains; grows with the parser's actual retained bytes. */
    private readonly reservation: { bytes: number; floor: number } = { bytes: 0, floor: 0 },
  ) {
    this.ready = new Promise<ReadyInfo>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    this.ready.catch(() => undefined)
    this.outcome = new Promise<SessionOutcome>((resolve) => {
      this.resolveOutcome = resolve
    })
  }

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed
  }

  /** Releases the CLI (after the journal's `releasing` commit, design section 3). */
  go(): void {
    this.send({ t: 'go' })
  }

  /** The launch will not run: only valid before `go`. */
  cancel(): void {
    this.send({ t: 'cancel' })
  }

  /** Starts the supervisor's INT -> TERM -> KILL escalation; the first cause wins on its side. */
  stop(cause: string): void {
    this.lastStopCause ??= cause
    this.send({ t: 'stop', cause })
  }

  /** @internal Attaches the authenticated connection and starts reading its frames. */
  attach(socket: net.Socket, leftover: string): void {
    this.socket = socket
    socket.on('data', (chunk: string) => this.onData(chunk))
    socket.on('close', () => this.onClose())
    socket.on('error', () => undefined)
    this.send({ t: 'welcome' })
    if (leftover) this.onData(leftover)
  }

  /** @internal Shutdown: tell the supervisor to stop, then destroy the socket once the frame is flushed. */
  shutdown(sendStop = true): Promise<void> {
    return new Promise((resolve) => {
      const socket = this.socket
      if (!socket || socket.destroyed) return resolve()
      socket.once('close', () => resolve())
      // Held (re-review 6 #5): the socket is simply dropped; the supervisor's own disconnect containment ends the CLI.
      if (!sendStop) return void socket.destroy()
      const line =
        JSON.stringify({ v: PROTOCOL_VERSION, t: 'stop', cause: 'score-shutdown' }) + '\n'
      this.noteStop('score-shutdown')
      socket.write(line, () => socket.destroy())
      setTimeout(() => socket.destroy(), 1000).unref()
    })
  }

  private send(frame: Record<string, unknown>, flushed?: (ok: boolean) => void): void {
    const socket = this.socket
    if (!socket || socket.destroyed) return flushed?.(false)
    socket.write(
      JSON.stringify({ v: PROTOCOL_VERSION, ...frame }) + '\n',
      flushed ? (error) => flushed(!error) : undefined,
    )
  }

  /** Makes Score's own stop cause durable before the frame is sent; a failing hook never blocks the stop. */
  private noteStop(cause: string): void {
    try {
      this.handlers.onStop?.(cause)
    } catch {
      // the hook reports its own failure; stopping matters more than the note
    }
  }

  private violate(reason: string): void {
    if (!this.violations.includes(reason)) this.violations.push(reason)
    // A bound was broken or the stream is inconsistent: stop the run (once); the result is ineligible.
    if (this.lastStopCause === null) {
      this.noteStop(reason.slice(0, 64))
      this.send({ t: 'stop', cause: reason.slice(0, 64) })
    }
    this.lastStopCause ??= reason
  }

  private onData(chunk: string): void {
    this.lineBuffer += chunk
    for (;;) {
      const nl = this.lineBuffer.indexOf('\n')
      if (nl < 0) break
      const line = this.lineBuffer.slice(0, nl)
      this.lineBuffer = this.lineBuffer.slice(nl + 1)
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) return this.protocolError('frame-too-large')
      this.onLine(line)
    }
    if (Buffer.byteLength(this.lineBuffer) > MAX_FRAME_BYTES) this.protocolError('frame-too-large')
  }

  private protocolError(reason: string): void {
    this.violations.push(reason)
    this.socket?.destroy()
  }

  private onLine(line: string): void {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      return this.protocolError('bad-frame')
    }
    const parsed = SupervisorFrame.safeParse(raw)
    if (!parsed.success) return this.protocolError('bad-frame')
    const f = parsed.data
    // Terminal order (design section 4): nothing follows `end`, and `end` follows both EOFs and the exit.
    if (this.endFrame && f.t !== 'error') return this.protocolError('frame-after-end')
    switch (f.t) {
      case 'hello':
        return this.protocolError('duplicate-hello')
      case 'ready':
        if (this.readySeen) return this.protocolError('duplicate-ready')
        this.readySeen = true
        this.resolveReady({ pid: f.pid, start: f.start, cgroup: f.cgroup })
        return
      case 'out':
        return this.onOut(f.stream, f.seq, f.data)
      case 'eof':
        return this.onEof(f.stream, f.lastSeq, f.forced === true)
      case 'exit':
        if (this.exitInfo) return this.protocolError('duplicate-exit')
        this.exitInfo = { code: f.code, signal: f.signal }
        return
      case 'end':
        return this.onEnd(f)
      case 'error':
        this.violate(`supervisor-error:${f.code}`)
        return
    }
  }

  private onOut(stream: 'stdout' | 'stderr', seq: number, data: string): void {
    if (this.eofSeen[stream]) return this.protocolError('out-after-eof')
    if (seq !== this.lastSeq[stream] + 1) {
      // A gap or a repeat means chunks were lost or duplicated: nothing after it can be trusted.
      return this.violate(`seq-${stream}`)
    }
    this.lastSeq[stream] = seq
    const raw = Buffer.from(data, 'base64')
    if (raw.length > MAX_CHUNK_BYTES) return this.protocolError('chunk-too-large')
    this.bytes[stream] += raw.length
    if (
      this.bytes[stream] > this.limits.maxStreamBytes ||
      this.bytes.stdout + this.bytes.stderr > this.limits.maxRunBytes
    ) {
      return this.violate('run-cap')
    }
    const text = this.decoders[stream].write(raw)
    if (stream === 'stdout') this.takeStdout(text)
    else this.takeStderr(text)
  }

  private takeStdout(text: string): void {
    let rest = this.stdoutPartial + text
    this.stdoutPartial = ''
    this.chargePartial(0)
    for (;;) {
      const nl = rest.indexOf('\n')
      if (nl < 0) break
      const line = rest.slice(0, nl)
      rest = rest.slice(nl + 1)
      if (this.skippingOversize) {
        this.skippingOversize = false
        continue
      }
      this.enqueue(line)
    }
    if (this.skippingOversize) return
    if (Buffer.byteLength(rest) > this.limits.maxRecordBytes) {
      // Over the per-line allowance: a dropped record, skipped up to its newline, and the run is stopped (design 4).
      this.dropped += 1
      this.skippingOversize = true
      return this.violate('record-too-large')
    }
    // The partial line is buffered text like any other: it counts against the installation-wide budget.
    const size = Buffer.byteLength(rest)
    if (this.budget.used + size > this.budget.limit) {
      this.dropped += 1
      this.skippingOversize = true
      return this.violate('memory-budget')
    }
    this.stdoutPartial = rest
    this.chargePartial(size)
  }

  private chargePartial(size: number): void {
    this.budget.used += size - this.partialCharge
    this.partialCharge = size
  }

  private takeStderr(text: string): void {
    if (!text) return
    const room = this.limits.maxStderrKeptBytes - this.stderrKept
    if (room <= 0) return
    const kept =
      Buffer.byteLength(text) <= room ? text : Buffer.from(text).subarray(0, room).toString('utf8')
    this.stderrKept += Buffer.byteLength(kept)
    this.handlers.onStderr?.(kept)
    // Diagnostics are retained text too (FU #8).
    this.chargeRetained()
  }

  private enqueue(line: string): void {
    const text = Buffer.byteLength(line)
    if (text > this.limits.maxRecordBytes) {
      this.dropped += 1
      return this.violate('record-too-large')
    }
    const size = text + QUEUE_ENTRY_OVERHEAD_BYTES
    if (this.budget.used + size > this.budget.limit) {
      this.dropped += 1
      return this.violate('memory-budget')
    }
    this.budget.used += size
    this.queueBytes += size
    this.queue.push(line)
    if (this.queueBytes >= this.limits.pauseBytes && !this.readPaused) {
      // Real backpressure: stop reading, so the supervisor's socket buffer fills and it pauses the CLI's pipes.
      this.readPaused = true
      this.socket?.pause()
    }
    void this.pump()
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.queue.length > 0) {
        const line = this.queue.shift()!
        const size = Buffer.byteLength(line) + QUEUE_ENTRY_OVERHEAD_BYTES
        try {
          await this.handlers.onStdoutRecord(line)
        } catch {
          if (!this.ingestFailed) {
            this.ingestFailed = true
            if (this.lastStopCause === null) this.noteStop('ingest-failure')
            this.lastStopCause ??= 'ingest-failure'
            this.send({ t: 'stop', cause: 'ingest-failure' })
          }
        }
        this.queueBytes -= size
        this.budget.used -= size
        this.chargeRetained()
        if (this.readPaused && this.queueBytes <= this.limits.pauseBytes / 2) {
          this.readPaused = false
          this.socket?.resume()
        }
      }
    } finally {
      this.pumping = false
    }
    void this.maybeComplete()
  }

  private onEof(stream: 'stdout' | 'stderr', lastSeq: number, forced: boolean): void {
    if (this.eofSeen[stream]) return this.protocolError('duplicate-eof')
    this.eofSeen[stream] = true
    // A pipe the supervisor had to close itself is loss, not an end of stream (review 2026-10-12 #1).
    if (forced) {
      this.dropped += 1
      this.violate(`forced-eof-${stream}`)
    }
    if (lastSeq !== this.lastSeq[stream]) this.violate(`eof-seq-${stream}`)
    const tail = this.decoders[stream].end()
    if (stream === 'stdout') {
      const rest = this.stdoutPartial + tail
      this.stdoutPartial = ''
      this.chargePartial(0)
      // A partial last stdout line is a dropped record (lossy); stderr's partial line is just text.
      if (rest.length > 0 && !this.skippingOversize) this.dropped += 1
      this.skippingOversize = false
    } else this.takeStderr(tail)
  }

  private onEnd(f: Extract<SupervisorFrame, { t: 'end' }>): void {
    if (this.endFrame) return this.protocolError('duplicate-end')
    // `end` before both EOFs and the exit is out of order: never acknowledged, and the connection is dropped.
    if (!this.eofSeen.stdout || !this.eofSeen.stderr || !this.exitInfo)
      return this.protocolError('end-before-eof')
    this.endFrame = f
    void this.maybeComplete()
  }

  /** `end` seen: wait until every stdout record is processed, then acknowledge (design section 4, terminal order). */
  private async maybeComplete(): Promise<void> {
    if (!this.endFrame || this.ackSent || this.pumping || this.queue.length > 0) return
    this.ackSent = true
    // Queued is not delivered: only a completed write makes the acknowledgment something the supervisor can have seen.
    this.send({ t: 'ack-end' }, (ok) => {
      this.ackFlushed = ok
    })
  }

  /**
   * Charges what the run really retains (the parser's values, which can far exceed any entry count) instead of a fixed
   * reservation. Past the installation budget the run is stopped and ineligible (review 2026-10-12 #18).
   */
  private chargeRetained(): void {
    const actual = this.handlers.retainedBytes?.()
    if (actual === undefined || !Number.isFinite(actual)) return
    const target = Math.max(this.reservation.floor, Math.ceil(actual))
    const delta = target - this.reservation.bytes
    const over = delta > 0 && this.budget.used + delta > this.budget.limit
    // The parser really holds these bytes whether or not they fit: they stay charged (as debt, past the limit) until the
    // state is cleared, so other runs can't be admitted on top of memory that is already in use (FV #3).
    if (delta !== 0) {
      this.budget.used += delta
      this.reservation.bytes = target
    }
    if (over) {
      this.dropped += 1
      this.violate('memory-budget')
    }
  }

  private reasons(): string[] {
    const reasons = [...this.violations]
    if (!this.eofSeen.stdout || !this.eofSeen.stderr) reasons.push('missing-eof')
    if (!this.exitInfo) reasons.push('missing-exit')
    if (this.dropped > 0) reasons.push('dropped-record')
    if (this.ingestFailed) reasons.push('ingest-failure')
    if (this.endFrame?.stopCause) reasons.push(`stop-cause:${this.endFrame.stopCause}`)
    else if (this.lastStopCause) reasons.push(`stop-cause:${this.lastStopCause}`)
    return reasons
  }

  private onClose(): void {
    if (this.settled) return
    this.settled = true
    if (this.readPaused) this.readPaused = false
    // Close after ack-end is the normal end; any other close is socket loss.
    const ended = this.ackSent && this.endFrame !== null
    if (!this.readySeen) this.rejectReady(new Error('connection closed before ready'))
    const reasons = ended ? this.reasons() : [...this.reasons(), 'socket-loss']
    // Normal only when the acknowledgment was actually written: a lost ack means the supervisor saw a closed socket.
    if (ended && !this.ackFlushed) reasons.push('ack-not-flushed')
    // Closing with records still queued or being ingested means output was acknowledged or counted before it was saved.
    if (this.pumping || this.queue.length > 0) reasons.push('ingestion-incomplete')
    // Records still queued would be lost with the connection: they are not processed, so not complete.
    this.stdoutPartial = ''
    this.chargePartial(0)
    for (const line of this.queue) {
      const size = Buffer.byteLength(line) + QUEUE_ENTRY_OVERHEAD_BYTES
      this.budget.used -= size
      this.queueBytes -= size
    }
    this.queue = []
    this.resolveOutcome({
      kind: ended ? 'ended' : 'lost',
      eligible: ended && reasons.length === 0,
      reasons,
      exit: this.exitInfo,
      stopCause: this.endFrame?.stopCause ?? this.lastStopCause,
      survivorsKilled: this.endFrame?.survivorsKilled ?? false,
      droppedRecords: this.dropped,
      ackFlushed: this.ackFlushed,
    })
  }
}

interface Pending {
  generation: number
  specHash: string
  session: RunSession
  used: boolean
  /** Budget bytes reserved for what the run keeps in memory besides queued records (released once, see `release`). */
  reservation: { bytes: number; floor: number }
}

/** What an active run may keep in memory beyond queued records (retained text, remembered call ids): reserved up front. */
export const RETAINED_RUN_BYTES = 512 * 1024

export interface CodingSocketOptions {
  /** `$XDG_RUNTIME_DIR` (or a test directory). */
  runtimeDir: string
  installationId: string
  limits?: Partial<SocketLimits>
  /** Why Score holds all agent work, or null (decisions 71 and 72). While held, Score sends no Stop frame of its own. */
  frozen?: () => string | null
}

/** Hard stop for a rejected connection whose reply write never completes. */
const REJECT_BACKSTOP_MS = 1000

export class CodingSocketServer {
  readonly path: string
  private readonly limits: SocketLimits
  private readonly budget: Budget
  /** Per Score incarnation: a token from another run of Score never verifies. */
  private readonly secret = randomBytes(32)
  private readonly pending = new Map<string, Pending>()
  private readonly sockets = new Set<net.Socket>()
  private server: net.Server | null = null
  /** Bumped by every shutdown: a bind that was in flight when it happened must not publish its listener. */
  private epoch = 0
  private unauthenticated = 0

  constructor(private readonly options: CodingSocketOptions) {
    this.path = CodingSocketServer.socketPath(options.runtimeDir, options.installationId)
    this.limits = { ...DEFAULT_LIMITS, ...options.limits }
    this.budget = { used: 0, limit: this.limits.memoryBudgetBytes }
  }

  static socketPath(runtimeDir: string, installationId: string): string {
    return join(runtimeDir, 'score', `${installationId.slice(0, 8)}.sock`)
  }

  /** Bytes of unprocessed stdout records buffered across all runs (the installation-wide budget). */
  get bufferedBytes(): number {
    return this.budget.used
  }

  /**
   * Listens on the socket. `holdsInstallationLock` must be true to remove a stale socket file (design section 4); a
   * live listener that is not ours is refused, never replaced.
   */
  async start(holdsInstallationLock: boolean): Promise<void> {
    if (this.listening) return // idempotent: our own listener must not be probed as a "foreign" one
    if (Buffer.byteLength(this.path) > MAX_SOCKET_PATH_BYTES) {
      throw new SocketStartError(
        'path-too-long',
        `socket path is ${Buffer.byteLength(this.path)} bytes long`,
      )
    }
    const dir = dirname(this.path)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const stat = lstatSync(dir)
    if (!stat.isDirectory() || stat.uid !== process.getuid!()) {
      throw new SocketStartError(
        'bad-directory',
        'socket directory is not a directory owned by this user',
      )
    }
    if ((stat.mode & 0o077) !== 0) chmodSync(dir, 0o700)
    const epoch = this.epoch
    await this.clearStale(holdsInstallationLock)
    if (epoch !== this.epoch)
      throw new SocketStartError('closed', 'the socket server was shut down')
    const server = net.createServer((socket) => this.accept(socket))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.path, () => {
        server.off('error', reject)
        resolve()
      })
    })
    try {
      // Shut down while the bind was in flight: the listener we just made is never published (closing it removes it).
      if (epoch !== this.epoch)
        throw new SocketStartError('closed', 'the socket server was shut down')
      chmodSync(this.path, 0o600)
    } catch (error) {
      // Never leave a half-set-up listener behind: the next attempt must start from nothing.
      await new Promise<void>((resolve) => server.close(() => resolve()))
      throw error
    }
    this.server = server
  }

  /** True while this instance owns a bound, listening server (a failed or foreign bind is not ownership). */
  get listening(): boolean {
    return this.server !== null && this.server.listening
  }

  private async clearStale(holdsLock: boolean): Promise<void> {
    let stat
    try {
      stat = lstatSync(this.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (!stat.isSocket())
      throw new SocketStartError('not-a-socket', 'socket path is occupied by a non-socket')
    const alive = await new Promise<boolean>((resolve, reject) => {
      const probe = net.connect(this.path)
      probe.once('connect', () => {
        probe.destroy()
        resolve(true)
      })
      probe.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve(false)
        else reject(error)
      })
    })
    if (alive)
      throw new SocketStartError('foreign-listener', 'another process is listening on the socket')
    if (!holdsLock)
      throw new SocketStartError(
        'stale-needs-lock',
        'stale socket removal needs the installation lock',
      )
    unlinkSync(this.path)
  }

  /**
   * Registers a launch and returns its single-use token (bound to installation, launch, generation, spec hash and this
   * Score incarnation) and the session that will carry it. The token goes into the supervisor's spec file only.
   */
  expect(args: {
    launch: string
    generation: number
    specHash: string
    handlers: RunHandlers
    /** Bytes the run keeps in memory besides queued records; charged to the installation budget while it is active. */
    retainedBytes?: number
    /**
     * Keep the reservation after the socket outcome (FW #8): the caller still holds the run's state (proof, translator,
     * the terminal result awaiting delivery) and calls `releaseReservation` once that is cleared.
     */
    holdAfterOutcome?: boolean
  }): {
    token: string
    session: RunSession
  } {
    if (this.pending.has(args.launch)) throw new Error('launch already registered')
    const reserved = args.retainedBytes ?? 0
    if (this.budget.used + reserved > this.budget.limit) throw new Error('memory-budget')
    this.budget.used += reserved
    const reservation = { bytes: reserved, floor: reserved }
    const session = new RunSession(
      args.launch,
      args.generation,
      args.handlers,
      this.limits,
      this.budget,
      reservation,
    )
    this.pending.set(args.launch, {
      generation: args.generation,
      specHash: args.specHash,
      session,
      used: false,
      reservation,
    })
    if (args.holdAfterOutcome !== true) void session.outcome.then(() => this.release(args.launch))
    return { token: this.tokenFor(args.launch, args.generation, args.specHash), session }
  }

  /** Forget a launch that will never connect (it was revoked before systemd-run). */
  forget(launch: string): void {
    this.release(launch)
  }

  /** Releases a reservation kept with `holdAfterOutcome` (idempotent). */
  releaseReservation(launch: string): void {
    this.release(launch)
  }

  private readonly holds = new Map<string, number>()
  /**
   * Charges state kept after the socket is gone (a terminal result waiting to be saved). It may exceed the budget: the
   * result must not be dropped, the charge only keeps new runs from piling more on top. Replaces an earlier hold.
   */
  hold(key: string, bytes: number): void {
    this.unhold(key)
    const charge = Math.max(0, Math.ceil(bytes))
    this.holds.set(key, charge)
    this.budget.used += charge
  }

  unhold(key: string): void {
    const charge = this.holds.get(key)
    if (charge === undefined) return
    this.holds.delete(key)
    this.budget.used -= charge
  }

  private release(launch: string): void {
    const entry = this.pending.get(launch)
    if (!entry) return
    this.pending.delete(launch)
    this.budget.used -= entry.reservation.bytes
    entry.reservation.bytes = 0
    entry.reservation.floor = 0
  }

  private tokenFor(launch: string, generation: number, specHash: string): string {
    return createHmac('sha256', this.secret)
      .update([this.options.installationId, launch, String(generation), specHash].join('\0'))
      .digest('hex')
  }

  private accept(socket: net.Socket): void {
    if (this.unauthenticated >= this.limits.maxUnauthenticated) {
      socket.destroy()
      return
    }
    this.unauthenticated += 1
    this.sockets.add(socket)
    socket.setEncoding('utf8')
    let buffer = ''
    let authenticated = false
    // The hello deadline runs until authentication succeeds or the socket closes (S4-005): a peer that sends a line and
    // then idles, or never reads the rejection, must not keep its slot.
    const timer = setTimeout(() => socket.destroy(), this.limits.helloTimeoutMs)
    timer.unref()
    const leaveUnauthenticated = () => {
      clearTimeout(timer)
      if (!authenticated) {
        authenticated = true
        this.unauthenticated -= 1
      }
    }
    socket.on('error', () => undefined)
    socket.on('close', () => {
      leaveUnauthenticated()
      this.sockets.delete(socket)
    })
    const onData = (chunk: string) => {
      buffer += chunk
      const nl = buffer.indexOf('\n')
      if (nl < 0) {
        if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) socket.destroy()
        return
      }
      socket.off('data', onData)
      const line = buffer.slice(0, nl)
      const leftover = buffer.slice(nl + 1)
      this.hello(socket, line, leftover, leaveUnauthenticated)
    }
    socket.on('data', onData)
  }

  private hello(
    socket: net.Socket,
    line: string,
    leftover: string,
    authenticated: () => void,
  ): void {
    const reject = (reason: string) => {
      // Reasons are fixed words; never echo the presented token or anything the peer sent.
      // destroy() after the write: end() alone leaves a half-open peer holding the slot until the hello deadline.
      const backstop = setTimeout(() => socket.destroy(), REJECT_BACKSTOP_MS)
      backstop.unref()
      socket.once('close', () => clearTimeout(backstop))
      socket.write(JSON.stringify({ v: PROTOCOL_VERSION, t: 'reject', reason }) + '\n', () =>
        socket.destroy(),
      )
    }
    let parsed
    try {
      parsed = SupervisorFrame.safeParse(JSON.parse(line))
    } catch {
      return reject('bad-hello')
    }
    if (!parsed.success || parsed.data.t !== 'hello') return reject('bad-hello')
    const hello = parsed.data
    const entry = this.pending.get(hello.launch)
    if (!entry) return reject('unknown-launch')
    if (entry.used) return reject('already-connected')
    if (entry.generation !== hello.generation || entry.specHash !== hello.specHash)
      return reject('mismatch')
    const expected = Buffer.from(this.tokenFor(hello.launch, hello.generation, hello.specHash))
    const presented = Buffer.from(hello.token)
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected))
      return reject('mismatch')
    // Consumed atomically (this runs synchronously): a replay finds `used` and is rejected.
    entry.used = true
    authenticated()
    entry.session.attach(socket, leftover)
  }

  /**
   * Score shutdown: send `stop` to every attached run, then destroy the accepted sockets explicitly (server.close()
   * alone would wait for them), then close the listener and remove the socket file.
   */
  async shutdown(): Promise<void> {
    this.epoch++
    const sessions = [...this.pending.values()].map((p) => p.session)
    const held = (this.options.frozen?.() ?? null) !== null
    await Promise.all(sessions.map((s) => s.shutdown(!held)))
    for (const socket of this.sockets) socket.destroy()
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    try {
      unlinkSync(this.path)
    } catch {
      // already gone
    }
  }
}
