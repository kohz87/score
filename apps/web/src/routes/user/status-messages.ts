import type { OrchEvent } from '@score/contract'

export type StatusTone = 'info' | 'need' | 'ok' | 'fail'
export interface StatusMessage {
  /** The event's id: stable across reads, so React keys and tests can rely on it. */
  id: string
  at: string
  tone: StatusTone
  text: string
}

export interface StatusContext {
  /** The agent that holds a step, by step id. */
  stepAgent: (stepId: string) => string | null
}

const endText: Record<string, [StatusTone, string]> = {
  succeeded: ['ok', 'The run finished.'],
  failed: ['fail', 'The run failed.'],
  stopped: ['info', 'The run was stopped.'],
  finished_with_unresolved: [
    'fail',
    'The run finished, but not everything was confirmed as ended.',
  ],
}

function stepName(event: OrchEvent, context: StatusContext): string {
  if (!event.stepId) return 'A step'
  const agent = context.stepAgent(event.stepId)
  return agent ? `Step ${event.stepId} (${agent})` : `Step ${event.stepId}`
}

function one(event: OrchEvent, context: StatusContext): StatusMessage | null {
  const make = (tone: StatusTone, text: string): StatusMessage => ({
    id: event.id,
    at: event.at,
    tone,
    text,
  })
  switch (event.kind) {
    case 'run_started':
      return make('info', 'The run started.')
    case 'step_admitted':
      return make('info', `${stepName(event, context)} started.`)
    case 'step_result':
      return event.verdict === 'succeeded'
        ? make('ok', `${stepName(event, context)} finished.`)
        : make('fail', `${stepName(event, context)} failed.`)
    case 'step_state':
      if (event.verdict === 'blocked')
        return make('need', `${stepName(event, context)} is blocked.`)
      if (event.verdict === 'abandoned')
        return make('info', `${stepName(event, context)} was given up on.`)
      return make('need', `${stepName(event, context)} isn’t confirmed as ended.`)
    case 'gate_opened':
      return make('need', `Waiting for you: approve ${event.stepId ?? 'a step'}.`)
    case 'gate_decided':
      if (event.verdict === 'approved')
        return make('info', `You approved ${event.stepId ?? 'a step'}.`)
      if (event.verdict === 'rejected')
        return make('info', `You rejected ${event.stepId ?? 'a step'}.`)
      return null
    case 'inquiry_opened':
      return make('need', 'Waiting for you: the lead has a question.')
    case 'inquiry_answered':
      return make('info', 'You answered the lead’s question.')
    case 'control':
      switch (event.verdict) {
        case 'paused':
          return make(
            'info',
            /by you/.test(event.summary) ? 'You paused the run.' : 'The run paused.',
          )
        case 'resumed':
          return make('info', 'The run resumed.')
        case 'stop_requested':
          return make('info', 'Stopping the run.')
        case 'finish_requested':
          return make('info', 'The lead says it is done.')
        case 'limits_changed':
          return make('info', 'The limits were changed.')
        case 'ended': {
          const status = /^Run ended: (\w+)/.exec(event.summary)?.[1] ?? ''
          const [tone, text] = endText[status] ?? ['info', 'The run ended.']
          return make(tone, text)
        }
        default:
          return null
      }
    default:
      // lead turns and the lead's tool calls are the lead's own work, not news for the person.
      return null
  }
}

/**
 * What an orchestration's recorded events say, as short lines for the chat (PLAN 8.4). Pure: it only reads the events
 * the server already lists, and its output is drawn in the user view and never stored or sent anywhere.
 */
export function statusMessages(
  events: readonly OrchEvent[],
  context: StatusContext = { stepAgent: () => null },
): StatusMessage[] {
  return events
    .flatMap((event) => {
      const message = one(event, context)
      return message ? [message] : []
    })
    .sort((a, b) => a.at.localeCompare(b.at))
}
