import type { SubagentSummary } from '@score/contract'

/** Items that may belong to a sub-agent (a tool part, a log line): a call id and the Agent call they ran under. */
interface Nestable {
  callId?: string | undefined
  parentCallId?: string | undefined
}

/**
 * Splits items into the ones shown in order and the sub-agent calls nested under their Agent call (PLAN 8.7). A call whose
 * parent isn't among the items (an old row, or a parent cut by a limit) stays in the list, flat.
 */
export function nestSubagentCalls<T extends Nestable>(items: readonly T[]) {
  const ids = new Set(items.flatMap((item) => (item.callId ? [item.callId] : [])))
  const children = new Map<string, T[]>()
  const top: T[] = []
  for (const item of items) {
    const parent = item.parentCallId
    if (parent && parent !== item.callId && ids.has(parent)) {
      children.set(parent, [...(children.get(parent) ?? []), item])
    } else top.push(item)
  }
  return { top, children }
}

const STATUS = { running: 'working', done: 'done', failed: 'failed' } as const

/** "Sub-agent · List files in folder · 1 tool call · done" */
export function subagentLine(summary: SubagentSummary, nestedCalls: number): string {
  const calls = summary.toolCalls ?? nestedCalls
  return [
    'Sub-agent',
    summary.description,
    `${calls} tool ${calls === 1 ? 'call' : 'calls'}`,
    STATUS[summary.status],
  ]
    .filter((part) => part !== null && part !== '')
    .join(' · ')
}
