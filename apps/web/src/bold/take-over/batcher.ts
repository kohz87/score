import type { BotInputEvent } from '@score/contract'

export const MAX_BATCH = 200

/** Input waiting to go out. Runs of pointer events with the same buttons collapse into the latest position. */
export class InputBatcher {
  private events: BotInputEvent[] = []

  get size(): number {
    return this.events.length
  }

  push(...incoming: BotInputEvent[]): void {
    for (const event of incoming) {
      const last = this.events[this.events.length - 1]
      const prior = this.events[this.events.length - 2]
      // Keep the first and the latest of a run, so a press/release pair is never merged away.
      if (
        event.k === 'pointer' &&
        last?.k === 'pointer' &&
        prior?.k === 'pointer' &&
        last.buttons === event.buttons &&
        prior.buttons === event.buttons
      )
        this.events[this.events.length - 1] = event
      else this.events.push(event)
    }
  }

  take(max = MAX_BATCH): BotInputEvent[] {
    return this.events.splice(0, max)
  }

  clear(): void {
    this.events = []
  }
}
