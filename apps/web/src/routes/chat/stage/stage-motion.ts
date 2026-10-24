import type { StageMood } from './stage-mood.ts'

// How the members of a room stage move (PLAN 10.10): pure, no DOM. Positions are fractions of the strip's width.

export type Walker = { id: string; x: number; target: number }

const EDGE: readonly [number, number] = [0.08, 0.92]

/** Where members first stand: spread over the strip. */
export function initialPositions(count: number): number[] {
  return Array.from({ length: count }, (_, index) => (index + 0.7) / (count + 0.4))
}

export type StageOverlay = 'bang' | 'dots' | 'zzz'

/** The first `limit` members; one waiting for you that would be cut takes the place of the last one that isn't. */
export function shownMembers<T extends { mood: StageMood }>(members: T[], limit: number): T[] {
  if (members.length <= limit) return members
  const shown = members.slice(0, limit)
  for (const waiting of members.slice(limit).filter((item) => item.mood === 'needs')) {
    const at = shown.findLastIndex((item) => item.mood !== 'needs')
    if (at < 0) break
    shown[at] = waiting
  }
  return shown
}

/**
 * Where a member who joins stands: the spot it would have, or, when someone is there or heading there, the spot
 * farthest from everyone (so two members never share one after the roster changed).
 */
export function placeNewcomer(
  preferred: number,
  others: ReadonlyArray<{ x: number; target: number }>,
): number {
  if (others.length === 0) return preferred
  const nearest = (candidate: number) =>
    Math.min(
      ...others.flatMap((other) => [
        Math.abs(other.x - candidate),
        Math.abs(other.target - candidate),
      ]),
    )
  if (nearest(preferred) >= 0.1) return preferred
  let best = preferred
  let room = nearest(preferred)
  for (let candidate = EDGE[0]; candidate <= EDGE[1] + 1e-9; candidate += 0.01) {
    const space = nearest(candidate)
    if (space > room) {
      best = candidate
      room = space
    }
  }
  return best
}
