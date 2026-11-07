import { lstat } from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'
import type { BotInputEvent } from '@score/contract'
import {
  CONTROL_IDLE_MS,
  type BotControl,
  type BotScreenFrame,
  type BotScreenOptions,
  type BotScreenStatus,
} from './bot-screen-types.ts'
import { RfbSession, keyEvent, pointerEvent } from './bot-screen-protocol.ts'
import { encodePng } from './bot-screen-png.ts'
import { type LeaseView, readLease, sandboxed } from './bot-screen-lease.ts'

const IDLE_CLOSE_MS = 15_000

const ours = (lease: LeaseView, control: BotControl) =>
  lease.holder === 'human' && lease.viewerId === control.viewerId && lease.epoch === control.epoch

/**
 * One shared session per profile, opened on demand and closed after 15 s without a viewer. The lease is read before
 * every status and frame; while a human holds the screen nothing is served and the framebuffer is dropped.
 */
export class BotScreens {
  private sessions = new Map<
    string,
    { session: RfbSession; lastUsed: number; png: BotScreenFrame | null }
  >()
  private controls = new Map<string, BotControl>()
  private sweeper: NodeJS.Timeout | null = null
  constructor(private readonly options: BotScreenOptions) {}

  /** The takeover Score holds on this agent's screen, if any. */
  control(agentId: string): BotControl | undefined {
    return this.controls.get(agentId)
  }
  /** Hermes' lease now names this takeover: frames and input go to its owner only. */
  setControl(agentId: string, control: BotControl) {
    this.controls.set(agentId, control)
  }
  /** The takeover ended: nothing it saw stays in memory (the framebuffer may hold what the person typed). */
  clearControl(agentId: string) {
    const control = this.controls.get(agentId)
    if (!control) return
    this.controls.delete(agentId)
    // Ending on Score's side (hand back, idle, limit, page gone): the lease is still Score's, so let go of anything the
    // person held down (a page that closed mid-keypress never sends its key-up), then forget the screen.
    const held = control.held
    const session = this.sessions.get(agentId)?.session
    if (held && session && (held.keys.size || held.buttons))
      session.sendInput([
        ...[...held.keys].map((keysym) => keyEvent(false, keysym)),
        ...(held.buttons ? [pointerEvent(0, held.x, held.y)] : []),
      ])
    this.drop(agentId)
  }

  /** `viewer` is the asking browser session; only a takeover's owner sees the screen while Score holds it. */
  async status(agentId: string, viewer?: string): Promise<BotScreenStatus> {
    return (await this.inspect(agentId, viewer)).status
  }

  /** The current frame as PNG, or the status explaining why there is none. */
  async frame(agentId: string, viewer?: string): Promise<BotScreenFrame | BotScreenStatus> {
    const { status, lease, botDir } = await this.inspect(agentId, viewer)
    if (status.state !== 'running' || !lease || !botDir) return status
    const entry = this.sessions.get(agentId)
    // Swept or dropped between the status read and here.
    if (!entry || entry.session.closed) return { state: 'off' }
    const { session } = entry
    if (entry.png?.seq !== session.seq)
      entry.png = {
        seq: session.seq,
        png: encodePng(session.width, session.height, session.pixels()),
      }
    // Read again after the grab, as Hermes' own thumbnail does: a takeover racing the read may already show a person's
    // session, so the frame is dropped rather than served.
    const after = await readLease(botDir)
    if (
      after.holder !== lease.holder ||
      after.epoch !== lease.epoch ||
      after.viewerId !== lease.viewerId
    ) {
      this.settle(agentId, after)
      return { state: 'human' }
    }
    return entry.png
  }

  /**
   * Sends one batch of input for a takeover. Checked first: the takeover is this owner's, and Hermes' lease still names
   * it. Anything else ends the takeover and sends nothing.
   */
  async input(
    agentId: string,
    viewer: string,
    takeoverId: string,
    events: readonly BotInputEvent[],
  ): Promise<'sent' | 'lost'> {
    const control = this.controls.get(agentId)
    if (!control || control.takeoverId !== takeoverId || control.owner !== viewer) return 'lost'
    // Past the idle window or the hard limit it is over, even if the 5-s sweep hasn't ended it yet.
    const at = this.now()
    if (at - control.lastInput > CONTROL_IDLE_MS || at >= control.expiresAt) return 'lost'
    const { status } = await this.inspect(agentId, viewer)
    const entry = this.sessions.get(agentId)
    if (status.state !== 'running' || status.control?.takeoverId !== takeoverId || !entry)
      return 'lost'
    const { width, height } = entry.session
    const bytes = events.map((event) =>
      event.k === 'key'
        ? keyEvent(event.down, event.keysym)
        : pointerEvent(
            event.buttons,
            Math.min(event.x, Math.max(0, width - 1)),
            Math.min(event.y, Math.max(0, height - 1)),
          ),
    )
    if (!entry.session.sendInput(bytes)) return 'lost'
    const held = (control.held ??= { keys: new Set(), buttons: 0, x: 0, y: 0 })
    for (const event of events)
      if (event.k === 'key') {
        if (event.down) held.keys.add(event.keysym)
        else held.keys.delete(event.keysym)
      } else {
        held.buttons = event.buttons
        held.x = Math.min(event.x, Math.max(0, width - 1))
        held.y = Math.min(event.y, Math.max(0, height - 1))
      }
    control.lastInput = this.now()
    entry.lastUsed = this.now()
    entry.session.demand()
    return 'sent'
  }

  close() {
    for (const id of [...this.sessions.keys()]) this.drop(id)
    this.controls.clear()
    if (this.sweeper) clearInterval(this.sweeper)
    this.sweeper = null
  }

  private async inspect(
    agentId: string,
    viewer: string | undefined,
  ): Promise<{ status: BotScreenStatus; lease?: LeaseView; botDir?: string }> {
    const home = this.options.profileHome(agentId)
    if (!home)
      return {
        status: { state: 'unavailable', reason: 'Score doesn’t know this agent’s profile.' },
      }
    const botDir = join(home, 'bot-desktop')
    if (await sandboxed(botDir)) {
      this.drop(agentId)
      return { status: { state: 'sandboxed' } }
    }
    const socketPath = join(botDir, 'rfb.sock')
    const dirInfo = await lstat(botDir).catch(() => null)
    const info = dirInfo ? await lstat(socketPath).catch(() => null) : null
    if (!dirInfo || !info) {
      this.drop(agentId)
      return { status: { state: 'off' } }
    }
    const uid = this.options.uid ?? process.getuid?.()
    const owned = (stats: { uid: number }) => uid === undefined || stats.uid === uid
    if (
      !dirInfo.isDirectory() ||
      !owned(dirInfo) ||
      !info.isSocket() ||
      info.isSymbolicLink() ||
      !owned(info)
    ) {
      this.drop(agentId)
      return {
        status: { state: 'unavailable', reason: 'The screen’s socket isn’t one Score can trust.' },
      }
    }
    const lease = await readLease(botDir)
    const control = this.settle(agentId, lease)
    if (lease.holder === 'human' && (!control || control.owner !== viewer))
      return { status: { state: 'human' } }
    const entry = await this.open(agentId, socketPath)
    if (!entry) return { status: { state: 'off' } }
    entry.lastUsed = this.now()
    entry.session.demand()
    return {
      lease,
      botDir,
      status: {
        state: 'running',
        width: entry.session.width,
        height: entry.session.height,
        frameSeq: entry.session.seq,
        ...(control
          ? {
              control: {
                takeoverId: control.takeoverId,
                since: new Date(control.since).toISOString(),
                idleExpiresAt: new Date(control.lastInput + CONTROL_IDLE_MS).toISOString(),
                expiresAt: new Date(control.expiresAt).toISOString(),
              },
            }
          : {}),
      },
    }
  }

  /**
   * Squares Score's view with the lease just read: a takeover the lease no longer names is over (and reported); while a
   * human that isn't Score holds the screen, nothing of it stays in memory. Returns the takeover still held.
   */
  private settle(agentId: string, lease: LeaseView): BotControl | undefined {
    const control = this.controls.get(agentId)
    if (control && !ours(lease, control)) {
      this.controls.delete(agentId)
      this.drop(agentId)
      this.options.onLost?.(agentId, control)
      return undefined
    }
    if (lease.holder === 'human' && !control) this.drop(agentId)
    return control
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
