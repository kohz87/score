import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { LimitsCard } from './limit-decision-card.tsx'

/** SA.3 part 11: an orchestration paused at the job's subagent total offers "Allow 10 more" beside its budget pins. */
afterEach(() => cleanup())

const run = {
  revision: 3,
  budget: {
    limitUsd: 5,
    settledUsd: 1,
    provisionalUsd: 0,
    reservedUsd: 0,
    unknownSpend: false,
  },
} as never

test('at the subagent total, Allow 10 more sends the limits decision with moreSubagents 10', () => {
  const limits = { mutate: vi.fn(), isPending: false, error: null }
  render(<LimitsCard run={run} reason="subagent_total" actions={{ limits } as never} />)
  fireEvent.click(screen.getByRole('button', { name: 'Allow 10 more' }))
  expect(limits.mutate).toHaveBeenCalledWith({ orchestrationRevision: 3, moreSubagents: 10 })
})

test('the button is only offered at the subagent total, not at a budget pause', () => {
  const limits = { mutate: vi.fn(), isPending: false, error: null }
  render(<LimitsCard run={run} reason="budget" actions={{ limits } as never} />)
  expect(screen.queryByRole('button', { name: 'Allow 10 more' })).toBeNull()
})

test('the card keeps its protected block and its own heading at the subagent total', () => {
  const limits = { mutate: vi.fn(), isPending: false, error: null }
  const { container } = render(
    <LimitsCard run={run} reason="subagent_total" actions={{ limits } as never} />,
  )
  expect(container.querySelector('[data-protected="block"]')).not.toBeNull()
})
