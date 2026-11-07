import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import net from 'node:net'
import { dirname, join } from 'node:path'
import { RunSession } from './coding-socket-session.ts'
import {
  DEFAULT_LIMITS,
  MAX_FRAME_BYTES,
  MAX_SOCKET_PATH_BYTES,
  PROTOCOL_VERSION,
  SocketStartError,
  SupervisorFrame,
  type Budget,
  type CodingSocketOptions,
  type RunHandlers,
  type SocketLimits,
} from './coding-socket-types.ts'

interface Pending {
  generation: number
  specHash: string
  session: RunSession
  used: boolean
  /** Budget bytes reserved for what the run keeps in memory besides queued records (released once, see `release`). */
  reservation: { bytes: number; floor: number; released?: boolean }
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
    entry.reservation.released = true
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
