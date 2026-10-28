import type { AdvisorConsultView, AgentSummary } from '@score/contract'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { AdvisorCard } from './AdvisorCard.tsx'

afterEach(cleanup)

const consult = (over: Partial<AdvisorConsultView>): AdvisorConsultView => ({
  stepId: 'a1',
  checkpoint: 'before_plan',
  reason: '',
  status: 'succeeded',
  advice: 'Split it in two.',
  createdAt: '2026-10-27T09:00:00.000Z',
  ...over,
})
const agents = [
  { id: 'reviewer', name: 'reviewer', style: { color: '#3355ff', shape: 'circle-dot' } },
] as unknown as AgentSummary[]

test('nothing renders without an advisor', () => {
  const { container } = render(<AdvisorCard run={{ advisor: null }} agents={agents} />)
  expect(container.textContent).toBe('')
})

test('shows the advisor, each checkpoint, status, reason and advice', () => {
  render(
    <AdvisorCard
      run={{
        advisor: {
          agentId: 'reviewer',
          consults: [
            consult({}),
            consult({
              stepId: 'a2',
              checkpoint: 'repeat_failure',
              reason: 'The test failed twice',
              status: 'admitted',
              advice: null,
            }),
            consult({ stepId: 'a3', checkpoint: 'before_done', status: 'failed', advice: null }),
          ],
        },
      }}
      agents={agents}
    />,
  )
  expect(screen.getByText('reviewer')).toBeDefined()
  expect(screen.getByText('Before the plan')).toBeDefined()
  expect(screen.getByText('Same failure twice')).toBeDefined()
  expect(screen.getByText('Before it finishes')).toBeDefined()
  expect(screen.getByText('Advice given')).toBeDefined()
  expect(screen.getByText('Looking')).toBeDefined()
  expect(screen.getByText('Failed')).toBeDefined()
  expect(screen.getByText('The test failed twice')).toBeDefined()
  expect(screen.getByText('Split it in two.')).toBeDefined()
})

test('an advisor never asked says so', () => {
  render(<AdvisorCard run={{ advisor: { agentId: 'reviewer', consults: [] } }} agents={agents} />)
  expect(screen.getByText('It has not been asked yet.')).toBeDefined()
})

test('shows the mode and what the workers asked while they worked (3.15)', () => {
  render(
    <AdvisorCard
      run={{
        advisor: {
          agentId: 'reviewer',
          mode: 'on_call',
          consults: [],
          onCall: [
            {
              stepId: 's5',
              agentId: 'builder',
              at: '2026-10-27T09:05:00.000Z',
              question: 'Which file holds the turn rules?',
              status: 'done',
              totalTokens: 12000,
            },
            {
              stepId: 's5',
              agentId: 'builder',
              at: '2026-10-27T09:08:00.000Z',
              question: 'How do I retry?',
              status: 'running',
              totalTokens: null,
            },
          ],
        },
      }}
      agents={agents}
    />,
  )
  expect(screen.getByText(/On call to the workers/)).toBeDefined()
  const list = screen.getByRole('list', { name: 'Asked by the workers' })
  expect(list.textContent).toContain('builder · step s5')
  expect(list.textContent).toContain('Which file holds the turn rules?')
  expect(list.textContent).toContain('12000 tokens')
  expect(screen.getByText('Answered')).toBeDefined()
  expect(screen.getByText('Asking')).toBeDefined()
  // Not "never asked" while the workers have asked.
  expect(screen.queryByText('It has not been asked yet.')).toBeNull()
})

test('checkpoints mode says only the lead is helped', () => {
  render(
    <AdvisorCard
      run={{ advisor: { agentId: 'reviewer', mode: 'checkpoints', consults: [] } }}
      agents={agents}
    />,
  )
  expect(screen.getByText('The lead’s checkpoints only.')).toBeDefined()
})
