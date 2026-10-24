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
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@( fragment)?/u
const CUT = /^… \d+ more lines$/u

interface FileState {
  lines: Map<number, { text: string; by: string | null }>
  markers: Map<string, number | null>
  cursorAt: Map<string, string>
  exact: boolean
  language: string | null
  editedBy: Set<string>
  lastEditAt: string
}

function insertAt(file: FileState, pos: number): void {
  const lines = new Map<number, { text: string; by: string | null }>()
  for (const [n, line] of file.lines) lines.set(n >= pos ? n + 1 : n, line)
  file.lines = lines
  for (const [key, n] of file.markers) if (n !== null && n >= pos) file.markers.set(key, n + 1)
}

function deleteAt(file: FileState, pos: number): void {
  const lines = new Map<number, { text: string; by: string | null }>()
  for (const [n, line] of file.lines) if (n !== pos) lines.set(n > pos ? n - 1 : n, line)
  file.lines = lines
  for (const [key, n] of file.markers)
    if (n === pos) file.markers.set(key, null)
    else if (n !== null && n > pos) file.markers.set(key, n - 1)
}

function applyEdit(file: FileState, edit: EditEvent): void {
  file.editedBy.add(edit.agentId)
  file.lastEditAt = edit.at
  if (edit.language) file.language = edit.language
  const cursor = `cursor:${edit.agentId}`
  file.cursorAt.set(edit.agentId, edit.at)
  let pos = 0
  let inHunk = false
  let last: number | null = null
  for (const raw of edit.diff.split('\n')) {
    const hunk = HUNK.exec(raw)
    if (hunk) {
      if (hunk[5]) {
        // A snippet without a file position: Score can't place it, so the file's authorship is no longer exact.
        file.exact = false
        inHunk = false
        continue
      }
      const oldStart = Number(hunk[1])
      const oldCount = hunk[2] === undefined ? 1 : Number(hunk[2])
      // "-0,0": the file was empty or written whole (write_file without a known previous version).
      if (oldStart === 0 && oldCount === 0) {
        file.lines = new Map()
        for (const [key, n] of file.markers) if (n !== null) file.markers.set(key, null)
      }
      pos = Math.max(1, Number(hunk[3]))
      inHunk = true
      continue
    }
    if (CUT.test(raw)) {
      file.exact = false
      break
    }
    if (!inHunk || raw.startsWith('\\')) continue
    const text = raw.slice(1)
    if (raw.startsWith('+')) {
      insertAt(file, pos)
      file.lines.set(pos, { text, by: edit.agentId })
      last = pos
      pos += 1
    } else if (raw.startsWith('-')) {
      deleteAt(file, pos)
      last = pos
    } else if (raw.startsWith(' ')) {
      const known = file.lines.get(pos)
      file.lines.set(pos, { text, by: known?.by ?? null })
      pos += 1
    } else inHunk = false
  }
  file.markers.set(cursor, last)
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
          lines: new Map(),
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
    const file = files.get(event.path)
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
    notes.set(event.id, event)
    file.markers.set(`note:${event.id}`, event.line)
  }

  return {
    files: [...files.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, file]) => {
        const lines = [...file.lines.entries()].sort(([a], [b]) => a - b)
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
