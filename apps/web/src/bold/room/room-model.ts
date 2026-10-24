import type { Exchange, ExchangeOption, Job } from '@score/contract'

export type JobFilter = 'all' | 'needs' | 'working' | 'done'

export const JOB_FILTERS: { id: JobFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'needs', label: 'Needs you' },
  { id: 'working', label: 'Working' },
  { id: 'done', label: 'Done' },
]

export function jobMatchesFilter(job: Job, filter: JobFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'needs') return job.state === 'waiting_on_you'
  if (filter === 'working') return job.state === 'open' || job.state === 'working'
  return job.state === 'done' || job.state === 'closed'
}

export function jobStateLabel(job: Job): string {
  if (job.state === 'waiting_on_you') return 'Needs you'
  if (job.state === 'open') return 'Open'
  if (job.state === 'working') return 'Working'
  if (job.state === 'done') return 'Done'
  return 'Closed'
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
