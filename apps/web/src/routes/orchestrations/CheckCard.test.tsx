import type { CheckRunView } from '@score/contract'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { CheckCard, type CheckActions } from './CheckCard.tsx'

afterEach(cleanup)

const iso = '2026-10-27T09:00:00.000Z'
const run = (over: Partial<CheckRunView>): CheckRunView => ({
  id: 'c1',
  reason: 'lead',
  queuedAt: iso,
  startedAt: iso,
  endedAt: iso,
  exitCode: 0,
  outcome: 'passed',
  output: 'all green',
  current: true,
  ...over,
})
const check = (over: Record<string, unknown> = {}) => ({
  command: 'pnpm test',
  workspace: '/work/site',
  timeoutSec: 600,
  when: 'finish' as const,
  runs: [run({})],
  waivedAt: null as string | null,
  ...over,
})
function actions() {
  const make = () => ({ mutate: vi.fn(), isPending: false, error: null as unknown })
  return { checkRun: make(), checkWaive: make() } satisfies CheckActions
}

test('nothing renders without a check', () => {
  const { container } = render(
    <CheckCard run={{ check: null, status: 'running', revision: 3 }} actions={actions()} />,
  )
  expect(container.textContent).toBe('')
})

test('shows the command, folder, runs and who asked', () => {
  render(
    <CheckCard
      run={{
        check: check({
          when: 'each_step',
          runs: [
            run({ id: 'a', outcome: 'failed', exitCode: 1, reason: 'person', current: false }),
            run({ id: 'b', outcome: 'timed_out', exitCode: null, reason: 'step', current: false }),
            run({ id: 'c' }),
          ],
        }),
        status: 'running',
        revision: 3,
      }}
      actions={actions()}
    />,
  )
  const card = screen.getByRole('region', { name: 'Check' })
  expect(within(card).getByText('pnpm test')).toBeDefined()
  expect(within(card).getByText('/work/site')).toBeDefined()
  expect(card.textContent).toContain('after every step and before finishing')
  expect(within(card).getByText('Failed')).toBeDefined()
  expect(within(card).getByText('Timed out')).toBeDefined()
  expect(within(card).getByText('Passed')).toBeDefined()
  expect(within(card).getByText('exit 1')).toBeDefined()
  expect(within(card).getByText('Asked by you')).toBeDefined()
  expect(within(card).getByText('After a step')).toBeDefined()
  expect(within(card).getAllByText('counts for finishing')).toHaveLength(1)
  expect(card.querySelector('pre')?.textContent).toBe('all green')
})

test('Run check and Finish without a passing check send the run revision, and the waive is protected', () => {
  const act = actions()
  render(<CheckCard run={{ check: check(), status: 'paused', revision: 7 }} actions={act} />)
  fireEvent.click(screen.getByRole('button', { name: 'Run check' }))
  expect(act.checkRun.mutate).toHaveBeenCalledWith({ orchestrationRevision: 7 })
  const waive = screen.getByRole('button', { name: 'Finish without a passing check' })
  expect(waive.closest('[data-protected]')).not.toBeNull()
  fireEvent.click(waive)
  // Two steps: the first click only asks, inside the protected container.
  expect(act.checkWaive.mutate).not.toHaveBeenCalled()
  const question = screen.getByText('Let it finish as a success without a passing check?')
  expect(question.closest('[data-protected]')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(act.checkWaive.mutate).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Finish without a passing check' }))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
  expect(act.checkWaive.mutate).toHaveBeenCalledWith({ orchestrationRevision: 7 })
})

test('after a waiver the buttons give way to a plain statement', () => {
  render(
    <CheckCard
      run={{ check: check({ waivedAt: iso }), status: 'running', revision: 2 }}
      actions={actions()}
    />,
  )
  expect(screen.getByText(/You let it finish without a passing check/)).toBeDefined()
  expect(screen.queryByRole('button', { name: 'Finish without a passing check' })).toBeNull()
})

test('a finished job offers neither button', () => {
  render(
    <CheckCard run={{ check: check(), status: 'succeeded', revision: 9 }} actions={actions()} />,
  )
  expect(screen.queryByRole('button', { name: 'Run check' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Finish without a passing check' })).toBeNull()
})

test('while a run is queued or running, Run check waits', () => {
  render(
    <CheckCard
      run={{
        check: check({ runs: [run({ outcome: 'running', endedAt: null, exitCode: null })] }),
        status: 'running',
        revision: 2,
      }}
      actions={actions()}
    />,
  )
  const button = screen.getByRole('button', { name: 'Check running…' }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
})
