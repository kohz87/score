import type { AgentSummary } from '@score/contract'
import { fireEvent, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  acknowledgement,
  agents,
  beginStartJobTest,
  endStartJobTest,
  fillLeadJob,
  open,
  startDialog,
  startJobState,
} from './BoldStartJob-helpers.tsx'

const state = startJobState

beforeEach(beginStartJobTest)
afterEach(endStartJobTest)

test('an agent being set up, deleted or removed is never offered in Agents allowed', async () => {
  const extra: AgentSummary[] = (['setting_up', 'deleting', 'removed'] as const).map((state) => ({
    ...agents[1]!,
    id: `gone-${state}`,
    name: `gone-${state}`,
    lifecycle: { state, incarnationId: '6f9619ff-8b86-4d11-b42d-00c04fc964ff', operationId: null },
  }))
  agents.push(...extra)
  try {
    open('/b?start=job')
    const dialog = await startDialog()
    const picker = await within(dialog).findByRole('group', { name: 'Agents allowed' })
    await waitFor(() => expect(picker.textContent).toContain('builder'))
    for (const agent of extra) expect(picker.textContent).not.toContain(agent.name)
  } finally {
    agents.splice(agents.length - extra.length, extra.length)
  }
})

test('in a room a coding agent leads, “lead decides” asks which Hermes agent plans it (3.7.5)', async () => {
  state.codingLead = 'coder'
  try {
    open('/b?start=job')
    const dialog = await startDialog()
    const planner = await within(dialog).findByLabelText('Who plans it')
    expect(
      within(dialog).getByText(/coder leads this room, but a coding agent can’t plan/),
    ).toBeDefined()
    const options = within(planner)
      .getAllByRole('option')
      .map((option) => option.textContent)
    expect(options).not.toContain('coder')
    expect(options).toContain('builder')
    fireEvent.change(planner, { target: { value: 'builder' } })
    expect((planner as HTMLSelectElement).value).toBe('builder')
    // The planner leaves the steps' agents; the coding room lead can still take steps.
    const pick = within(dialog).getByRole('group', { name: 'Agents allowed' })
    expect(within(pick).queryByRole('checkbox', { name: /builder/ })).toBeNull()
    expect(within(pick).getByRole('checkbox', { name: /coder/ })).toBeDefined()
  } finally {
    state.codingLead = null
  }
})

test('the tool check offers Reload MCP, asks first, restarts the lead’s gateway and checks again (3.7.9)', async () => {
  state.toolsListed = 'unknown'
  state.reloads = []
  try {
    open('/b?start=job')
    const dialog = await startDialog()
    const checks = within(dialog).getByRole('region', { name: 'Before it starts' })
    fireEvent.click(await within(checks).findByRole('button', { name: 'Reload MCP' }))
    expect(within(checks).getByText(/This restarts lead’s Hermes/)).toBeDefined()
    expect(state.reloads).toEqual([])
    fireEvent.click(within(checks).getByRole('button', { name: 'Restart and reload' }))
    await waitFor(() => expect(state.reloads).toEqual(['lead']))
    await waitFor(() =>
      expect(within(checks).getByText('The lead sees every orch.* tool')).toBeDefined(),
    )
    expect(within(checks).queryByRole('button', { name: 'Reload MCP' })).toBeNull()
  } finally {
    state.toolsListed = null
  }
})

test('an advisor is optional, checked in the preflight, sent by id, and cleared when it becomes the lead (3.14)', async () => {
  state.codingLead = 'coder'
  try {
    open('/b?start=job')
    const dialog = await startDialog()
    const advisor = within(dialog).getByLabelText('Advisor') as HTMLSelectElement
    expect(advisor.value).toBe('')
    expect(within(dialog).getByText(/the lead decides/)).toBeDefined()
    // The lead itself is not offered.
    expect(within(advisor).queryByRole('option', { name: 'lead' })).toBeNull()
    fireEvent.change(advisor, { target: { value: 'builder' } })
    await waitFor(() =>
      expect(state.preflightUrls.some((ids) => ids.split(',').includes('builder'))).toBe(true),
    )
    const start = await fillLeadJob(dialog)
    fireEvent.click(start)
    await waitFor(() => expect(state.orchestrationBodies.length).toBe(1))
    expect(state.orchestrationBodies[0]).toMatchObject({ advisorAgentId: 'builder' })
    // 3.14.1: the on-call choice is retired (a worker's own advisor is a Claude Code agent setting).
    expect(state.orchestrationBodies[0]).not.toHaveProperty('advisorMode')

    // Making the advisor the planner resets the choice.
    fireEvent.change(within(dialog).getByLabelText('Who plans it'), {
      target: { value: 'builder' },
    })
    await waitFor(() =>
      expect((within(dialog).getByLabelText('Advisor') as HTMLSelectElement).value).toBe(''),
    )
  } finally {
    state.codingLead = null
  }
})

test('3.27.0: lead decides keeps going until stopped by default, sends untilStopped and needs the spend cap', async () => {
  open('/b?start=job')
  const dialog = await startDialog()
  const keep = within(dialog).getByRole('checkbox', {
    name: 'Keep going until I stop it',
  }) as HTMLInputElement
  expect(keep.checked).toBe(true)
  // No turn slider while there is no turn limit.
  expect(within(dialog).queryByText('Turns per back-and-forth')).toBeNull()
  const cap = within(dialog).getByLabelText(/Spend cap/) as HTMLInputElement
  expect(cap.required).toBe(true)
  fireEvent.change(cap, { target: { value: '0' } })
  fireEvent.change(within(dialog).getByLabelText('What should the team do?'), {
    target: { value: 'Fix the failing tests' },
  })
  fireEvent.click(acknowledgement(dialog))
  const start = within(dialog).getByRole('button', { name: 'Start the job' })
  await waitFor(() => expect(start.hasAttribute('disabled')).toBe(true))
  expect(
    within(dialog)
      .getByText(/Set a spend cap/)
      .getAttribute('role'),
  ).toBe('alert')
  fireEvent.change(cap, { target: { value: '7' } })
  await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false))
  fireEvent.click(start)
  await waitFor(() => expect(state.orchestrationBodies).toHaveLength(1))
  expect(state.orchestrationBodies[0]).toMatchObject({ untilStopped: true, budgetUsd: 7 })
})

test('3.27.0: turning "Keep going until I stop it" off restores the turn limit and sends no untilStopped', async () => {
  open('/b?start=job')
  const dialog = await startDialog()
  fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Keep going until I stop it' }))
  expect(within(dialog).getByText('Turns per back-and-forth')).toBeDefined()
  const cap = within(dialog).getByLabelText(/Spend cap/) as HTMLInputElement
  expect(cap.required).toBe(false)
  fireEvent.change(cap, { target: { value: '0' } })
  fireEvent.click(await fillLeadJob(dialog))
  await waitFor(() => expect(state.orchestrationBodies).toHaveLength(1))
  expect(state.orchestrationBodies[0]).not.toHaveProperty('untilStopped')
  expect(state.orchestrationBodies[0]).toMatchObject({ maxLeadTurns: 8 })
})

test('no advisor means no advisorAgentId in the body (3.14)', async () => {
  open('/b?start=job')
  const dialog = await startDialog()
  fireEvent.click(await fillLeadJob(dialog))
  await waitFor(() => expect(state.orchestrationBodies.length).toBe(1))
  expect(state.orchestrationBodies[0]).not.toHaveProperty('advisorAgentId')
  expect(state.orchestrationBodies[0]).not.toHaveProperty('advisorMode')
})
