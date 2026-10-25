import { expect, test } from 'vitest'
import type { Approval, Exchange, ExchangeOption, Job } from '@score/contract'
import {
  approvalInRoom,
  approvalNeedsYou,
  exchangePauseAsk,
  exchangePauseTitle,
  exchangeStatus,
  exchangeTurns,
  jobMatchesFilter,
  jobStateLabel,
  jobStateLine,
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
  expect(jobMatchesFilter(job('closed'), 'closed')).toBe(true)
  expect(jobMatchesFilter(job('closed'), 'done')).toBe(false)
  expect(jobMatchesFilter(job('closed'), 'all')).toBe(false)
  for (const filter of ['needs', 'working', 'done', 'closed'] as const)
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

test('a job’s phone state line names who holds working and waiting jobs, or the summary when done', () => {
  const agents = [
    {
      id: 'builder',
      name: 'builder',
      role: '',
      style: { color: '#19C39A', shape: 'triangle' as const },
      status: 'working' as const,
      activity: null,
      model: { id: 'fake', label: 'Demo' },
      served: true,
    },
    {
      id: 'reviewer',
      name: 'reviewer',
      role: '',
      style: { color: '#FFB61E', shape: 'diamond' as const },
      status: 'idle' as const,
      activity: null,
      model: { id: 'fake', label: 'Demo' },
      served: true,
    },
  ]
  expect(jobStateLine(makeJob({ holderAgentId: 'builder' }), agents)).toBe('builder is working')
  expect(
    jobStateLine(makeJob({ holderAgentId: 'builder' }), [{ ...agents[0]!, name: '' }, agents[1]!]),
  ).toBe('builder is working')
  expect(jobStateLine(makeJob({ activeAgents: ['builder', 'reviewer'] }), agents)).toBe(
    'builder and reviewer working',
  )
  expect(jobStateLine(makeJob({ state: 'waiting_on_you' }), agents)).toBe('builder needs you')
  expect(jobStateLine(makeJob({ state: 'done', summary: 'One clear pick' }), agents)).toBe(
    'Done · One clear pick',
  )
  expect(jobStateLine(makeJob({ state: 'open', holderAgentId: null }), agents)).toBe('Open')
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

test('one approval rule: human-pending, still waiting, and not already decided', () => {
  const approval: Approval = {
    id: 'approval-rule',
    origin: 'score-run',
    phase: 'human_pending',
    status: 'pending',
    actionable: true,
    linkedTo: null,
    agentId: 'builder',
    title: 'May I?',
    command: 'npm test',
    cwd: '~/app',
    description: '',
    choices: ['once', 'deny'],
    createdAt: '2026-10-24T09:00:00.000Z',
    expiresAt: null,
    decision: null,
    delivery: 'none',
    blocking: null,
    refs: [],
  }
  expect(approvalNeedsYou(approval)).toBe(true)
  // An approval answered elsewhere still needs the person; the strip says where, and the badge counts it.
  expect(approvalNeedsYou({ ...approval, actionable: false })).toBe(true)
  expect(approvalNeedsYou({ ...approval, phase: 'guardian_evaluating' })).toBe(false)
  expect(approvalNeedsYou({ ...approval, delivery: 'intent' })).toBe(true)
  expect(approvalNeedsYou({ ...approval, delivery: 'delivering' })).toBe(true)
  expect(approvalNeedsYou({ ...approval, delivery: 'failed' })).toBe(true)
  expect(approvalNeedsYou({ ...approval, delivery: 'not_pending' })).toBe(false)
  expect(approvalNeedsYou({ ...approval, delivery: 'unknown' })).toBe(false)
  expect(
    approvalNeedsYou({
      ...approval,
      decision: { choice: 'once', by: 'you', at: '2026-10-24T09:01:00.000Z' },
    }),
  ).toBe(false)
  expect(approvalNeedsYou({ ...approval, status: 'approved' })).toBe(false)
})
