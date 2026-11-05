import type { Approval, Exchange, ExchangeOption, Job, Room } from '@score/contract'

export function jobStateLabel(job: Job): string {
  // 3.30.1: the agents are done and it is the person's move; a decision is `needsYou`, not this state.
  if (job.state === 'waiting_on_you') return job.needsYou ? 'Needs you' : 'Your turn'
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

/** Jobs whose finished result waits on the person to send it back. A closed job asks nothing until it is reopened. */
export function reportBackWaiting(jobs: readonly Job[]): Job[] {
  return jobs.filter(
    (job) =>
      job.state !== 'closed' &&
      (job.reportBack?.state === 'needs_ok' || job.reportBack?.state === 'not_confirmed'),
  )
}

/** The first team room (every ready agent, always on). A chosen team has `everyone: false`; a server that omits it sent the first. */
export function isEveryoneRoom(room: Pick<Room, 'role' | 'everyone'>): boolean {
  return room.role === 'team' && room.everyone !== false
}

/** A job that still runs in its chat: not the chat's own thread, not done or closed (one job per chat, 3.28.0). */
export function isActiveJob(job: Job): boolean {
  return (
    !job.isDefault &&
    (job.state === 'open' || job.state === 'working' || job.state === 'waiting_on_you')
  )
}

/** The chat's active jobs, newest first. One in a chat that follows the rule; several only in an older chat. */
export function activeJobs(jobs: readonly Job[]): Job[] {
  return jobs.filter(isActiveJob).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** The job a group chat is doing now; null when none runs, or when an older chat holds several (no single answer). */
export function theActiveJob(jobs: readonly Job[]): Job | null {
  const active = activeJobs(jobs)
  return active.length === 1 ? (active[0] ?? null) : null
}

/** An older chat that still holds several active jobs keeps topic-style dividers and "in <job>" until they end. */
export function holdsSeveralJobs(jobs: readonly Job[]): boolean {
  return activeJobs(jobs).length > 1
}
