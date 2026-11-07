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

test('helpers are folded, optional, checked in the preflight, and sent with their limits (3.15)', async () => {
  open('/b?start=job')
  const dialog = await startDialog()
  const section = dialog.querySelector('details.start-helpers') as HTMLDetailsElement
  expect(section.open).toBe(false)
  expect(within(section).getByText(/A clear majority \(70% or more\)/)).toBeDefined()
  // The lead itself is not offered as a helper.
  expect(within(section).queryByRole('checkbox', { name: 'lead' })).toBeNull()
  fireEvent.click(within(section).getByRole('checkbox', { name: 'builder' }))
  await waitFor(() =>
    expect(state.preflightUrls.some((ids) => ids.split(',').includes('builder'))).toBe(true),
  )
  fireEvent.change(within(section).getByLabelText('At once (1 to 6)'), { target: { value: '4' } })
  fireEvent.click(within(section).getByRole('radio', { name: 'Ask me' }))
  fireEvent.click(await fillLeadJob(dialog))
  await waitFor(() => expect(state.orchestrationBodies.length).toBe(1))
  expect(state.orchestrationBodies[0]).toMatchObject({
    helpers: {
      agentIds: ['builder'],
      maxConcurrent: 4,
      maxSteps: 20,
      scan: false,
      splitTo: 'person',
    },
  })
  expect(state.orchestrationBodies[0]!.helpers).not.toHaveProperty('scanFolder')
  expect(state.orchestrationBodies[0]!.allowedAgents).not.toContain('lead')
})

test('no limit, automatic votes and audits are sent inside helpers (3.14)', async () => {
  open('/b?start=job')
  const dialog = await startDialog()
  const section = dialog.querySelector('details.start-helpers') as HTMLDetailsElement
  fireEvent.click(within(section).getByRole('checkbox', { name: 'builder' }))
  fireEvent.click(within(section).getByRole('checkbox', { name: /No limit/ }))
  expect(
    (within(section).getByLabelText('Helper steps (1 to 60)') as HTMLInputElement).disabled,
  ).toBe(true)
  fireEvent.click(within(section).getByRole('checkbox', { name: /Vote on every step/ }))
  fireEvent.change(within(section).getByLabelText('Voters per vote (3 to 7)'), {
    target: { value: '5' },
  })
  fireEvent.click(within(section).getByRole('checkbox', { name: /Audit every step/ }))
  fireEvent.click(await fillLeadJob(dialog))
  await waitFor(() => expect(state.orchestrationBodies.length).toBe(1))
  expect(state.orchestrationBodies[0]!.helpers).toMatchObject({
    maxSteps: null,
    autoVote: true,
    autoVoteK: 5,
    autoAudit: true,
  })
})

test('automatic votes are off and disabled when you approve every step (3.14)', async () => {
  open('/b?start=job')
  const dialog = await startDialog()
  const section = dialog.querySelector('details.start-helpers') as HTMLDetailsElement
  fireEvent.click(within(section).getByRole('checkbox', { name: 'builder' }))
  fireEvent.click(within(section).getByRole('checkbox', { name: /Vote on every step/ }))
  fireEvent.click(within(dialog).getByRole('radio', { name: 'The plan starts' }))
  const vote = within(section).getByRole('checkbox', {
    name: /Vote on every step/,
  }) as HTMLInputElement
  expect(vote.disabled).toBe(true)
  expect(vote.checked).toBe(false)
  expect(within(section).getByText(/the vote is then yours/)).toBeDefined()
  fireEvent.click(await fillLeadJob(dialog))
  await waitFor(() => expect(state.orchestrationBodies.length).toBe(1))
  expect(state.orchestrationBodies[0]!.helpers).toMatchObject({ autoVote: false, maxSteps: 20 })
})

test('no helpers picked means no helpers in the body (3.15)', async () => {
  open('/b?start=job')
  const dialog = await startDialog()
  fireEvent.click(await fillLeadJob(dialog))
  await waitFor(() => expect(state.orchestrationBodies.length).toBe(1))
  expect(state.orchestrationBodies[0]).not.toHaveProperty('helpers')
})

test('the scan folder follows the check folder and shows on the folded summary (3.15)', async () => {
  open('/b?start=job')
  const dialog = await startDialog()
  const section = dialog.querySelector('details.start-helpers') as HTMLDetailsElement
  fireEvent.change(within(dialog).getByLabelText('Command'), { target: { value: 'pnpm test' } })
  fireEvent.change(within(dialog).getByLabelText('Folder'), { target: { value: '/work/app' } })
  fireEvent.click(within(section).getByRole('checkbox', { name: 'builder' }))
  fireEvent.click(within(section).getByRole('checkbox', { name: 'Scan the project first' }))
  expect((within(section).getByLabelText('Scan folder') as HTMLInputElement).value).toBe(
    '/work/app',
  )
  expect(section.querySelector('summary')!.textContent).toContain('scans /work/app')
})

test('a dropped lead pick does not come back: builder helper, builder lead, then another lead (3.15)', async () => {
  state.codingLead = 'coder'
  open('/b?start=job')
  const dialog = await startDialog()
  const section = dialog.querySelector('details.start-helpers') as HTMLDetailsElement
  fireEvent.click(within(section).getByRole('checkbox', { name: 'builder' }))
  fireEvent.change(within(dialog).getByLabelText('Advisor'), { target: { value: 'builder' } })
  const planner = await within(dialog).findByLabelText('Who plans it')
  fireEvent.change(planner, { target: { value: 'builder' } })
  await waitFor(() =>
    expect(within(section).queryByRole('checkbox', { name: 'builder' })).toBeNull(),
  )
  fireEvent.change(planner, { target: { value: 'reviewer' } })
  const back = await waitFor(() => within(section).getByRole('checkbox', { name: 'builder' }))
  expect((back as HTMLInputElement).checked).toBe(false)
  expect((within(dialog).getByLabelText('Advisor') as HTMLSelectElement).value).toBe('')
})

test('voters are chosen apart from helpers, never the lead, and sent as voterIds with the preflight (3.13.1)', async () => {
  open('/b?start=job')
  const dialog = await startDialog()
  const section = dialog.querySelector('details.start-helpers') as HTMLDetailsElement
  expect(within(section).queryByRole('checkbox', { name: 'Votes: lead' })).toBeNull()
  fireEvent.click(within(section).getByRole('checkbox', { name: 'builder' }))
  fireEvent.click(within(section).getByRole('checkbox', { name: 'Votes: designer' }))
  await waitFor(() =>
    expect(state.preflightUrls.some((ids) => ids.split(',').includes('designer'))).toBe(true),
  )
  fireEvent.click(await fillLeadJob(dialog))
  await waitFor(() => expect(state.orchestrationBodies.length).toBe(1))
  expect(state.orchestrationBodies[0]!.helpers).toMatchObject({
    agentIds: ['builder'],
    voterIds: ['designer'],
  })
})

test('no voters picked means no voterIds in the body (3.13.1)', async () => {
  open('/b?start=job')
  const dialog = await startDialog()
  const section = dialog.querySelector('details.start-helpers') as HTMLDetailsElement
  fireEvent.click(within(section).getByRole('checkbox', { name: 'builder' }))
  fireEvent.click(await fillLeadJob(dialog))
  await waitFor(() => expect(state.orchestrationBodies.length).toBe(1))
  expect(state.orchestrationBodies[0]!.helpers).not.toHaveProperty('voterIds')
})

test('a voter that becomes the lead is dropped (3.13.1)', async () => {
  state.codingLead = 'coder'
  open('/b?start=job')
  const dialog = await startDialog()
  const section = dialog.querySelector('details.start-helpers') as HTMLDetailsElement
  fireEvent.click(within(section).getByRole('checkbox', { name: 'Votes: builder' }))
  const planner = await within(dialog).findByLabelText('Who plans it')
  fireEvent.change(planner, { target: { value: 'builder' } })
  await waitFor(() =>
    expect(within(section).queryByRole('checkbox', { name: 'Votes: builder' })).toBeNull(),
  )
  fireEvent.change(planner, { target: { value: 'reviewer' } })
  const back = await waitFor(() =>
    within(section).getByRole('checkbox', { name: 'Votes: builder' }),
  )
  expect((back as HTMLInputElement).checked).toBe(false)
})

test('the launches field prefills from the suggestion, follows the choices, and stops once typed (3.13.1)', async () => {
  state.codingLead = 'coder'
  open('/b?start=job')
  const dialog = await startDialog()
  const section = dialog.querySelector('details.start-helpers') as HTMLDetailsElement
  // The coding agent can take steps, so the field shows with the default (10).
  const field = (await within(dialog).findByLabelText(
    'Coding-agent launches (1–100)',
  )) as HTMLInputElement
  expect(field.value).toBe('10')
  // A coding voter adds the helper steps (20); a coding advisor adds 5.
  fireEvent.click(within(section).getByRole('checkbox', { name: 'builder' }))
  fireEvent.click(within(section).getByRole('checkbox', { name: 'Votes: coder' }))
  await waitFor(() => expect(field.value).toBe('30'))
  fireEvent.change(within(dialog).getByLabelText('Advisor'), { target: { value: 'coder' } })
  await waitFor(() => expect(field.value).toBe('35'))
  fireEvent.change(within(section).getByLabelText('Helper steps (1 to 60)'), {
    target: { value: '10' },
  })
  await waitFor(() => expect(field.value).toBe('25'))
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
