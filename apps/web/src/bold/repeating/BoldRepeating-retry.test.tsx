import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { job, mount, repeating as state, sent } from './repeating-helpers.tsx'

// A retry never makes a second job or run (decision 183): one Idempotency-Key per action until it succeeds.

test('a create retried after a network error sends the same key; the next create gets a new one', async () => {
  state.drop.add('POST /api/agents/builder/routines')
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'New repeating job' }))
  const panel = await screen.findByRole('complementary', { name: 'New repeating job' })
  fireEvent.change(within(panel).getByLabelText('Title'), { target: { value: 'Check deps' } })
  fireEvent.change(within(panel).getByLabelText('What it does'), { target: { value: 'Look' } })
  fireEvent.click(within(panel).getByRole('radio', { name: 'Nowhere, just the run' }))
  fireEvent.click(within(panel).getByRole('button', { name: 'Save' }))
  expect((await within(panel).findByRole('alert')).textContent).toMatch(/Couldn’t save/)
  fireEvent.click(within(panel).getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull())
  const made = sent('POST', '/api/agents/')
  expect(made).toHaveLength(2)
  expect(made[0]!.key).toBeTruthy()
  expect(made[1]!.key).toBe(made[0]!.key)
})

test('Run now retried after a refusal sends the same key; after success the next run has a new one', async () => {
  state.jobs = [job('b1', 'builder', { title: 'Morning summary' })]
  state.fail.add('POST /api/routines/b1/run')
  mount()
  const run = await screen.findByRole('button', { name: 'Run Morning summary now' })
  fireEvent.click(run)
  await screen.findByText('Couldn’t start Morning summary. Try again.')
  state.fail.clear()
  fireEvent.click(screen.getByRole('button', { name: 'Run Morning summary now' }))
  await screen.findByText('Started Morning summary.')
  await waitFor(() => expect(sent('POST', '/api/routines/')).toHaveLength(2))
  fireEvent.click(screen.getByRole('button', { name: 'Run Morning summary now' }))
  await waitFor(() => expect(sent('POST', '/api/routines/')).toHaveLength(3))
  const keys = sent('POST', '/api/routines/').map((item) => item.key)
  expect(keys[1]).toBe(keys[0])
  expect(keys[2]).not.toBe(keys[1])
})
