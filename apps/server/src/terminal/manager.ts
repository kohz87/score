import { randomUUID } from 'node:crypto'
import {
  TerminalClientFrameSchema,
  type TerminalServerFrame,
  type TerminalSession,
} from '@score/contract'
import type { TerminalLaunch } from './env.ts'
import { sessionMembers } from './session-members.ts'

/** The slice of a node-pty terminal Score uses (tests substitute their own). */
export interface PtyProcess {
  readonly pid: number
  onData(listener: (data: Buffer) => void): unknown
  onExit(listener: (event: { exitCode: number }) => void): unknown
  write(data: Buffer): void
  resize(cols: number, rows: number): void
  pause(): void
  resume(): void
}
export type SpawnPty = (launch: TerminalLaunch, size: { cols: number; rows: number }) => PtyProcess

/** The slice of a `ws` socket Score uses. */
export interface TerminalSocket {
  readonly bufferedAmount: number
  readonly readyState: number
  send(data: Buffer | string): void
  close(code?: number, reason?: string): void
  terminate(): void
  on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): unknown
  on(event: 'close' | 'error', listener: () => void): unknown
}
const OPEN = 1

export interface TerminalLimits {
  max: number
  idleMs: number
  absoluteMs: number
  /** Pause the PTY when the socket has this much unsent output. */
  highWater: number
  /** Resume below this. */
  lowWater: number
  /** Drop a terminal whose client has not drained for this long. */
  stallMs: number
  killGraceMs: number
  tickMs: number
}
export const DEFAULT_LIMITS: TerminalLimits = {
  max: 2,
  idleMs: 15 * 60_000,
  absoluteMs: 8 * 60 * 60_000,
  highWater: 1024 * 1024,
  lowWater: 256 * 1024,
  stallMs: 60_000,
  killGraceMs: 3_000,
  tickMs: 1_000,
}
const MAX_INPUT_FRAME = 64 * 1024
const DEFAULT_SIZE = { cols: 120, rows: 36 }

export type CloseReason = Extract<TerminalServerFrame, { type: 'exit' }>['reason']

/** Audit lines: open, close and kill only. Never keystrokes, never output. */
export interface TerminalAudit {
  info(fields: Record<string, unknown>, message: string): void
}

interface Live {
  id: string
  session: string
  address: string
  socket: TerminalSocket
  pty: PtyProcess
  openedAt: number
  lastActivityAt: number
  cols: number
  rows: number
  pausedSince: number | undefined
  exited: boolean
  closing: CloseReason | undefined
  killTimer: NodeJS.Timeout | undefined
  done: Promise<void>
  finish: () => void
}

export class TerminalManager {
  readonly #live = new Map<string, Live>()
  readonly #timer: NodeJS.Timeout
  readonly #limits: TerminalLimits

  constructor(
    private readonly spawn: SpawnPty,
    private readonly audit: TerminalAudit,
    private readonly launch: TerminalLaunch,
    private readonly clock: () => number = Date.now,
    limits: Partial<TerminalLimits> = {},
    /** Is this session still paired? Revocation also arrives by event; expiry is only seen by asking. */
    private readonly stillPaired: (session: string) => boolean = () => true,
  ) {
    this.#limits = { ...DEFAULT_LIMITS, ...limits }
    this.#timer = setInterval(() => this.tick(), this.#limits.tickMs)
    this.#timer.unref()
  }

  get count(): number {
    return this.#live.size
  }

  get full(): boolean {
    return this.#live.size >= this.#limits.max
  }

  list(): TerminalSession[] {
    return [...this.#live.values()].map((terminal) => ({
      id: terminal.id,
      openedAt: new Date(terminal.openedAt).toISOString(),
      lastActivityAt: new Date(terminal.lastActivityAt).toISOString(),
      address: terminal.address,
      cols: terminal.cols,
      rows: terminal.rows,
    }))
  }

  /** The id of the terminal now serving `socket`, or undefined if it was refused (the socket is then closed). */
  open(socket: TerminalSocket, session: string, address: string): string | undefined {
    if (this.full) {
      this.sendFrame(socket, { type: 'exit', reason: 'limit', code: null })
      socket.close(1013, 'Too many terminals')
      return undefined
    }
    let pty: PtyProcess
    try {
      pty = this.spawn(this.launch, DEFAULT_SIZE)
    } catch (error) {
      this.audit.info({ event: 'terminal.failed', err: String(error) }, 'Terminal could not start')
      socket.close(1011, 'Could not start the shell')
      return undefined
    }
    const now = this.clock()
    let finish!: () => void
    const done = new Promise<void>((resolve) => (finish = resolve))
    const terminal: Live = {
      id: randomUUID(),
      session,
      address,
      socket,
      pty,
      openedAt: now,
      lastActivityAt: now,
      ...DEFAULT_SIZE,
      pausedSince: undefined,
      exited: false,
      closing: undefined,
      killTimer: undefined,
      done,
      finish,
    }
    this.#live.set(terminal.id, terminal)
    this.audit.info(
      { event: 'terminal.open', terminalId: terminal.id, session: session.slice(0, 8), address },
      'Terminal opened',
    )
    this.sendFrame(socket, { type: 'ready', id: terminal.id, user: this.launch.user })

    pty.onData((data) => {
      terminal.lastActivityAt = this.clock()
      if (socket.readyState !== OPEN) return
      socket.send(data)
      // An output flood must not pile up in server memory: stop reading the PTY until the client drains.
      if (socket.bufferedAmount > this.#limits.highWater && terminal.pausedSince === undefined) {
        terminal.pausedSince = this.clock()
        pty.pause()
      }
    })
    pty.onExit(({ exitCode }) => {
      terminal.exited = true
      this.finishTerminal(terminal, terminal.closing ?? 'exited', exitCode)
    })
    socket.on('message', (data, isBinary) => {
      if (terminal.closing) return
      terminal.lastActivityAt = this.clock()
      if (isBinary) {
        if (data.length > 0 && data.length <= MAX_INPUT_FRAME) pty.write(data)
        return
      }
      let frame: unknown
      try {
        frame = JSON.parse(data.toString('utf8'))
      } catch {
        return
      }
      const resize = TerminalClientFrameSchema.safeParse(frame)
      if (!resize.success) return
      terminal.cols = resize.data.cols
      terminal.rows = resize.data.rows
      try {
        pty.resize(resize.data.cols, resize.data.rows)
      } catch {
        // The shell already ended.
      }
    })
    socket.on('close', () => this.close(terminal.id, 'closed'))
    socket.on('error', () => this.close(terminal.id, 'closed'))
    return terminal.id
  }

  /** Ends one terminal: tells the client, hangs up the process group and force-kills it after the grace period. */
  close(id: string, reason: CloseReason): void {
    const terminal = this.#live.get(id)
    if (!terminal || terminal.closing) return
    terminal.closing = reason
    this.sendFrame(terminal.socket, { type: 'exit', reason, code: null })
    if (terminal.socket.readyState === OPEN) terminal.socket.close(1000, reason)
    if (terminal.exited) return this.finishTerminal(terminal, reason, null)
    this.signal(terminal, 'SIGHUP')
    terminal.killTimer = setTimeout(() => {
      this.signal(terminal, 'SIGKILL')
      // A process stuck in uninterruptible sleep must not hold a slot forever.
      terminal.killTimer = setTimeout(() => this.finishTerminal(terminal, reason, null), 1_000)
    }, this.#limits.killGraceMs)
  }

  /** Close every terminal of a session (revoked, signed out, expired). */
  closeSession(session: string, reason: CloseReason = 'revoked'): void {
    for (const terminal of this.#live.values())
      if (terminal.session === session) this.close(terminal.id, reason)
  }

  /** Score is stopping: close everything and wait (bounded) for the processes to be gone. */
  async closeAll(reason: CloseReason = 'stopped'): Promise<void> {
    clearInterval(this.#timer)
    const all = [...this.#live.values()]
    for (const terminal of all) this.close(terminal.id, reason)
    await Promise.all(all.map((terminal) => terminal.done))
  }

  private tick(): void {
    const now = this.clock()
    for (const terminal of [...this.#live.values()]) {
      if (terminal.closing) continue
      if (now - terminal.openedAt >= this.#limits.absoluteMs) this.close(terminal.id, 'limit')
      else if (now - terminal.lastActivityAt >= this.#limits.idleMs) this.close(terminal.id, 'idle')
      else if (!this.stillPaired(terminal.session)) this.close(terminal.id, 'revoked')
      else if (terminal.pausedSince !== undefined) {
        if (terminal.socket.bufferedAmount <= this.#limits.lowWater) {
          terminal.pausedSince = undefined
          terminal.pty.resume()
        } else if (now - terminal.pausedSince >= this.#limits.stallMs) {
          this.close(terminal.id, 'stalled')
          // The client is not reading, so a polite close frame would sit in the same full buffer.
          terminal.socket.terminate()
        }
      }
    }
  }

  private signal(terminal: Live, signal: NodeJS.Signals): void {
    // node-pty starts the shell as a session leader, so its pid is its session and process group id. Jobs run in groups
    // of their own inside that session: signal each of those groups too, not only the shell's.
    const groups = new Set([terminal.pty.pid])
    for (const member of sessionMembers(terminal.pty.pid)) groups.add(member.pgid)
    for (const group of groups) {
      try {
        process.kill(-group, signal)
      } catch {
        // Gone already.
      }
    }
    // A stand-in without a group of its own (tests): the process itself.
    try {
      process.kill(terminal.pty.pid, signal)
    } catch {
      // Gone already.
    }
  }

  private finishTerminal(terminal: Live, reason: CloseReason, code: number | null): void {
    if (!this.#live.delete(terminal.id)) return
    clearTimeout(terminal.killTimer)
    terminal.closing ??= reason
    if (terminal.socket.readyState === OPEN) {
      this.sendFrame(terminal.socket, { type: 'exit', reason, code })
      terminal.socket.close(1000, reason)
    }
    this.audit.info(
      {
        event: reason === 'exited' || reason === 'closed' ? 'terminal.close' : 'terminal.kill',
        terminalId: terminal.id,
        session: terminal.session.slice(0, 8),
        reason,
        durationMs: this.clock() - terminal.openedAt,
      },
      reason === 'exited' || reason === 'closed' ? 'Terminal closed' : 'Terminal killed',
    )
    terminal.finish()
  }

  private sendFrame(socket: TerminalSocket, frame: TerminalServerFrame): void {
    if (socket.readyState === OPEN) socket.send(JSON.stringify(frame))
  }
}
