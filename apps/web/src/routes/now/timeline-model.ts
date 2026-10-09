import type { Handoff, LaneBlock, NowSnapshot } from '@score/contract'

export const HOUR = 3_600_000
/** The design's view (now-score.png): an hour back, half an hour ahead. The server sends a wider window; blocks are clipped. */
export const WINDOW_BEFORE = HOUR
export const WINDOW_AFTER = HOUR / 2
export const LANE_HEIGHT = 76
export const BLOCK_TOP = 18
export const BLOCK_HEIGHT = 40
const PLANNED_DEFAULT = 20 * 60_000
const VIEWBOX_WIDTH = 1000

export type TimeWindow = { from: number; to: number; now: number }

export function windowOf(nowIso: string): TimeWindow {
  const now = Date.parse(nowIso)
  return { from: now - WINDOW_BEFORE, to: now + WINDOW_AFTER, now }
}

export function percent(window: TimeWindow, time: number): number {
  const value = ((time - window.from) / (window.to - window.from)) * 100
  return Math.min(100, Math.max(0, value))
}

export function clockLabel(time: number): string {
  return new Date(time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

/** Quarter-hour marks inside the window, labelled in local time. */
export function axisTicks(window: TimeWindow): { left: number; label: string }[] {
  const step = HOUR / 4
  const ticks: { left: number; label: string }[] = []
  // Local time zones with a 30/45 minute offset still land on quarter-hour local marks.
  const offset = new Date(window.from).getTimezoneOffset() * 60_000
  for (let t = Math.ceil((window.from - offset) / step) * step + offset; t <= window.to; t += step)
    ticks.push({ left: percent(window, t), label: clockLabel(t) })
  // The now label sits on the axis; a tick under it would only be noise.
  const nowLeft = percent(window, window.now)
  return ticks.filter((tick) => Math.abs(tick.left - nowLeft) > 4)
}

export type BlockLayout = {
  block: LaneBlock
  left: number
  width: number | null
  /** A waiting block is a pill at the now line: its start is in the past but the wait is open-ended. */
  atNow: boolean
}

export function layoutBlock(window: TimeWindow, block: LaneBlock): BlockLayout {
  const start = Date.parse(block.start)
  if (block.state === 'waiting')
    return { block, left: percent(window, window.now), width: null, atNow: true }
  const end =
    block.end !== null
      ? Date.parse(block.end)
      : block.state === 'planned'
        ? start + PLANNED_DEFAULT
        : window.now
  const left = percent(window, start)
  return {
    block,
    left,
    width: Math.max(percent(window, Math.max(end, start)) - left, 0),
    atNow: false,
  }
}

/** Chat replies are a thin band under the lane's task blocks. */
export const CHAT_BAND_TOP = 63
export const CHAT_BAND_HEIGHT = 8
/** Task blocks narrower than this, or overlapping each other, are grouped into one block that opens a list. */
export const MIN_BLOCK_PX = 28

export type LaneItem =
  | { kind: 'block'; layout: BlockLayout }
  | { kind: 'chat'; layout: BlockLayout }
  | { kind: 'group'; layout: BlockLayout; blocks: LaneBlock[] }

/** True for a block whose whole interval lies outside the view: layout would clamp it to a zero-width sliver. */
function outsideWindow(window: TimeWindow, block: LaneBlock): boolean {
  if (block.state === 'waiting') return false
  const start = Date.parse(block.start)
  const end =
    block.end !== null
      ? Date.parse(block.end)
      : block.state === 'planned'
        ? start + PLANNED_DEFAULT
        : window.now
  return Math.max(end, start) < window.from || start > window.to
}

const URGENCY: LaneBlock['state'][] = ['waiting', 'working', 'planned', 'done']

/**
 * What one lane draws. Chat bands sit apart from the task row. Task and brief blocks that would overlap, or that sit
 * closer than `MIN_BLOCK_PX` once short ones are widened to it, form a cluster of two or more and become one counted
 * group; a lone short block stays itself. A block waiting on the person is never grouped: it must stay findable.
 */
export function laneItems(window: TimeWindow, blocks: LaneBlock[], plotPx: number): LaneItem[] {
  const items: LaneItem[] = []
  const candidates: BlockLayout[] = []
  for (const block of blocks) {
    if (outsideWindow(window, block)) continue
    const layout = layoutBlock(window, block)
    if (block.kind === 'chat' && block.state !== 'waiting') items.push({ kind: 'chat', layout })
    else if (block.state === 'waiting') items.push({ kind: 'block', layout })
    else candidates.push(layout)
  }
  const px = (percentValue: number) => (percentValue / 100) * plotPx
  candidates.sort((a, b) => a.left - b.left || a.block.id.localeCompare(b.block.id))
  let cluster: BlockLayout[] = []
  let clusterEnd = -Infinity
  const flush = () => {
    if (cluster.length === 1) items.push({ kind: 'block', layout: cluster[0]! })
    else if (cluster.length > 1) items.push(groupOf(cluster))
    cluster = []
  }
  for (const layout of candidates) {
    const start = px(layout.left)
    // A hair of tolerance: back-to-back runs meet at the same instant and must not read as overlapping.
    if (cluster.length > 0 && start >= clusterEnd - 0.5) flush()
    if (cluster.length === 0) clusterEnd = -Infinity
    cluster.push(layout)
    clusterEnd = Math.max(clusterEnd, start + Math.max(px(layout.width ?? 0), MIN_BLOCK_PX))
  }
  flush()
  return items.sort((a, b) => a.layout.left - b.layout.left)
}

function groupOf(cluster: BlockLayout[]): LaneItem {
  const blocks = cluster.map((layout) => layout.block)
  const left = Math.min(...cluster.map((layout) => layout.left))
  const right = Math.max(...cluster.map((layout) => layout.left + (layout.width ?? 0)))
  const state = URGENCY.find((candidate) => blocks.some((block) => block.state === candidate))!
  const first = blocks.toSorted(
    (a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id),
  )[0]!
  const block: LaneBlock = {
    id: `group:${first.id}`,
    label: `${blocks.length} tasks`,
    state,
    start: first.start,
    end: null,
    taskId: null,
    runId: null,
    kind: 'task',
  }
  return { kind: 'group', blocks, layout: { block, left, width: right - left, atNow: false } }
}

export type Connector = {
  id: string
  kind: Handoff['kind']
  d: string
  /** Position of the label in percent of the plot. */
  labelLeft: number
  labelTop: number
  fromAgentId: string
  toAgentId: string
  fromLabel: string
  toLabel: string
}

export function connectors(
  snapshot: Pick<NowSnapshot, 'lanes' | 'handoffs'>,
  window: TimeWindow,
  plotPx = VIEWBOX_WIDTH,
): Connector[] {
  const found = new Map<
    string,
    { lane: number; layout: BlockLayout; agent: string; chat: boolean; label: string }
  >()
  snapshot.lanes.forEach((lane, index) => {
    for (const item of laneItems(window, lane.blocks, plotPx)) {
      // A grouped block's hand-offs attach to the group.
      const members = item.kind === 'group' ? item.blocks : [item.layout.block]
      for (const block of members)
        found.set(block.id, {
          lane: index,
          layout: item.layout,
          agent: lane.agent.id,
          chat: item.kind === 'chat',
          label: block.label,
        })
    }
  })
  const centerY = (lane: number, chat: boolean) =>
    lane * LANE_HEIGHT +
    (chat ? CHAT_BAND_TOP + CHAT_BAND_HEIGHT / 2 : BLOCK_TOP + BLOCK_HEIGHT / 2)
  const result: Connector[] = []
  for (const handoff of snapshot.handoffs) {
    const from = found.get(handoff.from.blockId)
    const to = found.get(handoff.to.blockId)
    if (!from || !to) continue
    const x1 = (from.layout.left + (from.layout.width ?? 0)) * (VIEWBOX_WIDTH / 100)
    const x2 = to.layout.left * (VIEWBOX_WIDTH / 100)
    const y1 = centerY(from.lane, from.chat)
    const y2 = centerY(to.lane, to.chat)
    // Horizontal tangents at both ends, like the design's short S-curves.
    const dx = Math.max(8, Math.abs(x2 - x1) / 2)
    result.push({
      id: handoff.id,
      kind: handoff.kind,
      d: `M${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
      labelLeft: (x1 + x2) / 2 / (VIEWBOX_WIDTH / 100),
      labelTop: (y1 + y2) / 2,
      fromAgentId: from.agent,
      toAgentId: to.agent,
      fromLabel: from.label,
      toLabel: to.label,
    })
  }
  return result
}

export const connectorLabel: Record<Handoff['kind'], string> = {
  handoff: 'Hand-off',
  review: 'Review',
  sent_back: 'Sent back',
}
