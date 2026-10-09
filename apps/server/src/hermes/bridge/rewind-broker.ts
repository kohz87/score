import type { BridgeCommand, BridgeCommandResult } from '@score/contract'
import { randomUUID } from 'node:crypto'

/** A producer that polled this recently is taken to be listening. */
const LISTENING_MS = 45_000

export type RewindOutcome =
  | { status: 'done'; turnsUndone: number; rewoundCount: number }
  | { status: 'nothing' }
  | { status: 'failed' }
  | { status: 'unavailable' }
  | { status: 'no_answer' }

interface Pending {
  command: BridgeCommand
  profile: string
  claimed: boolean
  settle(result: RewindOutcome): void
}

/**
 * Server → plugin commands (PLAN 5.33, contract §11). In memory on purpose: a rewind request waits for its answer, and
 * a command that was not answered before the request gave up must not be run later. Each command is handed to one
 * polling producer of the profile once.
 */
export class RewindBroker {
  private readonly pending = new Map<string, Pending>()
  private readonly listeningSince = new Map<string, number>()
  private readonly waiters = new Set<() => void>()
  private closed = false

  constructor(private readonly clock: () => number = Date.now) {}

  /** Whether a gateway-side plugin of this profile is polling for commands. */
  available(profile: string): boolean {
    const at = this.listeningSince.get(profile)
    return at !== undefined && this.clock() - at < LISTENING_MS
  }

  async request(
    profile: string,
    req: { sessionId: string; turns: number },
    timeoutMs: number,
  ): Promise<RewindOutcome> {
    if (!this.available(profile)) return { status: 'unavailable' }
    const command: BridgeCommand = { commandId: randomUUID(), kind: 'rewind', ...req }
    return new Promise<RewindOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(command.commandId)
        resolve({ status: 'no_answer' })
      }, timeoutMs)
      this.pending.set(command.commandId, {
        command,
        profile,
        claimed: false,
        settle: (result) => {
          clearTimeout(timer)
          this.pending.delete(command.commandId)
          resolve(result)
        },
      })
      this.wake()
    })
  }

  /** Long poll: resolves with unclaimed commands for the profile, or [] after `waitMs` or when aborted. */
  async claim(profile: string, waitMs: number, signal: AbortSignal): Promise<BridgeCommand[]> {
    const deadline = this.clock() + waitMs
    for (;;) {
      this.listeningSince.set(profile, this.clock())
      const found = [...this.pending.values()].filter(
        (entry) => entry.profile === profile && !entry.claimed,
      )
      if (found.length) {
        for (const entry of found) entry.claimed = true
        return found.map((entry) => entry.command)
      }
      const remaining = deadline - this.clock()
      if (remaining <= 0 || signal.aborted || this.closed) return []
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          this.waiters.delete(done)
          signal.removeEventListener('abort', done)
          resolve()
        }
        const timer = setTimeout(done, Math.min(remaining, 5_000))
        this.waiters.add(done)
        signal.addEventListener('abort', done, { once: true })
      })
    }
  }

  complete(profile: string, commandId: string, result: BridgeCommandResult): boolean {
    const entry = this.pending.get(commandId)
    if (!entry || entry.profile !== profile || !entry.claimed) return false
    entry.settle(
      result.outcome === 'done'
        ? {
            status: 'done',
            turnsUndone: result.turnsUndone ?? 0,
            rewoundCount: result.rewoundCount ?? 0,
          }
        : { status: result.outcome },
    )
    return true
  }

  close(): void {
    this.closed = true
    this.wake()
    for (const entry of [...this.pending.values()]) entry.settle({ status: 'unavailable' })
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) waiter()
  }
}
