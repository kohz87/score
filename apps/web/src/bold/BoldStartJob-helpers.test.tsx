import { fireEvent, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
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

// SA.3: the voters picker. Add opens the agents that are not voters yet (never the lead); a chip removes one.
const voters = (dialog: HTMLElement) => dialog.querySelector('fieldset.start-voters') as HTMLElement
const addVoter = (dialog: HTMLElement, name: string) => {
  fireEvent.click(within(voters(dialog)).getByRole('button', { name: 'Add' }))
  fireEvent.click(within(voters(dialog)).getByRole('button', { name: name }))
}

test('automatic votes go with the voters, sent inside helpers (3.14, SA.3)', async () => {
  open('/b?start=job')
  const dialog = await startDialog()
  addVoter(dialog, 'builder')
  fireEvent.click(within(voters(dialog)).getByRole('checkbox', { name: /Vote on every step/ }))
  fireEvent.change(within(voters(dialog)).getByLabelText('Voters per vote (3 to 7)'), {
    target: { value: '5' },
  })
  fireEvent.click(await fillLeadJob(dialog))
  await waitFor(() => expect(state.orchestrationBodies.length).toBe(1))
  expect(state.orchestrationBodies[0]!.helpers).toEqual({
    agentIds: [],
    voterIds: ['builder'],
    autoVote: true,
    autoVoteK: 5,
    splitTo: 'lead',
  })
})

test('the split choice shows once a voter is named, and “Ask me” is sent as splitTo', async () => {
  open('/b?start=job')
  const dialog = await startDialog()
  expect(within(voters(dialog)).queryByRole('radio', { name: 'Ask me' })).toBeNull()
  addVoter(dialog, 'builder')
  fireEvent.click(within(voters(dialog)).getByRole('radio', { name: 'Ask me' }))
  fireEvent.click(await fillLeadJob(dialog))
  await waitFor(() => expect(state.orchestrationBodies.length).toBe(1))
  expect(state.orchestrationBodies[0]!.helpers).toEqual({
    agentIds: [],
    voterIds: ['builder'],
    autoVote: false,
    autoVoteK: 3,
    splitTo: 'person',
  })
})

test('automatic votes are off and disabled when you approve every step (3.14)', async () => {
  open('/b?start=job')
  const dialog = await startDialog()
  addVoter(dialog, 'builder')
  fireEvent.click(within(voters(dialog)).getByRole('checkbox', { name: /Vote on every step/ }))
  fireEvent.click(within(dialog).getByRole('radio', { name: 'The plan starts' }))
  const vote = within(voters(dialog)).getByRole('checkbox', {
    name: /Vote on every step/,
  }) as HTMLInputElement
  expect(vote.disabled).toBe(true)
  expect(vote.checked).toBe(false)
  expect(within(voters(dialog)).getByText(/the vote is then yours/)).toBeDefined()
  fireEvent.click(await fillLeadJob(dialog))
  await waitFor(() => expect(state.orchestrationBodies.length).toBe(1))
  expect(state.orchestrationBodies[0]!.helpers).toMatchObject({ autoVote: false })
})

test('automatic votes need a voter: the box is off and disabled until one is named (SA.3)', async () => {
  open('/b?start=job')
  const dialog = await startDialog()
  const vote = within(voters(dialog)).getByRole('checkbox', {
    name: /Vote on every step/,
  }) as HTMLInputElement
  expect(vote.disabled).toBe(true)
  expect(within(voters(dialog)).getByText(/Name voters first/)).toBeDefined()
})

test('no voters picked means no helpers in the body (3.15)', async () => {
  open('/b?start=job')
  const dialog = await startDialog()
  fireEvent.click(await fillLeadJob(dialog))
  await waitFor(() => expect(state.orchestrationBodies.length).toBe(1))
  expect(state.orchestrationBodies[0]).not.toHaveProperty('helpers')
})

test('a dropped lead pick does not come back: voter, then the same agent as advisor and planner, then another lead (3.15, SA.3)', async () => {
  state.codingLead = 'coder'
  open('/b?start=job')
  const dialog = await startDialog()
  addVoter(dialog, 'builder')
  fireEvent.change(within(dialog).getByLabelText('Advisor'), { target: { value: 'builder' } })
  const planner = await within(dialog).findByLabelText('Who plans it')
  fireEvent.change(planner, { target: { value: 'builder' } })
  await waitFor(() =>
    expect(
      within(voters(dialog)).queryByRole('button', { name: 'Remove builder from the voters' }),
    ).toBeNull(),
  )
  fireEvent.change(planner, { target: { value: 'reviewer' } })
  fireEvent.click(within(voters(dialog)).getByRole('button', { name: 'Add' }))
  const back = within(voters(dialog)).getByRole('button', { name: 'builder' })
  expect(back).toBeDefined()
  expect((within(dialog).getByLabelText('Advisor') as HTMLSelectElement).value).toBe('')
})

test('voters are chosen from Add, never the lead, and sent as voterIds with the preflight (3.13.1)', async () => {
  open('/b?start=job')
  const dialog = await startDialog()
  fireEvent.click(within(voters(dialog)).getByRole('button', { name: 'Add' }))
  expect(within(voters(dialog)).queryByRole('button', { name: 'lead' })).toBeNull()
  fireEvent.click(within(voters(dialog)).getByRole('button', { name: 'designer' }))
  await waitFor(() =>
    expect(state.preflightUrls.some((ids) => ids.split(',').includes('designer'))).toBe(true),
  )
  fireEvent.click(await fillLeadJob(dialog))
  await waitFor(() => expect(state.orchestrationBodies.length).toBe(1))
  expect(state.orchestrationBodies[0]!.helpers).toMatchObject({
    agentIds: [],
    voterIds: ['designer'],
  })
})

test('the lead is never offered; a chip removes its voter, and Add hides once every other agent is a voter (SA.3)', async () => {
  open('/b?start=job')
  const dialog = await startDialog()
  for (const name of ['builder', 'reviewer', 'designer']) addVoter(dialog, name)
  expect(within(voters(dialog)).queryByRole('button', { name: 'Add' })).toBeNull()
  fireEvent.click(
    within(voters(dialog)).getByRole('button', { name: 'Remove reviewer from the voters' }),
  )
  fireEvent.click(await fillLeadJob(dialog))
  await waitFor(() => expect(state.orchestrationBodies.length).toBe(1))
  expect(state.orchestrationBodies[0]!.helpers).toMatchObject({ voterIds: ['builder', 'designer'] })
})

test('no voters picked means no voterIds in the body (3.13.1)', async () => {
  open('/b?start=job')
  const dialog = await startDialog()
  fireEvent.click(await fillLeadJob(dialog))
  await waitFor(() => expect(state.orchestrationBodies.length).toBe(1))
  expect(state.orchestrationBodies[0]).not.toHaveProperty('helpers')
})

test('a voter that becomes the lead is dropped (3.13.1)', async () => {
  state.codingLead = 'coder'
  open('/b?start=job')
  const dialog = await startDialog()
  addVoter(dialog, 'builder')
  const planner = await within(dialog).findByLabelText('Who plans it')
  fireEvent.change(planner, { target: { value: 'builder' } })
  await waitFor(() =>
    expect(
      within(voters(dialog)).queryByRole('button', { name: 'Remove builder from the voters' }),
    ).toBeNull(),
  )
  fireEvent.change(planner, { target: { value: 'reviewer' } })
  fireEvent.click(within(voters(dialog)).getByRole('button', { name: 'Add' }))
  expect(within(voters(dialog)).getByRole('button', { name: 'builder' })).toBeDefined()
})

test('the launches field prefills from the suggestion, follows the choices, and stops once typed (3.13.1)', async () => {
  state.codingLead = 'coder'
  open('/b?start=job')
  const dialog = await startDialog()
  // The coding agent can take steps, so the field shows with the default (10).
  const field = (await within(dialog).findByLabelText(
    'Coding-agent launches (1–100)',
  )) as HTMLInputElement
  expect(field.value).toBe('10')
  // A coding voter adds the voter sizing (20); a coding advisor adds 5.
  addVoter(dialog, 'coder')
  await waitFor(() => expect(field.value).toBe('30'))
  fireEvent.change(within(dialog).getByLabelText('Advisor'), { target: { value: 'coder' } })
  await waitFor(() => expect(field.value).toBe('35'))
  // Typed: no longer follows.
  fireEvent.change(field, { target: { value: '42' } })
  fireEvent.change(within(dialog).getByLabelText('Advisor'), { target: { value: '' } })
  expect(field.value).toBe('42')
  expect(within(dialog).getByText(/Each step, helper step, vote answer/)).toBeDefined()
  fireEvent.click(await fillLeadJob(dialog))
  await waitFor(() => expect(state.orchestrationBodies.length).toBe(1))
  expect(state.orchestrationBodies[0]).toMatchObject({ codingSteps: 42 })
})

test('an invalid launches value blocks Start with the reason (3.13.1)', async () => {
  state.codingLead = 'coder'
  open('/b?start=job')
  const dialog = await startDialog()
  const field = await within(dialog).findByLabelText('Coding-agent launches (1–100)')
  const start = await fillLeadJob(dialog)
  fireEvent.change(field, { target: { value: '0' } })
  expect(within(dialog).getByText(/Coding-agent launches must be a whole number/)).toBeDefined()
  expect((start as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(field, { target: { value: '5' } })
  await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false))
})

test('no coding agent means no launches field and no codingSteps (3.13.1)', async () => {
  open('/b?start=job')
  const dialog = await startDialog()
  expect(within(dialog).queryByLabelText('Coding-agent launches (1–100)')).toBeNull()
  fireEvent.click(await fillLeadJob(dialog))
  await waitFor(() => expect(state.orchestrationBodies.length).toBe(1))
  expect(state.orchestrationBodies[0]).not.toHaveProperty('codingSteps')
})
