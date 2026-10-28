import type { AgentSummary, OrchestrationDetail, VoteView } from '@score/contract'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { HelpersCard } from './HelpersCard.tsx'
import { leadSteps } from './orch-model.ts'

afterEach(cleanup)

const agents = [
  { id: 'builder', name: 'builder', style: { color: '#3355ff', shape: 'circle-dot' } },
] as unknown as AgentSummary[]

const vote = (over: Partial<VoteView>): VoteView => ({
  id: 'v1',
  question: 'Which library?',
  options: ['alpha', 'beta'],
  k: 3,
  status: 'sharp',
  counts: [3, 0],
  choice: 0,
  share: 1,
  inquiryId: null,
  createdAt: '2026-10-27T09:00:00.000Z',
  ...over,
})
const helpers = (votes: VoteView[], over = {}): OrchestrationDetail['helpers'] => ({
  agentIds: ['builder'],
  maxConcurrent: 3,
  maxSteps: 20,
  used: 5,
  scan: false,
  scanFolder: null,
  splitTo: 'lead',
  votes,
  ...over,
})

test('nothing renders without helpers', () => {
  const { container } = render(<HelpersCard run={{ helpers: null }} agents={agents} />)
  expect(container.textContent).toBe('')
})

test('shows the helpers, limits and the scan folder', () => {
  render(
    <HelpersCard
      run={{ helpers: helpers([], { scan: true, scanFolder: '/work/app' }) }}
      agents={agents}
    />,
  )
  expect(screen.getByText(/5 of 20 helper steps, up to 3 at once/)).toBeDefined()
  expect(screen.getByText(/Scanned first: \/work\/app/)).toBeDefined()
  expect(screen.queryByText('Votes')).toBeNull()
})

test('a sharp vote highlights the chosen option', () => {
  const { container } = render(
    <HelpersCard run={{ helpers: helpers([vote({})]) }} agents={agents} />,
  )
  expect(screen.getByText('Sharp')).toBeDefined()
  expect(container.querySelectorAll('.orch-vote-option--chosen')).toHaveLength(1)
  expect(container.querySelector('.orch-vote-option--chosen')!.textContent).toContain('alpha')
})

test('voting, split (asked you) and failed votes', () => {
  const { container } = render(
    <HelpersCard
      run={{
        helpers: helpers([
          vote({ id: 'a', status: 'voting', counts: [1, 0], choice: null, share: null }),
          vote({
            id: 'b',
            status: 'split',
            counts: [2, 2],
            choice: null,
            share: 0.5,
            inquiryId: 'inq_1',
          }),
          vote({ id: 'c', status: 'failed', counts: [0, 0], choice: null, share: null }),
        ]),
      }}
      agents={agents}
    />,
  )
  expect(screen.getByText('Voting')).toBeDefined()
  expect(screen.getByText('Split')).toBeDefined()
  expect(screen.getByText('asked you')).toBeDefined()
  expect(screen.getByText('No usable answers')).toBeDefined()
  expect(container.querySelector('.orch-vote-option--chosen')).toBeNull()
})

test('vote steps are dropped from the step lists, helper steps stay', () => {
  const steps = [
    { id: 's1', role: null },
    { id: 's2', role: 'helper' },
    { id: 's3', role: 'vote' },
    { id: 's4', role: 'advisor' },
  ]
  expect(leadSteps(steps).map((step) => step.id)).toEqual(['s1', 's2'])
})

test('shows who votes when voters are set', () => {
  const { container } = render(
    <HelpersCard run={{ helpers: helpers([], { voterIds: ['builder'] }) }} agents={agents} />,
  )
  expect(container.textContent).toContain('Votes:')
  expect(container.textContent).toContain('builder')
})

test('no voters line when voterIds is empty', () => {
  const { container } = render(
    <HelpersCard run={{ helpers: helpers([], { voterIds: [] }) }} agents={agents} />,
  )
  expect(container.textContent).not.toContain('Votes:')
})

test('no limit, the automatic options and a vote about a step (3.14)', () => {
  render(
    <HelpersCard
      run={{
        helpers: helpers([vote({ stepId: 's3' })], {
          maxSteps: null,
          used: 7,
          autoVote: true,
          autoVoteK: 5,
          autoAudit: true,
        }),
      }}
      agents={agents}
    />,
  )
  expect(screen.getByText(/7 helper steps used, no limit/)).toBeDefined()
  expect(screen.getByText(/Votes on every step \(5 voters\)/)).toBeDefined()
  expect(screen.getByText(/Audits every step/)).toBeDefined()
  expect(screen.getByText('about s3')).toBeDefined()
})
