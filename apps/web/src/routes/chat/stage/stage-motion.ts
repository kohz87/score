import type { PetActivity } from '@score/contract'
import type { Liveliness } from '../../../data/liveliness.ts'
import type { StageMood } from './stage-mood.ts'

// How the members of a room stage move (PLAN 10.10): pure, no DOM. Positions are fractions of the strip's width.

export type Walker = { id: string; x: number; target: number; pet: boolean }

/** Room kept around a pet, and between two marks, in px: a pet is wider than a mark. */
export const PET_GAP = 125
export const MARK_GAP = 85
export const WALK_PX_PER_SECOND = 70
const MIN_WALK_PX = 60
const EDGE: readonly [number, number] = [0.08, 0.92]

export const gapBetween = (aPet: boolean, bPet: boolean): number =>
  aPet || bPet ? PET_GAP : MARK_GAP

/** Where to walk next: a spot clear of where others stand and where they are heading, or null when none is found. */
export function pickTarget(
  self: Walker,
  others: Walker[],
  width: number,
  random: () => number,
): number | null {
  const clear = (candidate: number) =>
    others.every((other) => {
      if (other.id === self.id) return true
      const gap = gapBetween(self.pet, other.pet) / width
      return Math.abs(other.x - candidate) > gap && Math.abs(other.target - candidate) > gap
    })
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidate = EDGE[0] + random() * (EDGE[1] - EDGE[0])
    if (clear(candidate) && Math.abs(candidate - self.x) > MIN_WALK_PX / width) return candidate
  }
  return null
}

export function stepToward(
  x: number,
  target: number,
  seconds: number,
  width: number,
): { x: number; arrived: boolean } {
  const step = (WALK_PX_PER_SECOND / width) * seconds
  if (Math.abs(target - x) <= step) return { x: target, arrived: true }
  return { x: x + Math.sign(target - x) * step, arrived: false }
}

/** Where members first stand: spread over the strip. */
export function initialPositions(count: number): number[] {
  return Array.from({ length: count }, (_, index) => (index + 0.7) / (count + 0.4))
}

/** The idle extras a pack may have, in the order they are offered. */
export const BREAK_FILES = ['coffee', 'stretch', 'read'] as const satisfies readonly PetActivity[]
export type BreakFile = (typeof BREAK_FILES)[number]

export function pickBreak(files: ReadonlySet<string>, random: () => number): BreakFile | null {
  const have = BREAK_FILES.filter((file) => files.has(file))
  return have.length ? have[Math.floor(random() * have.length)]! : null
}

/** Only a resting member wanders, and only under Lively; marks hop on the way but take no breaks. */
export function restingMotion(
  liveliness: Liveliness,
  mood: StageMood,
  pet: boolean,
): { walks: boolean; breaks: boolean } {
  const lively = liveliness === 'lively' && mood === 'rest'
  return { walks: lively, breaks: lively && pet }
}

export type StageOverlay = 'bang' | 'dots' | 'zzz'
export type Motion = { mode: 'idle' | 'walk' | 'break'; file?: BreakFile }

/** The file a pet plays now, always one the pack has, and Score's own overlay for a mood the pack has no file for. */
export function petView(
  mood: StageMood,
  motion: Motion,
  files: ReadonlySet<string>,
): { file: PetActivity; overlay: StageOverlay | null } {
  const has = (file: PetActivity) => files.has(file)
  switch (mood) {
    case 'needs':
      return { file: has('needs') ? 'needs' : 'idle', overlay: 'bang' }
    case 'think':
      return has('think') ? { file: 'think', overlay: null } : { file: 'idle', overlay: 'dots' }
    case 'sleep':
      return has('sleep') ? { file: 'sleep', overlay: null } : { file: 'idle', overlay: 'zzz' }
    case 'work':
      return { file: has('work') ? 'work' : 'idle', overlay: null }
    case 'rest':
      if (motion.mode === 'walk' && has('walk')) return { file: 'walk', overlay: null }
      if (motion.mode === 'break' && motion.file && has(motion.file))
        return { file: motion.file, overlay: null }
      return { file: 'idle', overlay: null }
  }
}

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
