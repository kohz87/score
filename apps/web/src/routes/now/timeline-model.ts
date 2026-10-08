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
): Connector[] {
  const found = new Map<string, { lane: number; layout: BlockLayout; agent: string }>()
  snapshot.lanes.forEach((lane, index) => {
    for (const block of lane.blocks)
      found.set(block.id, { lane: index, layout: layoutBlock(window, block), agent: lane.agent.id })
  })
  const centerY = (lane: number) => lane * LANE_HEIGHT + BLOCK_TOP + BLOCK_HEIGHT / 2
  const result: Connector[] = []
  for (const handoff of snapshot.handoffs) {
    const from = found.get(handoff.from.blockId)
    const to = found.get(handoff.to.blockId)
    if (!from || !to) continue
    const x1 = (from.layout.left + (from.layout.width ?? 0)) * (VIEWBOX_WIDTH / 100)
    const x2 = to.layout.left * (VIEWBOX_WIDTH / 100)
    const y1 = centerY(from.lane)
    const y2 = centerY(to.lane)
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
      fromLabel: from.layout.block.label,
      toLabel: to.layout.block.label,
    })
  }
  return result
}

export const connectorLabel: Record<Handoff['kind'], string> = {
  handoff: 'Hand-off',
  review: 'Review',
  sent_back: 'Sent back',
}
