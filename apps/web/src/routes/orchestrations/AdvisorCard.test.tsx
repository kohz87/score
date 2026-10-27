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
