import type { Approval, WatchFrame, WatchMarker, WatchMarkerKind } from '@score/contract'

export type Surface = WatchFrame['surface']

export const markerLabels: Record<WatchMarkerKind, string> = {
  command: 'Command',
  file: 'File edit',
  browser: 'Browser',
  asked: 'Asked you',
}
export const markerKinds: WatchMarkerKind[] = ['command', 'file', 'browser', 'asked']
export const surfaceMarker: Record<Surface, WatchMarkerKind> = {
  terminal: 'command',
  editor: 'file',
  browser: 'browser',
}
export const surfaceLabels: Record<Surface, string> = {
  terminal: 'Terminal',
  editor: 'Editor',
  browser: 'Browser',
}

const FRAME_CAP = 500
const MARKER_CAP = 2000

/** Frames are upserted by seq: a terminal frame is re-emitted with the same seq when it finishes. */
export function upsertFrame(frames: WatchFrame[], frame: WatchFrame): WatchFrame[] {
  const index = frames.findIndex((item) => item.seq === frame.seq)
  if (index >= 0) return frames.map((item, at) => (at === index ? frame : item))
  const next = [...frames, frame].sort((a, b) => a.seq - b.seq)
  return next.length > FRAME_CAP ? next.slice(next.length - FRAME_CAP) : next
}

/** A frame that is re-emitted keeps its marker; an ask is new when no ask exists at that time. */
export function addMarker(markers: WatchMarker[], marker: WatchMarker): WatchMarker[] {
  const known =
    marker.kind === 'asked'
      ? markers.some((item) => item.kind === 'asked' && item.at === marker.at)
      : markers.some((item) => item.seq === marker.seq && item.kind !== 'asked')
  if (known) return markers
  const next = [...markers, marker].sort((a, b) => a.seq - b.seq || a.at.localeCompare(b.at))
  return next.length > MARKER_CAP ? next.slice(next.length - MARKER_CAP) : next
}

/** What each window shows when the replay is at `seq` (null = live): the latest frame per surface. */
export function stageAt(
  frames: WatchFrame[],
  seq: number | null,
): { front: WatchFrame | null; bySurface: Partial<Record<Surface, WatchFrame>> } {
  const bySurface: Partial<Record<Surface, WatchFrame>> = {}
  let front: WatchFrame | null = null
  for (const frame of frames) {
    if (seq !== null && frame.seq > seq) break
    bySurface[frame.surface] = frame
    front = frame
  }
  return { front, bySurface }
}

/** The few terminal frames before `seq`, oldest first, shown as scrollback above the current command. */
export function terminalHistory(frames: WatchFrame[], seq: number, count = 3): WatchFrame[] {
  return frames.filter((frame) => frame.surface === 'terminal' && frame.seq < seq).slice(-count)
}

/**
 * Where each marker sits on the track, in percent, proportional to time between the first and the last marker.
 * Markers at the same moment keep their order and never share a position exactly.
 */
export function markerPositions(markers: WatchMarker[], from = 4, to = 97): number[] {
  if (markers.length === 0) return []
  if (markers.length === 1) return [to]
  const times = markers.map((marker) => Date.parse(marker.at))
  const first = times[0]!
  const span = Math.max(1, times[times.length - 1]! - first)
  const positions = times.map((time) => from + ((time - first) / span) * (to - from))
  for (let index = 1; index < positions.length; index += 1)
    if (positions[index]! - positions[index - 1]! < 0.8)
      positions[index] = Math.min(to, positions[index - 1]! + 0.8)
  return positions
}

/** The marker index nearest to a pointer position (percent) on the track. */
export function nearestMarker(positions: number[], percent: number): number | null {
  let best: number | null = null
  let distance = Infinity
  positions.forEach((position, index) => {
    const gap = Math.abs(position - percent)
    if (gap <= distance) {
      best = index
      distance = gap
    }
  })
  return best
}

/** "Back 30 seconds": the latest marker at or before the target, else the first one. */
export function backFrom(
  markers: WatchMarker[],
  index: number | null,
  seconds = 30,
): number | null {
  if (markers.length === 0) return null
  const current = markers[index ?? markers.length - 1]!
  const target = Date.parse(current.at) - seconds * 1000
  let found = 0
  markers.forEach((marker, at) => {
    if (Date.parse(marker.at) <= target) found = at
  })
  return found
}

export const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
export const clockSeconds = (iso: string) =>
  new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })

export type ActivityItem = {
  key: string
  kind: WatchMarkerKind
  text: string
  at: string
  /** The frame to replay when the item is chosen. */
  seq: number | null
}

/** Newest first: the agent's frame captions plus the questions it put to the person. */
export function activityItems(frames: WatchFrame[], approvals: Approval[]): ActivityItem[] {
  const items: ActivityItem[] = frames.map((frame) => ({
    key: `frame-${frame.seq}`,
    kind: surfaceMarker[frame.surface],
    text: frame.caption,
    at: frame.at,
    seq: frame.seq,
  }))
  for (const approval of approvals) {
    const before = [...frames].reverse().find((frame) => frame.at <= approval.createdAt)
    items.push({
      key: `approval-${approval.id}`,
      kind: 'asked',
      text: `Stopped and asked you: ${approval.title}`,
      at: approval.createdAt,
      seq: before?.seq ?? null,
    })
  }
  return items.sort((a, b) => b.at.localeCompare(a.at) || b.key.localeCompare(a.key))
}

export type DiffLine = { kind: 'add' | 'del' | 'ctx' | 'hunk'; text: string; number: number | null }

/** Unified diff to display lines, numbered from the hunk headers (new-file numbers for context and added lines). */
export function parseDiff(diff: string): DiffLine[] {
  const raws = diff.split('\n')
  if (raws.at(-1) === '') raws.pop()
  const lines: DiffLine[] = []
  let next: number | null = null
  for (const raw of raws) {
    if (/^(---|\+\+\+) /.test(raw) || raw.startsWith('diff ') || raw.startsWith('index ')) continue
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (hunk) {
      next = Number(hunk[1])
      lines.push({ kind: 'hunk', text: raw, number: null })
    } else if (raw.startsWith('+')) {
      lines.push({ kind: 'add', text: raw.slice(1), number: next })
      if (next !== null) next += 1
    } else if (raw.startsWith('-')) {
      lines.push({ kind: 'del', text: raw.slice(1), number: null })
    } else {
      lines.push({ kind: 'ctx', text: raw.startsWith(' ') ? raw.slice(1) : raw, number: next })
      if (next !== null) next += 1
    }
  }
  return lines
}

const plain = /^[\w.@:+-]+$/
const quote = (value: string) => (plain.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`)

/** The command that opens the agent's session in a terminal (`hermes -p <profile> --resume <session>`). */
export function resumeCommand(agentId: string, sessionId: string | null): string {
  return sessionId
    ? `hermes -p ${quote(agentId)} --resume ${quote(sessionId)}`
    : `hermes -p ${quote(agentId)} --continue`
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}
