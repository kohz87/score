import type { Scheduler } from '../../src/hermes/index.ts'

export const schedulerStart = Date.parse('2026-01-01T12:00:00.000Z')

export class FakeScheduler implements Scheduler {
  private time = schedulerStart
  private nextId = 0
  private readonly timers = new Map<number, { at: number; callback: () => void }>()

  now(): number {
    return this.time
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++
    this.timers.set(id, { at: this.time + delayMs, callback })
    return id
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.timers.delete(handle)
  }

  get pending(): number {
    return this.timers.size
  }

  async advance(ms: number, overdue = false): Promise<void> {
    const target = this.time + ms
    if (overdue) this.time = target
    while (true) {
      const next = [...this.timers.entries()].sort(
        ([leftId, left], [rightId, right]) =>
          (overdue ? right.at - left.at : left.at - right.at) || leftId - rightId,
      )[0]
      if (!next || next[1].at > target) break
      const [id, timer] = next
      if (!overdue) this.time = timer.at
      this.timers.delete(id)
      timer.callback()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    this.time = target
  }
}
