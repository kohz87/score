import { fireEvent, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  acknowledgement,
  beginStartJobTest,
  endStartJobTest,
  recipeDialog,
  startJobState,
  workflowPreflight,
} from './BoldStartJob-helpers.tsx'

const state = startJobState

beforeEach(beginStartJobTest)
afterEach(endStartJobTest)

const codingWorker = (policyId: string, reach: boolean) => ({
  agentId: 'coder-a',
  runtime: 'codex',
  readiness: 'ready',
  detail: null,
  policyId,
  reach: 'Reads any file you can read, not only the ones in /work/site.',
  reachBeyondWorkspace: reach,
})

test('a recipe says that a spend cap pauses a step whose cost is unknown', async () => {
  const dialog = await recipeDialog()
  expect(
    within(dialog).getByText(/a step whose cost Hermes doesn’t report pauses the run/),
  ).toBeDefined()
  fireEvent.change(within(dialog).getByLabelText(/^Spend cap/), { target: { value: '0' } })
  await waitFor(() =>
    expect(
      within(dialog).queryByText(/a step whose cost Hermes doesn’t report pauses the run/),
    ).toBeNull(),
  )
})

test('a coding recipe asks for its reach, and More options reach the posted body', async () => {
  state.workflowPreflightNow = {
    ...workflowPreflight,
    workers: [codingWorker('a'.repeat(64), true)],
    defaults: { ...workflowPreflight.defaults, codingSteps: 4 },
  }
  const dialog = await recipeDialog()
  fireEvent.change(within(dialog).getByLabelText(/Topic|Release/i, { selector: 'textarea' }), {
    target: { value: 'the 2.4 release' },
  })
  fireEvent.click(acknowledgement(dialog))
  const start = within(dialog).getByRole('button', { name: 'Start the job' })
  const reach = await within(dialog).findByRole('checkbox', {
    name: /I understand what these coding agents can read/,
  })
  expect(
    within(dialog)
      .getByText(/Coding agents in this job/)
      .closest('[data-protected]'),
  ).not.toBeNull()
  expect(start.hasAttribute('disabled')).toBe(true)

  fireEvent.click(within(dialog).getByText('More options'))
  expect((within(dialog).getByLabelText('Most coding steps') as HTMLInputElement).value).toBe('4')
  fireEvent.change(within(dialog).getByLabelText('Most coding steps'), { target: { value: '6' } })
  fireEvent.change(within(dialog).getByLabelText(/^Quota floor/), { target: { value: '20' } })
  fireEvent.change(within(dialog).getByLabelText(/^Steps at the same time/), {
    target: { value: '3' },
  })
  fireEvent.change(within(dialog).getByLabelText(/^Estimate per step/), {
    target: { value: '0.75' },
  })
  expect(start.hasAttribute('disabled')).toBe(true)
  fireEvent.click(reach)
  await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false))
  fireEvent.click(start)
  await waitFor(() => expect(state.workflowRunBodies).toHaveLength(1))
  expect(state.workflowRunBodies[0]).toMatchObject({
    workflowId: 'wf_release',
    codingPolicies: { 'coder-a': 'a'.repeat(64) },
    acknowledgeCodingReach: { policyIds: ['a'.repeat(64)] },
    codingSteps: 6,
    quotaFloorPercent: 20,
    maxConcurrentSteps: 3,
    stepEstimateUsd: 0.75,
  })
})

test('a coding agent whose policy changed has to be accepted again', async () => {
  state.workflowPreflightNow = {
    ...workflowPreflight,
    workers: [codingWorker('a'.repeat(64), true)],
  }
  state.workflowRunReply = () =>
    Response.json({ error: { code: 'policy_changed', message: 'changed' } }, { status: 409 })
  const dialog = await recipeDialog()
  fireEvent.change(within(dialog).getByLabelText(/Topic|Release/i, { selector: 'textarea' }), {
    target: { value: 'x' },
  })
  fireEvent.click(acknowledgement(dialog))
  fireEvent.click(
    await within(dialog).findByRole('checkbox', {
      name: /I understand what these coding agents can read/,
    }),
  )
  const start = within(dialog).getByRole('button', { name: 'Start the job' })
  await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false))
  state.workflowPreflightNow = {
    ...workflowPreflight,
    workers: [codingWorker('b'.repeat(64), true)],
  }
  fireEvent.click(start)
  await waitFor(() => expect(state.workflowRunBodies).toHaveLength(1))
  await waitFor(() =>
    expect(
      (
        within(dialog).getByRole('checkbox', {
          name: /I understand what these coding agents can read/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(false),
  )
  expect(
    within(dialog).getByRole('button', { name: 'Start the job' }).hasAttribute('disabled'),
  ).toBe(true)
})

test('More options are range-checked: an empty or out-of-range field blocks Start and says why', async () => {
  state.workflowPreflightNow = {
    ...workflowPreflight,
    workers: [codingWorker('a'.repeat(64), false)],
    defaults: { ...workflowPreflight.defaults, codingSteps: 4 },
  }
  const dialog = await recipeDialog()
  fireEvent.change(within(dialog).getByLabelText(/Topic|Release/i, { selector: 'textarea' }), {
    target: { value: 'x' },
  })
  fireEvent.click(acknowledgement(dialog))
  const start = within(dialog).getByRole('button', { name: 'Start the job' })
  await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false))
  fireEvent.click(within(dialog).getByText('More options'))

  const cases: [RegExp, string[], string, RegExp][] = [
    [/^Steps at the same time/, ['0', '4', ''], '2', /Steps at the same time must be 1 to 3/],
    [/^Estimate per step/, ['0', '1001', ''], '0.5', /Estimate per step must be above 0/],
    [/^Most coding steps/, ['0', '999', ''], '4', /Most coding steps must be 1 to/],
  ]
  for (const [label, bad, good, reason] of cases) {
    for (const value of bad) {
      fireEvent.change(within(dialog).getByLabelText(label), { target: { value } })
      await waitFor(() => expect(start.hasAttribute('disabled')).toBe(true))
      expect(within(dialog).getByText(reason)).toBeDefined()
    }
    fireEvent.change(within(dialog).getByLabelText(label), { target: { value: good } })
    await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false))
  }
})
