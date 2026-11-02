import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ScoreDb } from '../../db/index.ts'
import type { CommandRequest, RewindOutcome } from '../bridge/rewind-broker.ts'
import { type BotControl, type BotScreens, CONTROL_IDLE_MS, readLease } from './bot-screen.ts'

// 3.17.0 (docs/briefs/3.17.0-take-over.md): a person takes over an agent's Bot Desktop from Score. Control is taken and
// returned only through Hermes' own lease functions, run by Score's plugin in the profile's gateway; Score never writes
// Hermes' files. Every hand-back is recorded before it is asked and retried until the gateway confirms it.

export const CONTROL_LIMIT_MS = 30 * 60_000
/** No heartbeat from the page for this long: the person left, control goes back. */
export const HEARTBEAT_LOST_MS = 30_000
const TOUCH_MS = 60_000
const TICK_MS = 5_000
const ASK_MS = 10_000
const CLOSE_WAIT_MS = 5_000

export type TakeoverEndReason =
  'handed_back' | 'idle' | 'limit' | 'left' | 'lost' | 'restart' | 'not_granted'
export type TakeResult =
  | { ok: true; control: BotControl }
  | { ok: false; code: 'unavailable' | 'busy' | 'not_running' | 'failed'; message: string }

export interface BotTakeoverDeps {
  screens: BotScreens
  /** Sends a command to the profile's plugin (the rewind broker's `ask`); undefined when no bridge is wired. */
  ask:
    | ((profile: string, req: CommandRequest, timeoutMs: number) => Promise<RewindOutcome>)
    | undefined
  db: ScoreDb
  profileHome: (agentId: string) => string | null
  clock?: () => number
}

interface Row {
  id: string
  agent_id: string
  viewer_id: string
  epoch: number | null
  state: string
}

export class BotTakeovers {
  private readonly heartbeats = new Map<string, number>()
  private readonly touched = new Map<string, number>()
  private readonly inFlight = new Set<string>()
  /** Agents with a take in progress: one at a time, so two sessions can't both be granted (Hermes: last writer wins). */
  private readonly taking = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  private closed = false

  constructor(private readonly deps: BotTakeoverDeps) {
    // A takeover Score held when it stopped is handed back now: nobody is watching it any more.
    deps.db.tx((sqlite) =>
      sqlite
        .prepare(
          "UPDATE bot_takeovers SET state = 'releasing', ended_at = ?, end_reason = 'restart' WHERE state IN ('taking', 'active')",
        )
        .run(this.iso()),
    )
    this.arm()
  }

  async take(agentId: string, owner: string): Promise<TakeResult> {
    const ask = this.deps.ask
    if (!ask)
      return {
        ok: false,
        code: 'unavailable',
        message: 'Score’s plugin isn’t connected to Hermes here.',
      }
    if (this.taking.has(agentId) || this.deps.screens.control(agentId))
      return { ok: false, code: 'busy', message: 'Someone already has control of this screen.' }
    this.taking.add(agentId)
    try {
      return await this.takeOnce(agentId, owner, ask)
    } finally {
      this.taking.delete(agentId)
    }
  }

  private async takeOnce(
    agentId: string,
    owner: string,
    ask: NonNullable<BotTakeoverDeps['ask']>,
  ): Promise<TakeResult> {
    const status = await this.deps.screens.status(agentId, owner)
    if (status.state === 'human')
      return { ok: false, code: 'busy', message: 'Someone has already taken over this screen.' }
    if (status.state !== 'running')
      return { ok: false, code: 'not_running', message: 'The screen isn’t running right now.' }
    const id = randomUUID()
    const viewerId = `score:${randomBytes(18).toString('base64url')}`
    const now = this.now()
    // Recorded before Hermes is asked: if Score stops before the answer, the start-up hand-back finds it.
    this.deps.db.tx((sqlite) =>
      sqlite
        .prepare(
          "INSERT INTO bot_takeovers (id, agent_id, viewer_id, owner, state, started_at) VALUES (?, ?, ?, ?, 'taking', ?)",
        )
        .run(id, agentId, viewerId, owner, new Date(now).toISOString()),
    )
    this.inFlight.add(id)
    let answer: RewindOutcome
    try {
      answer = await ask(agentId, { kind: 'desktop_take', viewerId }, ASK_MS)
    } finally {
      this.inFlight.delete(id)
    }
    const lease = answer.status === 'done' ? answer.lease : undefined
    if (!lease || lease.holder !== 'human' || lease.viewerId !== viewerId || this.closed) {
      // It may still have been applied (no answer in time, or Score is stopping): the release reads the lease and hands
      // back only if it is ours.
      this.finish(id, 'releasing', 'not_granted')
      if (!this.closed) await this.releaseOwed()
      // The plugin refuses to take a screen another person holds and answers with their lease.
      const someoneElse = lease?.holder === 'human' && lease.viewerId !== viewerId
      return {
        ok: false,
        code: someoneElse ? 'busy' : answer.status === 'unavailable' ? 'unavailable' : 'failed',
        message: someoneElse
          ? 'Someone has already taken over this screen.'
          : answer.status === 'unavailable'
            ? 'Score’s plugin isn’t running in this agent’s Hermes gateway.'
            : this.closed
              ? 'Score is stopping.'
              : 'Hermes didn’t hand over the screen. Try again.',
      }
    }
    this.deps.db.tx((sqlite) =>
      sqlite
        .prepare("UPDATE bot_takeovers SET state = 'active', epoch = ? WHERE id = ?")
        .run(lease.epoch, id),
    )
    const control: BotControl = {
      takeoverId: id,
      viewerId,
      epoch: lease.epoch,
      owner,
      since: now,
      lastInput: this.now(),
      expiresAt: now + CONTROL_LIMIT_MS,
    }
    this.deps.screens.setControl(agentId, control)
    this.heartbeats.set(id, this.now())
    this.touched.set(id, this.now())
    this.arm()
    return { ok: true, control }
  }

  /** The page is still open. False when this owner holds no such takeover (it ended). */
  heartbeat(agentId: string, owner: string, takeoverId: string): boolean {
    const control = this.deps.screens.control(agentId)
    if (!control || control.takeoverId !== takeoverId || control.owner !== owner) return false
    this.heartbeats.set(takeoverId, this.now())
    return true
  }

  async handBack(agentId: string, owner: string, takeoverId: string): Promise<boolean> {
    const control = this.deps.screens.control(agentId)
    if (!control || control.takeoverId !== takeoverId || control.owner !== owner) return false
    await this.end(agentId, control, 'handed_back')
    return true
  }

  /** The screen saw the lease change under a takeover: nothing to hand back, the lease isn't Score's any more. */
  lost(_agentId: string, control: BotControl) {
    this.forget(control.takeoverId)
    this.finish(control.takeoverId, 'ended', 'lost')
  }

  /** Score is stopping: every takeover is handed back now if the gateway answers, else at the next start. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    const open = this.deps.db.sqlite
      .prepare("SELECT id, agent_id FROM bot_takeovers WHERE state = 'active'")
      .all() as unknown as { id: string; agent_id: string }[]
    for (const row of open) {
      this.deps.screens.clearControl(row.agent_id)
      this.forget(row.id)
      this.finish(row.id, 'releasing', 'restart')
    }
    // Best effort, bounded so a stop never waits on slow gateways: whatever isn't confirmed is handed back at the next
    // start (the rows stay 'releasing').
    await Promise.race([
      this.releaseOwed(),
      new Promise<void>((resolve) => setTimeout(resolve, CLOSE_WAIT_MS).unref()),
    ])
  }

  /** One sweep: idle, limit and left takeovers end; the desktop is marked in use; owed hand-backs are retried. */
  async tick(): Promise<void> {
    const now = this.now()
    const open = this.deps.db.sqlite
      .prepare(
        "SELECT id, agent_id, viewer_id, epoch, state FROM bot_takeovers WHERE state = 'active'",
      )
      .all() as unknown as Row[]
    for (const row of open) {
      const control = this.deps.screens.control(row.agent_id)
      if (!control || control.takeoverId !== row.id) {
        // Active in the record but not held on the screen (a raced take, a lost takeover not yet recorded): hand back
        // whatever of it Hermes still holds, by this row's own viewer and generation.
        this.finish(row.id, 'releasing', 'lost')
        continue
      }
      const reason: TakeoverEndReason | null =
        now - control.lastInput > CONTROL_IDLE_MS
          ? 'idle'
          : now >= control.expiresAt
            ? 'limit'
            : now - (this.heartbeats.get(row.id) ?? 0) > HEARTBEAT_LOST_MS
              ? 'left'
              : null
      if (reason) {
        await this.end(row.agent_id, control, reason)
        continue
      }
      if (now - (this.touched.get(row.id) ?? 0) >= TOUCH_MS && this.deps.ask) {
        this.touched.set(row.id, now)
        void this.deps.ask(
          row.agent_id,
          { kind: 'desktop_touch', viewerId: control.viewerId },
          ASK_MS,
        )
      }
    }
    await this.releaseOwed()
  }

  private async end(agentId: string, control: BotControl, reason: TakeoverEndReason) {
    this.deps.screens.clearControl(agentId)
    this.forget(control.takeoverId)
    this.finish(control.takeoverId, 'releasing', reason)
    await this.releaseOwed()
  }

  /** Every hand-back still owed, until the profile's gateway confirms it. */
  private async releaseOwed(): Promise<void> {
    const ask = this.deps.ask
    if (!ask) return
    const rows = this.deps.db.sqlite
      .prepare(
        "SELECT id, agent_id, viewer_id, epoch, state FROM bot_takeovers WHERE state = 'releasing'",
      )
      .all() as unknown as Row[]
    for (const row of rows) {
      if (this.inFlight.has(row.id)) continue
      this.inFlight.add(row.id)
      try {
        let epoch = row.epoch
        // No profile any more (the agent was removed): there is no screen and no gateway to hand back to.
        const home = this.deps.profileHome(row.agent_id)
        if (!home) {
          this.finish(row.id, 'ended')
          continue
        }
        if (epoch === null) {
          // Hermes may have granted a take whose answer never came: hand back only what the lease names as ours.
          const lease = await readLease(join(home, 'bot-desktop'))
          if (lease.viewerId !== row.viewer_id) {
            this.finish(row.id, 'ended')
            continue
          }
          epoch = lease.epoch
        }
        const answer = await ask(
          row.agent_id,
          { kind: 'desktop_hand_back', viewerId: row.viewer_id, epoch },
          ASK_MS,
        )
        if (answer.status === 'done') this.finish(row.id, 'ended')
      } finally {
        this.inFlight.delete(row.id)
      }
    }
  }

  private finish(id: string, state: 'releasing' | 'ended', reason?: TakeoverEndReason) {
    if (state === 'releasing') this.arm()
    this.deps.db.tx((sqlite) =>
      sqlite
        .prepare(
          'UPDATE bot_takeovers SET state = ?, ended_at = COALESCE(ended_at, ?), end_reason = COALESCE(end_reason, ?) WHERE id = ?',
        )
        .run(state, this.iso(), reason ?? null, id),
    )
  }

  private forget(id: string) {
    this.heartbeats.delete(id)
    this.touched.delete(id)
  }

  private arm() {
    if (this.timer || this.closed) return
    this.timer = setInterval(() => {
      const open = this.deps.db.sqlite
        .prepare("SELECT COUNT(*) AS n FROM bot_takeovers WHERE state IN ('active', 'releasing')")
        .get() as { n: number }
      if (open.n === 0) {
        if (this.timer) clearInterval(this.timer)
        this.timer = null
        return
      }
      void this.tick()
    }, TICK_MS)
    this.timer.unref()
  }

  private now() {
    return (this.deps.clock ?? Date.now)()
  }
  private iso() {
    return new Date(this.now()).toISOString()
  }
}
