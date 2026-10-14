import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { CodingLimitCard, PolicyChangedCard } from './CodingCards.tsx'
import { LimitsCard } from './RunDecisions.tsx'

// 7.7c-2 #1: the coding cards take the run's `coding` block, a `preflightWorker(agentId)` callback and the action
// callbacks as props. No lead, no orchestration detail, no network of their own.

afterEach(() => cleanup())

const hexA = 'a'.repeat(64)
const agents = [
  {
    id: 'coder-a',
    name: 'coder-a',
    role: '',
    style: { color: '#19C39A', shape: 'hexagon' },
    status: 'idle',
    activity: null,
    model: null,
    served: true,
    runtime: 'codex',
  },
] as never

const wide = {
  agentId: 'coder-a',
  runtime: 'codex' as const,
  readiness: 'ready' as const,
  detail: null,
  policyId: hexA,
  reach: 'Reads any file you can read, not only the ones in /work/site.',
  reachBeyondWorkspace: true,
}
const wrap = (ui: React.ReactElement) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {ui}
    </QueryClientProvider>,
  )

test('the settings card asks the callback it was given and sends the policy id and the acknowledgement', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('the card must not call the network itself'))),
  )
  const preflightWorker = vi.fn(async () => wide)
  const onUse = vi.fn()
  wrap(
    <PolicyChangedCard
      scope="run-1"
      arrivalKey="n1"
      what="Write the page"
      agentId="coder-a"
      agents={agents}
      preflightWorker={preflightWorker}
      onUse={onUse}
      pending={false}
      error={null}
    />,
  )
  const card = await screen.findByRole('region', { name: 'New settings for coder-a' })
  expect(within(card).getByText(/Write the page is blocked because coder-a/)).toBeTruthy()
  await within(card).findByText(/With the new settings: Reads any file you can read/)
  expect(preflightWorker).toHaveBeenCalledWith('coder-a')
  const button = within(card).getByRole('button', { name: 'Use the new settings' })
  expect((button as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(within(card).getByRole('checkbox', { name: /I understand what it can read now/ }))
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(button)
  expect(onUse).toHaveBeenCalledWith({
    policyId: hexA,
    acknowledgeCodingReach: { policyIds: [hexA] },
  })
  vi.unstubAllGlobals()
})

test('the settings card says so when the check can’t be made, and offers nothing to press', async () => {
  wrap(
    <PolicyChangedCard
      scope="run-2"
      arrivalKey="n2"
      what="Write the page"
      agentId="coder-a"
      agents={agents}
      preflightWorker={async () => {
        throw new Error('down')
      }}
      onUse={vi.fn()}
      pending={false}
      error={null}
    />,
  )
  const card = await screen.findByRole('region', { name: 'New settings for coder-a' })
  await within(card).findByText(/Couldn’t check what it can do now/)
  expect(
    (within(card).getByRole('button', { name: 'Use the new settings' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true)
})

test('the limit card works for a run-wide limit with no step to name, and raises it by callback', () => {
  const onRaise = vi.fn()
  wrap(
    <CodingLimitCard
      arrivalKey="run-1"
      waiting={null}
      coding={{ codingSteps: 4, used: 4 }}
      onRaise={onRaise}
      pending={false}
      error={null}
    />,
  )
  const card = screen.getByRole('region', { name: 'Coding step limit' })
  expect(within(card).getByText('The run reached its limit of coding steps')).toBeTruthy()
  expect(within(card).getByText(/up to 4 coding steps/)).toBeTruthy()
  fireEvent.change(within(card).getByLabelText(/New limit/), { target: { value: '7' } })
  fireEvent.click(within(card).getByRole('button', { name: 'Raise the limit and continue' }))
  expect(onRaise).toHaveBeenCalledWith(7)
})

const limits = { mutate: vi.fn(), isPending: false, error: null }
const budgetRun = {
  revision: 3,
  budget: {
    limitUsd: 5,
    settledUsd: 1,
    provisionalUsd: 0,
    reservedUsd: 0,
    remainingUsd: 4,
    complete: false,
    unknownSpend: true,
  },
} as never

test('unknown cost is offered per source from the coding block, and not at all once every source is accepted', () => {
  const coding = {
    workers: [
      { agentId: 'coder-a', runtime: 'codex' as const },
      { agentId: 'coder-b', runtime: 'claude-code' as const },
    ],
    codingSteps: 4,
    acceptedUnknownCost: ['claude-code' as const],
  }
  const view = wrap(
    <LimitsCard
      run={budgetRun}
      coding={coding}
      reason="unknown_spend"
      actions={{ limits } as never}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Continue although Codex cost is unknown' }))
  expect(limits.mutate).toHaveBeenCalledWith({
    orchestrationRevision: 3,
    acceptUnknownCost: { add: ['codex'] },
  })
  expect(screen.queryByRole('button', { name: /Continue although Claude Code cost/ })).toBeNull()
  view.unmount()
  wrap(
    <LimitsCard
      run={budgetRun}
      coding={{ ...coding, unknownSpend: 'continue', acceptedUnknownCost: [] }}
      reason="unknown_spend"
      actions={{ limits } as never}
    />,
  )
  expect(
    screen.queryByRole('button', { name: /Continue although (Codex|Claude Code) cost/ }),
  ).toBeNull()
})
