import type { AgentSubagents, Job, Message, SubagentRow } from '@score/contract'

/** How a job's subagents stand, in the few numbers every surface names. */
export type SubagentCounts = {
  total: number
  done: number
  failed: number
  running: number
  waiting: number
}

export function subagentCounts(rows: readonly SubagentRow[]): SubagentCounts {
  return {
    total: rows.length,
    done: rows.filter((row) => row.state === 'done').length,
    failed: rows.filter((row) => row.state === 'failed').length,
    running: rows.filter((row) => row.state === 'running' && !row.waitingOnYou).length,
    waiting: rows.filter((row) => row.waitingOnYou).length,
  }
}

/** "3 of 4 done", the card's and the job's one sentence. */
export function subagentDoneText(rows: readonly SubagentRow[]): string {
  const counts = subagentCounts(rows)
  return `${counts.done} of ${counts.total} done`
}

/** "3 of 4 subagents done" for the job's line. */
export function subagentJobLine(rows: readonly SubagentRow[]): string | null {
  const counts = subagentCounts(rows)
  return rows.length > 0 ? `${counts.done} of ${counts.total} subagents done` : null
}

const money = (usd: number) => `$${usd.toFixed(2)}`

/**
 * Their cost so far: dollars when any row has them ("at least" while a finished row has none), else tokens, else an
 * unknown dash. Never $0 for unknown.
 */
export function subagentCostText(rows: readonly SubagentRow[]): string {
  const dollars = rows.filter(
    (row): row is SubagentRow & { costUsd: number } => row.costUsd !== null,
  )
  if (dollars.length > 0) {
    // A finished row with no figure means the total is only a floor.
    const floor = rows.some((row) => row.state !== 'running' && row.costUsd === null)
    const total = money(dollars.reduce((sum, row) => sum + row.costUsd, 0))
    return floor ? `at least ${total}` : `about ${total}`
  }
  const tokens = rows.reduce((sum, row) => sum + (row.tokens ?? 0), 0)
  return tokens > 0 ? `${new Intl.NumberFormat().format(tokens)} tokens` : '—'
}

/** A row's one extra fact: how long it took, what it cost, or why it is still here. */
export function subagentRowMeta(row: SubagentRow): string {
  if (row.waitingOnYou) return 'needs you'
  if (row.state === 'running') return 'working'
  if (row.endedAt) {
    const seconds = Math.max(
      0,
      Math.round((Date.parse(row.endedAt) - Date.parse(row.startedAt)) / 1000),
    )
    return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`
  }
  return row.costUsd === null ? '' : money(row.costUsd)
}

/** The row's state in the mock-up's words; waiting outranks running because it is the person's turn. */
export function subagentRowState(row: SubagentRow): 'Done' | 'Waiting' | 'Failed' | 'Working' {
  if (row.waitingOnYou) return 'Waiting'
  if (row.state === 'done') return 'Done'
  if (row.state === 'failed') return 'Failed'
  return 'Working'
}

/** The context bar's label, from the job's narrowing limit and, when it is null, the agent's own ceiling. */
export function subagentControlLabel(
  job: Pick<Job, 'subagents'>,
  agent: Pick<AgentSubagents, 'maxConcurrent' | 'control'> | undefined,
): string {
  const limits = job.subagents
  if (!limits || !limits.enabled) return 'Subagents: off'
  // Claude Code decides how many run at once: there is no number to show.
  if (agent?.control === 'on_off') return 'Subagents: on'
  const limit = limits.maxConcurrent ?? agent?.maxConcurrent ?? null
  if (limit === null) return 'Subagents: on'
  return `Subagents: ${limits.maxConcurrent === null ? 'up to ' : ''}${limit}`
}

export function subagentAtOnceText(
  job: Pick<Job, 'subagents'>,
  agent: Pick<AgentSubagents, 'maxConcurrent'> | undefined,
): string {
  const limits = job.subagents
  if (!limits || !limits.enabled) return 'off'
  const limit = limits.maxConcurrent ?? agent?.maxConcurrent ?? null
  if (limit === null) return 'on'
  return limits.maxConcurrent === null ? `up to ${limit}` : String(limit)
}

type AgentMessage = Pick<Message, 'id' | 'jobId' | 'author' | 'createdAt' | 'parts'>

/**
 * Attach each subagent row to the message that started it: its parent agent's latest message in the row's job at or
 * before the row's start, else that agent's first message in the job. A row whose agent has no message in its job yet
 * stays out until one exists. The contract has no message id on a row, so this is the closest honest place. Only a
 * message with text the agent wrote takes a card: an approval card is an agent message with no text part.
 */
export function attachSubagentRows(
  rows: readonly SubagentRow[],
  messages: readonly AgentMessage[],
): Map<string, SubagentRow[]> {
  const byAgent = new Map<string, AgentMessage[]>()
  for (const message of messages) {
    if (message.author.kind !== 'agent') continue
    if (!message.parts.some((part) => part.kind === 'text')) continue
    const key = `${message.jobId}\n${message.author.agentId}`
    byAgent.set(key, [...(byAgent.get(key) ?? []), message])
  }
  for (const list of byAgent.values())
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  const attached = new Map<string, SubagentRow[]>()
  for (const row of [...rows].sort(
    (a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id),
  )) {
    const sameAgent = byAgent.get(`${row.jobId}\n${row.agentId}`) ?? []
    const before = sameAgent.filter((message) => message.createdAt <= row.startedAt)
    const target = before.at(-1) ?? sameAgent[0]
    if (!target) continue
    attached.set(target.id, [...(attached.get(target.id) ?? []), row])
  }
  return attached
}
