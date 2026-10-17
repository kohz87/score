// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { QuotaLowCard } from './CodingCards.tsx'
import { buildGraph, needsYouText, orchCoding } from './orch-model.ts'
import { heldCaption, heldLine } from './quota-text.ts'
import { LimitsCard } from './RunDecisions.tsx'
import { BudgetBlock } from './RunPanel.tsx'

// PLAN 8.6: the held-step card (three answers), the plain words for a hold, and the floor in the limits.

afterEach(() => cleanup())

const agents = [
  {
    id: 'builder',
    name: 'builder',
    role: '',
    style: { color: '#19C39A', shape: 'hexagon' },
    status: 'idle',
    activity: null,
    model: null,
    served: true,
    runtime: 'claude-code',
  },
] as never
const hold = {
  agentId: 'builder',
  window: '5 hours' as const,
  group: null,
  leftPercent: 6,
  resetsAt: '2099-01-01T05:40:00.000Z',
}
const wrap = (ui: React.ReactElement) =>
  render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>)

test('the card says what is held and why, and sends each of the three answers', () => {
  const onAnswer = vi.fn()
  wrap(
    <QuotaLowCard
      arrivalKey="s3"
      what="s3"
      hold={hold}
      agents={agents}
      onAnswer={onAnswer}
      pending={false}
      error={null}
    />,
  )
  const card = screen.getByRole('region', { name: 'builder’s limit is low' })
  expect(within(card).getByText(/s3 is held:/)).toBeTruthy()
  expect(within(card).getByText(/has 6% of its 5-hour limit left/)).toBeTruthy()
  expect(within(card).getByText(/Steps that are already running carry on\./)).toBeTruthy()
  fireEvent.click(within(card).getByRole('button', { name: 'Use it anyway' }))
  fireEvent.click(within(card).getByRole('button', { name: 'Wait until it resets' }))
  fireEvent.click(within(card).getByRole('button', { name: 'Stop the run' }))
  expect(onAnswer.mock.calls).toEqual([['use_anyway'], ['wait'], ['stop']])
})

test('a pending answer disables the buttons; a group names the limit', () => {
  wrap(
    <QuotaLowCard
      arrivalKey="s3"
      what="Write the page"
      hold={{ ...hold, group: 'Gemini Models' }}
      agents={agents}
      onAnswer={vi.fn()}
      pending
      error={null}
    />,
  )
  expect(screen.getByText(/the Gemini Models 5-hour limit/)).toBeTruthy()
  for (const name of ['Use it anyway', 'Wait until it resets', 'Stop the run'])
    expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
})

test('plain words for a held step: its line, its Needs you text and its place on the diagram', () => {
  const when = new Date('2026-10-17T07:40:00.000Z')
  expect(
    heldCaption({ leftPercent: 6, resetsAt: '2026-10-17T07:40:00.000Z', state: 'held' }, when),
  ).toMatch(/^Held: limit low \(6% left, resets .*\)$/)
  expect(
    heldLine({ leftPercent: 6, resetsAt: '2026-10-17T07:40:00.000Z', state: 'waiting' }, when),
  ).toMatch(/^Waiting for the limit to reset \(.*\)\.$/)
  expect(
    heldLine({ leftPercent: 6, resetsAt: '2026-10-17T07:40:00.000Z', state: 'override' }, when),
  ).toBe('Starting anyway: you chose to use it.')
  expect(needsYouText({ kind: 'quota_low', stepId: 's3', ...hold })).toBe(
    's3 is held: builder’s limit is low',
  )
  const { nodes } = buildGraph({
    leadAgentId: 'lead',
    stepsList: [
      {
        id: 's3',
        agentId: 'builder',
        after: [],
        replaces: null,
        quotaHold: { ...hold, state: 'held' },
      },
    ],
  } as never)
  expect(nodes.find((node) => node.id === 's3')?.caption).toMatch(/^Held: limit low \(6% left/)
})

const budgetRun = {
  revision: 3,
  budget: {
    limitUsd: 5,
    settledUsd: 1,
    provisionalUsd: 0,
    reservedUsd: 0,
    remainingUsd: 4,
    complete: false,
    unknownSpend: false,
  },
} as never
const codingBlock = (floor: number | null) =>
  orchCoding(
    {
      stepLimit: 4,
      acceptedUnknownCost: [],
      workers: [{ agentId: 'builder', runtime: 'codex' }],
    } as never,
    floor,
  )

test('the limits card sets the run’s quota floor, and leaves it alone when the field is blank', () => {
  const limits = { mutate: vi.fn(), isPending: false, error: null }
  wrap(
    <LimitsCard
      run={budgetRun}
      coding={codingBlock(null)}
      reason="budget"
      actions={{ limits } as never}
    />,
  )
  expect(screen.getByText(/Quota floor \(%\) \(each agent’s own now\)/)).toBeTruthy()
  const apply = screen.getByRole('button', { name: 'Apply and continue' }) as HTMLButtonElement
  expect(apply.disabled).toBe(true)
  const field = screen.getByLabelText(/Quota floor/)
  fireEvent.change(field, { target: { value: '60' } })
  expect(apply.disabled).toBe(true)
  fireEvent.change(field, { target: { value: '5' } })
  fireEvent.click(apply)
  expect(limits.mutate).toHaveBeenCalledWith({ orchestrationRevision: 3, quotaFloorPercent: 5 })
})

test('the budget block shows the floor that applies to the run', () => {
  const run = { budget: (budgetRun as { budget: never }).budget, stepEstimateUsd: 0.5 } as never
  const { rerender } = render(<BudgetBlock run={run} coding={codingBlock(null)} />)
  expect(screen.getByText(/Each coding agent’s own; a coding agent with less/)).toBeTruthy()
  rerender(<BudgetBlock run={run} coding={codingBlock(5)} />)
  expect(screen.getByText(/5% for this run/)).toBeTruthy()
  rerender(<BudgetBlock run={run} coding={codingBlock(0)} />)
  expect(screen.getByText(/Off for this run/)).toBeTruthy()
})
