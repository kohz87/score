import type { WorkbenchComment, WorkbenchFile } from '@score/contract'

// Per-line authorship for a job's Workbench (PLAN 11.6a), replayed from the ordered editor diffs Score recorded. Score
// never reads the files: a line is known when an edit wrote it or showed it as context. Review notes and each agent's
// last edit position are markers that move with later insertions and become null when their line is changed or removed.

export interface EditEvent {
  kind: 'edit'
  at: string
  order: number
  agentId: string
  path: string
  diff: string
  language: string | null
}
export interface CommentEvent {
  kind: 'comment'
  at: string
  order: number
  id: string
  agentId: string
  path: string
  line: number
  text: string
  exchangeId: string | null
  action: WorkbenchComment['kind']
}

const MAX_LINES = 5000
// Past this a file's known lines stop growing: the replay stays linear-time and bounded for any job.
const MAX_TRACKED = 200_000
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/u
const FRAGMENT = ' fragment (file position unknown)'
const CUT = /^… \d+ more lines$/u

type Line = { text: string; by: string | null } | undefined

interface FileState {
  /** Index n - 1 holds line n; holes are lines Score never saw. */
  lines: Line[]
  markers: Map<string, number | null>
  cursorAt: Map<string, string>
  exact: boolean
  language: string | null
  editedBy: Set<string>
  lastEditAt: string
}

/** One hunk as a single splice: the old region becomes the new one, and markers inside it follow their line. */
function applyHunk(
  file: FileState,
  agentId: string,
  start: number,
  oldCount: number,
  body: string[],
): number | null {
  const from = Math.max(0, start - 1)
  if (from + oldCount > MAX_TRACKED) {
    file.exact = false
    return null
  }
  if (file.lines.length < from + oldCount) file.lines.length = from + oldCount
  const old = file.lines.slice(from, from + oldCount)
  const next: Line[] = []
  // Where each old line of the region ended up (null = removed or rewritten).
  const moved: (number | null)[] = []
  let at = 0
  let last: number | null = null
  for (const raw of body) {
    const text = raw.slice(1)
    if (raw.startsWith(' ')) {
      moved[at] = from + next.length + 1
      next.push({ text, by: old[at]?.by ?? null })
      at += 1
    } else if (raw.startsWith('-')) {
      moved[at] = null
      at += 1
      last = from + next.length + 1
    } else {
      next.push({ text, by: agentId })
      last = from + next.length
    }
  }
  file.lines.splice(from, oldCount, ...next)
  const shift = next.length - oldCount
  for (const [key, n] of file.markers) {
    if (n === null || n <= from) continue
    if (n > from + oldCount) file.markers.set(key, n + shift)
    else file.markers.set(key, moved[n - from - 1] ?? null)
  }
  if (file.lines.length > MAX_TRACKED) {
    file.lines.length = MAX_TRACKED
    file.exact = false
  }
  return last
}

function applyEdit(file: FileState, edit: EditEvent): void {
  file.editedBy.add(edit.agentId)
  file.lastEditAt = edit.at
  if (edit.language) file.language = edit.language
  let last: number | null = null
  let hunk: {
    start: number
    oldCount: number
    oldLeft: number
    newLeft: number
    body: string[]
    /** False for a fragment: its lines are consumed but never placed. */
    place: boolean
  } | null = null
  const close = () => {
    if (hunk?.place)
      last = applyHunk(file, edit.agentId, hunk.start, hunk.oldCount, hunk.body) ?? last
    hunk = null
  }
  for (const raw of edit.diff.split('\n')) {
    // Inside a hunk its own counts say where it ends, so a second file header (watch-diff joins operations on one
    // path into one frame) is never taken for content.
    if (hunk && (hunk.oldLeft > 0 || hunk.newLeft > 0)) {
      if (raw.startsWith('\\')) continue
      if (raw.startsWith(' ')) {
        hunk.oldLeft -= 1
        hunk.newLeft -= 1
      } else if (raw.startsWith('-')) hunk.oldLeft -= 1
      else if (raw.startsWith('+')) hunk.newLeft -= 1
      else {
        // The diff ended early (cut or malformed): what is known is applied, the rest is not exact.
        file.exact = false
        close()
        if (CUT.test(raw)) break
        continue
      }
      hunk.body.push(raw)
      if (hunk.oldLeft <= 0 && hunk.newLeft <= 0) close()
      continue
    }
    close()
    if (CUT.test(raw)) {
      file.exact = false
      break
    }
    const header = HUNK.exec(raw)
    if (!header) continue
    const oldCount = header[2] === undefined ? 1 : Number(header[2])
    const newCount = header[4] === undefined ? 1 : Number(header[4])
    if (header[5] === FRAGMENT) {
      // A snippet without a file position: Score can't place it, so the file's authorship is no longer exact.
      file.exact = false
      hunk = { start: 0, oldCount, oldLeft: oldCount, newLeft: newCount, body: [], place: false }
      continue
    }
    const oldStart = Number(header[1])
    // "-0,0": the file was empty or written whole (write_file without a known previous version).
    if (oldStart === 0 && oldCount === 0) {
      file.lines = []
      for (const [key, n] of file.markers) if (n !== null) file.markers.set(key, null)
    }
    hunk = {
      start: Math.max(1, Number(header[3])),
      oldCount,
      oldLeft: oldCount,
      newLeft: newCount,
      body: [],
      place: true,
    }
    if (oldCount === 0 && newCount === 0) close()
  }
  close()
  if (last !== null) {
    file.markers.set(`cursor:${edit.agentId}`, last)
    file.cursorAt.set(edit.agentId, edit.at)
  }
}

/** The edited path a note means: the same string, or the one edited path that ends with it (or it ends with). */
function resolvePath(files: Map<string, unknown>, path: string): string | null {
  const clean = path.replace(/^\.\//u, '')
  if (files.has(clean)) return clean
  const matches = [...files.keys()].filter(
    (edited) => edited.endsWith(`/${clean}`) || clean.endsWith(`/${edited}`),
  )
  return matches.length === 1 ? matches[0]! : null
}

export interface ReplayResult {
  files: Omit<WorkbenchFile, never>[]
  looseComments: (WorkbenchComment & { path: string })[]
}

export function replayWorkbench(edits: EditEvent[], comments: CommentEvent[]): ReplayResult {
  const files = new Map<string, FileState>()
  const notes = new Map<string, CommentEvent>()
  const loose: (WorkbenchComment & { path: string })[] = []
  // Edits before notes at the same moment: a note reviews the work it came after.
  const timeline = [...edits, ...comments].sort(
    (a, b) =>
      a.at.localeCompare(b.at) ||
      (a.kind === b.kind ? a.order - b.order : a.kind === 'edit' ? -1 : 1),
  )
  for (const event of timeline) {
    if (event.kind === 'edit') {
      let file = files.get(event.path)
      if (!file) {
        file = {
          lines: [],
          markers: new Map(),
          cursorAt: new Map(),
          exact: true,
          language: null,
          editedBy: new Set(),
          lastEditAt: event.at,
        }
        files.set(event.path, file)
      }
      applyEdit(file, event)
      continue
    }
    const path = resolvePath(files, event.path)
    const file = path === null ? undefined : files.get(path)
    const note = (line: number | null): WorkbenchComment => ({
      id: event.id,
      by: event.agentId,
      line,
      originalLine: event.line,
      text: event.text,
      outdated: line === null,
      exchangeId: event.exchangeId,
      kind: event.action,
      at: event.at,
    })
    if (!file) {
      loose.push({ ...note(event.line), outdated: false, path: event.path })
      continue
    }
    notes.set(event.id, { ...event, path: path! })
    file.markers.set(`note:${event.id}`, event.line)
  }

  return {
    files: [...files.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, file]) => {
        const lines: [number, NonNullable<Line>][] = []
        file.lines.forEach((line, index) => {
          if (line) lines.push([index + 1, line])
        })
        return {
          path,
          language: file.language,
          exact: file.exact && lines.length <= MAX_LINES,
          lines: lines
            .slice(0, MAX_LINES)
            .map(([n, line]) => ({ n, text: line.text, by: line.by })),
          cursors: [...file.cursorAt.entries()]
            .map(([agentId, at]) => ({
              agentId,
              line: file.markers.get(`cursor:${agentId}`) ?? null,
              at,
            }))
            .sort((a, b) => a.agentId.localeCompare(b.agentId)),
          comments: [...notes.values()]
            .filter((event) => event.path === path)
            .map((event) => {
              const line = file.markers.get(`note:${event.id}`) ?? null
              return {
                id: event.id,
                by: event.agentId,
                line,
                originalLine: event.line,
                text: event.text,
                outdated: line === null,
                exchangeId: event.exchangeId,
                kind: event.action,
                at: event.at,
              }
            }),
          editedBy: [...file.editedBy].sort(),
          lastEditAt: file.lastEditAt,
        }
      }),
    looseComments: loose,
  }
}
