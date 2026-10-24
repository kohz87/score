import { expect, test } from 'vitest'
import type { Exchange, ExchangeOption, Job } from '@score/contract'
import {
  approvalInRoom,
  exchangePauseAsk,
  exchangePauseTitle,
  exchangeStatus,
  exchangeTurns,
  jobMatchesFilter,
  jobStateLabel,
  needsYou,
  optionLabel,
  pinsMoreLabel,
} from './room-model.ts'
import { makeExchange, makeJob } from './room-test-utils.tsx'

const job = (state: Job['state']) => makeJob({ state })

test('the D10 filters split jobs by the state the person sees', () => {
  expect(jobMatchesFilter(job('open'), 'working')).toBe(true)
  expect(jobMatchesFilter(job('working'), 'working')).toBe(true)
  expect(jobMatchesFilter(job('waiting_on_you'), 'needs')).toBe(true)
  expect(jobMatchesFilter(job('done'), 'done')).toBe(true)
  expect(jobMatchesFilter(job('closed'), 'done')).toBe(true)
  for (const filter of ['needs', 'working', 'done'] as const)
    expect(jobMatchesFilter(job('open'), filter)).toBe(filter === 'working')
  expect(jobMatchesFilter(job('waiting_on_you'), 'all')).toBe(true)
  expect(jobMatchesFilter(job('done'), 'all')).toBe(true)
})

test('job state labels name the four states and closed', () => {
  expect(jobStateLabel(job('waiting_on_you'))).toBe('Needs you')
  expect(jobStateLabel(job('open'))).toBe('Open')
  expect(jobStateLabel(job('working'))).toBe('Working')
  expect(jobStateLabel(job('done'))).toBe('Done')
  expect(jobStateLabel(job('closed'))).toBe('Closed')
})

test('a paused exchange needs you in both paused states, but a pause without a pause object does not', () => {
  expect(needsYou(makeExchange())).toBe(true)
  expect(needsYou(makeExchange({ state: 'waiting_on_you' }))).toBe(true)
  expect(needsYou(makeExchange({ pause: null }))).toBe(false)
  expect(needsYou(makeExchange({ pause: null, state: 'live' }))).toBe(false)
})

test('pause copy explains the reason, with a safe fallback for an unknown one', () => {
  expect(exchangePauseTitle(makeExchange())).toBe('The exchange used its turns without agreeing')
  expect(exchangePauseAsk(makeExchange())).toBe(
    'Give the exchange more turns, let the lead decide, step in, or stop it.',
  )
  const unknown = makeExchange({
    pause: {
      reason: 'a_reason_from_the_future' as NonNullable<Exchange['pause']>['reason'],
      options: ['stop'],
    },
  })
  expect(exchangePauseTitle(unknown)).toBe('This exchange needs you')
  expect(exchangePauseAsk(unknown)).toBe('Choose what happens next.')
  expect(exchangePauseTitle(makeExchange({ pause: null }))).toBe('This exchange needs you')
  expect(exchangePauseAsk(makeExchange({ pause: null }))).toBe('')
})

test('every exchange option has the prototype’s button label', () => {
  const labels: Record<ExchangeOption, string> = {
    more_turns: 'Give 4 more turns',
    more_spend: 'Allow more spend',
    continue: 'Continue',
    lead_decides: 'Let lead decide',
    step_in: 'Step in',
    stop: 'Stop',
    retry: 'Try again',
    reassign: 'Reassign',
    answer_to_lead: 'Answer to lead',
    ask_again: 'Ask again',
    send_back: 'Send back',
    close: 'Close',
  }
  for (const [option, label] of Object.entries(labels))
    expect(optionLabel(option as ExchangeOption)).toBe(label)
})

test('capsule status and turns read from the exchange, not from its job', () => {
  expect(exchangeTurns(makeExchange())).toBe('8 of 8 turns')
  expect(exchangeStatus(makeExchange())).toBe('round 1 · needs your call')
  const done: Exchange = makeExchange({
    pause: null,
    state: 'done',
    outcome: 'approved',
    round: 3,
  })
  expect(exchangeStatus(done)).toBe('round 3 · approved')
  expect(exchangeStatus(makeExchange({ pause: null, state: 'stopped', endedReason: 'you' }))).toBe(
    'you',
  )
  expect(exchangeStatus(makeExchange({ pause: null, state: 'waiting_on_agent', round: 2 }))).toBe(
    'round 2 · waiting',
  )
  expect(exchangeStatus(makeExchange({ pause: null, state: 'live', round: 2 }))).toBe(
    'round 2 · working',
  )
})

test('the pins chip uses the prototype’s singular and plural count', () => {
  expect(pinsMoreLabel(0, false)).toBeNull()
  expect(pinsMoreLabel(1, false)).toBeNull()
  expect(pinsMoreLabel(2, false)).toBe('1 more needs you')
  expect(pinsMoreLabel(3, false)).toBe('2 more need you')
  expect(pinsMoreLabel(3, true)).toBe('Show fewer')
})

test('an approval belongs to every room its run touched, and to every room when it names none', () => {
  const room = (roomId: string) => ({ kind: 'room' as const, roomId })
  expect(approvalInRoom({ refs: [room('a'), room('b')] }, 'a')).toBe(true)
  expect(approvalInRoom({ refs: [room('a'), room('b')] }, 'b')).toBe(true)
  expect(approvalInRoom({ refs: [room('b')] }, 'a')).toBe(false)
  expect(approvalInRoom({ refs: [] }, 'a')).toBe(true)
})
