import type { CacheTokens, KanbanTaskFact } from './reports-types.ts'

/** Cache hit rate: read / total, null when unknown or nothing was sent. */
export function cacheHitRate(tokens: CacheTokens | null | undefined): number | null {
  return tokens && tokens.total > 0 ? Math.min(1, tokens.read / tokens.total) : null
}

export function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

export type Interval = [number, number]

/** Merged, window-clipped intervals. */
export function merge(intervals: Interval[], from: number, to: number): Interval[] {
  const out: Interval[] = []
  for (const [s, e] of intervals
    .map(([s, e]): Interval => [Math.max(s, from), Math.min(e, to)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1)
    if (last && s <= last[1]) last[1] = Math.max(last[1], e)
    else out.push([s, e])
  }
  return out
}

/** Parts of `intervals` not covered by `cut` (both merged and sorted). */
export function subtract(intervals: Interval[], cut: Interval[]): Interval[] {
  const out: Interval[] = []
  for (const [s, e] of intervals) {
    let start = s
    for (const [cs, ce] of cut) {
      if (ce <= start || cs >= e) continue
      if (cs > start) out.push([start, cs])
      start = Math.max(start, ce)
      if (start >= e) break
    }
    if (start < e) out.push([start, e])
  }
  return out
}

export const measure = (intervals: Interval[]): number =>
  intervals.reduce((total, [s, e]) => total + (e - s), 0)

/** Intervals of waiting on another agent for one task: waiting for parents, and out for review. */
export function agentWaits(task: KanbanTaskFact, agentId: string, now: number): Interval[] {
  const waits: Interval[] = []
  const events = [...task.events].sort((a, b) => a.id - b.id)
  const at = (kind: string) => events.find((event) => event.kind === kind)?.at
  if (task.hasParents && task.assignee === agentId)
    waits.push([task.createdAt, at('promoted') ?? (task.status === 'todo' ? now : task.createdAt)])
  // The implementer waits for the review, whoever the task is assigned to now (Hermes hands it to the reviewer).
  for (const request of events.filter(
    (event) => event.kind === 'review_requested' && event.actor === agentId,
  )) {
    const end = events.find(
      (event) =>
        event.id > request.id && (event.kind === 'completed' || event.kind === 'changes_requested'),
    )
    waits.push([request.at, end?.at ?? (task.status === 'review' ? now : request.at)])
  }
  return waits
}

/** Intervals a task sat blocked on you. */
export function blockedWaits(task: KanbanTaskFact, now: number): Interval[] {
  return task.events
    .filter((event) => event.kind === 'blocked')
    .map((block): Interval => {
      const end = task.events.find((event) => event.kind === 'unblocked' && event.id > block.id)
      return [block.at, end?.at ?? (task.status === 'blocked' ? now : block.at)]
    })
}

/** Integer percentages that add to 100 (largest remainder) so the three bars always fill the track. */
export function percentages(parts: number[]): number[] {
  const total = parts.reduce((sum, part) => sum + part, 0)
  if (total <= 0) return parts.map(() => 0)
  const exact = parts.map((part) => (part / total) * 100)
  const floors = exact.map(Math.floor)
  let left = 100 - floors.reduce((sum, part) => sum + part, 0)
  const order = exact
    .map((value, i) => [value - floors[i]!, i] as const)
    .sort((a, b) => b[0] - a[0])
  for (const [, i] of order) {
    if (left <= 0) break
    floors[i]!++
    left--
  }
  return floors
}

export const rate = (passed: number, reviewed: number): number | null =>
  reviewed ? passed / reviewed : null
export const sum = (values: (number | null)[]): number | null => {
  const known = values.filter((value): value is number => value !== null)
  return known.length ? known.reduce((total, value) => total + value, 0) : null
}
// Spend is dollars; round to the cent-fraction Hermes records so float noise never reaches the UI.
export const money = (value: number | null): number | null =>
  value === null ? null : Math.round(value * 1e6) / 1e6
