import path from 'node:path'
import { HttpError } from '../errors.ts'
import { todayKey } from '../domain/reports.ts'
import type { KnowledgeVault } from './vault.ts'

// PLAN 8.2 (decision 83): a compaction's summary becomes `Memory/<agent>/<YYYY>/<MM>/<YYYY-MM-DD> <room>.md`, never
// overwritten, plus one generated `index.md` per month that lists the notes by weight.

/** The owner's time zone (GMT+8, no daylight saving); `SCORE_TIMEZONE` overrides it. */
export function memoryTimeZone(): string {
  return process.env.SCORE_TIMEZONE?.trim() || 'Asia/Singapore'
}

export const DEFAULT_WEIGHT = 3
const MAX_SAME_DAY = 99

/** A room name as a file name: no path or link punctuation, one line, at most 60 characters. */
export function memoryFileLabel(roomName: string): string {
  const cleaned = roomName
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 60)
    .trim()
  return cleaned === '' ? 'Room' : cleaned
}

/** `Memory/<agent>/<YYYY>/<MM>` when the note path is a memory note (not the index), else null. */
export function memoryMonthDir(notePath: string): string | null {
  const match = /^(Memory\/[^/]+\/\d{4}\/\d{2})\/[^/]+\.md$/.exec(notePath)
  return match && !notePath.endsWith('/index.md') ? match[1]! : null
}

export interface MemoryEntry {
  path: string
  title: string
  frontmatter: Record<string, unknown>
}

function weightOf(frontmatter: Record<string, unknown>): number {
  const value = frontmatter.weight
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5
    ? value
    : DEFAULT_WEIGHT
}

function dayOf(entry: MemoryEntry): string {
  const named = /^(\d{4}-\d{2}-\d{2})/.exec(path.posix.basename(entry.path))
  if (named) return named[1]!
  const date = entry.frontmatter.date
  if (date instanceof Date && !Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10)
  return typeof date === 'string' ? date.slice(0, 10) : ''
}

/** Weight first (5 before 1), then the newest day, then the name. */
export function sortMemoryEntries(entries: MemoryEntry[]): MemoryEntry[] {
  return [...entries].sort(
    (a, b) =>
      weightOf(b.frontmatter) - weightOf(a.frontmatter) ||
      dayOf(b).localeCompare(dayOf(a)) ||
      a.path.localeCompare(b.path),
  )
}

/** The month's index note: a link to each note, best weight first. */
export function buildMonthIndex(dir: string, entries: MemoryEntry[]): string {
  const [, agent, year, month] = dir.split('/')
  const lines = sortMemoryEntries(entries).map((entry) => {
    const target = entry.path.replace(/\.md$/, '')
    return `- [[${target}|${path.posix.basename(target)}]] · weight ${weightOf(entry.frontmatter)}`
  })
  return [
    `# Memory of ${agent}, ${year}-${month}`,
    '',
    'Score writes this list. Change a note’s `weight` (1–5) in its properties to move it; the list is rebuilt after the next compaction and after each scan.',
    '',
    ...(lines.length > 0 ? lines : ['No notes yet.']),
    '',
  ].join('\n')
}

export interface MemoryNoteInput {
  agentId: string
  roomName: string
  sessionId: string
  summary: string
  now: number
}

/**
 * Writes the note and refreshes the month's index. Returns the note's path. A second compaction on the same day gets
 * ` (2)`, ` (3)`, … so nothing is ever overwritten. Throws when the vault refuses; the caller logs it.
 */
export async function saveMemoryNote(
  vault: KnowledgeVault,
  input: MemoryNoteInput,
): Promise<string> {
  const day = todayKey(input.now, memoryTimeZone())
  const [year, month] = day.split('-') as [string, string, string]
  const dir = `Memory/${input.agentId}/${year}/${month}`
  const label = memoryFileLabel(input.roomName)
  const frontmatter = {
    date: day,
    agent: input.agentId,
    room: input.roomName,
    session: input.sessionId,
    weight: DEFAULT_WEIGHT,
    source: 'compaction',
  }
  for (let n = 1; n <= MAX_SAME_DAY; n++) {
    const rel = `${dir}/${day} ${label}${n === 1 ? '' : ` (${n})`}.md`
    try {
      const written = await vault.writeNote(
        rel,
        { body: `${input.summary.trim()}\n`, frontmatter, etag: null },
        { agentId: input.agentId },
      )
      return written.path
    } catch (error) {
      if (error instanceof HttpError && error.code === 'exists') continue
      throw error
    }
  }
  throw new Error('Too many memory notes for one room on one day')
}
