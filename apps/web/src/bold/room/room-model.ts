import type { AgentSummary, Approval, Exchange, ExchangeOption, Job } from '@score/contract'
import { agentDisplayName } from '../bold-agents.ts'

export type JobFilter = 'all' | 'needs' | 'working' | 'done' | 'closed'

export const JOB_FILTERS: { id: JobFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'needs', label: 'Needs you' },
  { id: 'working', label: 'Working' },
  { id: 'done', label: 'Done' },
  { id: 'closed', label: 'Closed jobs' },
]

export function jobMatchesFilter(job: Job, filter: JobFilter): boolean {
  // A closed job leaves the room's tabs until the person asks for the Closed jobs list.
  if (filter === 'all') return job.state !== 'closed'
  if (filter === 'needs') return job.state === 'waiting_on_you'
  if (filter === 'working') return job.state === 'open' || job.state === 'working'
  if (filter === 'done') return job.state === 'done'
  return job.state === 'closed'
}

export function jobStateLabel(job: Job): string {
  if (job.state === 'waiting_on_you') return 'Needs you'
  if (job.state === 'open') return 'Open'
  if (job.state === 'working') return 'Working'
  if (job.state === 'done') return 'Done'
  return 'Closed'
}

/** The one rule for an approval that still waits on the person, shared by the dock, strip and screen. */
export function approvalNeedsYou(approval: Approval): boolean {
  if (approval.phase !== 'human_pending') return false
  if (approval.delivery === 'not_pending' || approval.delivery === 'unknown') return false
  if (approval.delivery === 'intent' || approval.delivery === 'delivering') return true
  if (approval.delivery === 'failed') return true
  if (approval.decision) return false
  return approval.status === 'pending'
}

function agentNames(ids: string[], agents: AgentSummary[]): string {
  const names = ids.map((id) => {
    const agent = agents.find((item) => item.id === id)
    return agent ? agentDisplayName(agent) : id
  })
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/** One line for the phone's job list and chat head, using the agents and state the contract already ships. */
export function jobStateLine(job: Job, agents: AgentSummary[]): string {
  const holder = job.holderAgentId
    ? (() => {
        const agent = agents.find((item) => item.id === job.holderAgentId)
        return agent ? agentDisplayName(agent) : job.holderAgentId
      })()
    : null
  if (job.state === 'waiting_on_you') return holder ? `${holder} needs you` : 'Needs you'
  if (job.state === 'working' || job.state === 'open') {
    const active = agentNames(job.activeAgents, agents)
    if (active) return `${active} ${job.state === 'open' ? 'up next' : 'working'}`
    if (holder) return `${holder} ${job.state === 'open' ? 'is up next' : 'is working'}`
    return jobStateLabel(job)
  }
  const label = jobStateLabel(job)
  return job.summary ? `${label} · ${job.summary}` : label
}

const PAUSE_TITLE: Record<string, string> = {
  exchange_budget: 'The exchange used its turns without agreeing',
  job_limit: 'This job used its turn limit',
  spend_cap: 'This job reached its spend cap',
  cost_unknown: 'A run’s cost is unknown',
  turn_failed: 'A turn failed',
  unreachable: 'An agent could not be reached',
  asker_gone: 'The agent that asked has gone',
  no_decision: 'The review ended without a verdict',
  author_stalled: 'The author stalled',
  question_stopped: 'The question it waited on was stopped',
}

const PAUSE_ASK: Record<string, string> = {
  exchange_budget: 'Give the exchange more turns, let the lead decide, step in, or stop it.',
  job_limit: 'This job is holding more work than its turn limit allows.',
  spend_cap: 'Allow more spend, step in, or stop the work.',
  cost_unknown: 'Continue when the cost can be settled, step in, or stop.',
  turn_failed: 'Try the turn again, reassign it, or stop.',
  unreachable: 'Try to reach the agent again, reassign the turn, or stop.',
  asker_gone: 'Try again, send the answer to the lead, or stop.',
  no_decision: 'Ask the reviewer again, send the work back with a note, or close it.',
  author_stalled: 'Ask for the work again, or close the exchange.',
  question_stopped: 'Continue without the answer, or stop.',
}

export function exchangePauseTitle(exchange: Exchange): string {
  if (!exchange.pause) return 'This exchange needs you'
  return PAUSE_TITLE[exchange.pause.reason] ?? 'This exchange needs you'
}

export function exchangePauseAsk(exchange: Exchange): string {
  if (!exchange.pause) return ''
  return PAUSE_ASK[exchange.pause.reason] ?? 'Choose what happens next.'
}

export function optionLabel(option: ExchangeOption): string {
  switch (option) {
    case 'more_turns':
      return 'Give 4 more turns'
    case 'more_spend':
      return 'Allow more spend'
    case 'continue':
      return 'Continue'
    case 'lead_decides':
      return 'Let lead decide'
    case 'step_in':
      return 'Step in'
    case 'stop':
      return 'Stop'
    case 'retry':
      return 'Try again'
    case 'reassign':
      return 'Reassign'
    case 'answer_to_lead':
      return 'Answer to lead'
    case 'ask_again':
      return 'Ask again'
    case 'send_back':
      return 'Send back'
    case 'close':
      return 'Close'
  }
}

export function needsYou(exchange: Exchange): boolean {
  return Boolean(
    exchange.pause && (exchange.state === 'paused_budget' || exchange.state === 'waiting_on_you'),
  )
}

export function exchangeStatus(exchange: Exchange): string {
  if (exchange.pause) return `round ${exchange.round} · needs your call`
  if (exchange.state === 'done') return `round ${exchange.round} · ${exchange.outcome ?? 'done'}`
  if (exchange.state === 'stopped') return exchange.endedReason ?? 'stopped'
  if (exchange.state === 'waiting_on_agent') return `round ${exchange.round} · waiting`
  return `round ${exchange.round} · working`
}

export function exchangeTurns(exchange: Exchange): string {
  return `${exchange.turnsUsed} of ${exchange.budget} turns`
}

/** Approvals that belong in this room's Needs-you strip: open and either unaddressed or addressed to this room. */
export function roomApprovals(approvals: Approval[], roomId: string): Approval[] {
  return approvals.filter(
    (approval) => approvalNeedsYou(approval) && approvalInRoom(approval, roomId),
  )
}

/** An approval names every room its run touched; it belongs elsewhere only when it names rooms and none is this one. */
export function approvalInRoom(approval: Pick<Approval, 'refs'>, roomId: string): boolean {
  const rooms = approval.refs.flatMap((ref) => (ref.kind === 'room' ? [ref.roomId] : []))
  return rooms.length === 0 || rooms.includes(roomId)
}

export function approvalPointerSet(approvals: Approval[], roomId: string): Set<string> {
  return new Set(roomApprovals(approvals, roomId).map((approval) => approval.id))
}

/** The prototype's expand chip: the first card stays visible, the rest wait behind its count. */
export function pinsMoreLabel(count: number, expanded: boolean): string | null {
  if (count <= 1) return null
  if (expanded) return 'Show fewer'
  return `${count - 1} more need${count === 2 ? 's' : ''} you`
}

/** Jobs whose finished result waits on the person to send it back. A closed job asks nothing until it is reopened. */
export function reportBackWaiting(jobs: readonly Job[]): Job[] {
  return jobs.filter(
    (job) =>
      job.state !== 'closed' &&
      (job.reportBack?.state === 'needs_ok' || job.reportBack?.state === 'not_confirmed'),
  )
}
