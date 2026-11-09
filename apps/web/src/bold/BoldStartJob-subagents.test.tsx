import { fireEvent, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  acknowledgement,
  beginStartJobTest,
  endStartJobTest,
  fillLeadJob,
  open,
  recipeDialog,
  startDialog,
  startJobState,
} from './BoldStartJob-helpers.tsx'

// SA.3 part 9: the Subagents choice in Start a job, and what each path sends for it.

const state = startJobState
const subagents = (dialog: HTMLElement) =>
  within(dialog.querySelector('fieldset.start-subagents') as HTMLElement)

beforeEach(beginStartJobTest)
afterEach(endStartJobTest)

test('on, up to the lead’s limit, a total of 20: the default is sent with a lead-decides run’s topic', async () => {
  open('/b?start=job')
  const dialog = await startDialog()
  expect(
    await subagents(dialog).findByText('At once. lead’s limit is 4; set in its settings.'),
  ).toBeDefined()
  expect(subagents(dialog).getByRole('radio', { name: '4' }).getAttribute('aria-checked')).toBe(
    'true',
  )
  expect(
    (subagents(dialog).getByLabelText('Total subagents in this job') as HTMLInputElement).value,
  ).toBe('20')
  fireEvent.click(await fillLeadJob(dialog))
  await waitFor(() => expect(state.orchestrationBodies).toHaveLength(1))
  expect(state.orchestrationBodies[0]!.topic).toMatchObject({
    subagents: { enabled: true, maxConcurrent: 4, maxTotal: 20 },
  })
})

test('Off sends enabled false, and a count and total are sent when chosen', async () => {
  open('/b?start=job')
  const dialog = await startDialog()
  fireEvent.click(subagents(dialog).getByRole('radio', { name: 'Off' }))
  fireEvent.click(await fillLeadJob(dialog))
  await waitFor(() => expect(state.orchestrationBodies).toHaveLength(1))
  expect(state.orchestrationBodies[0]!.topic).toMatchObject({ subagents: { enabled: false } })
  expect(state.orchestrationBodies[0]!.topic).not.toHaveProperty('subagents.maxTotal')
})

test('a lower count and a total go into the request', async () => {
  open('/b?start=job')
  const dialog = await startDialog()
  fireEvent.click(subagents(dialog).getByRole('radio', { name: '2' }))
  fireEvent.change(subagents(dialog).getByLabelText('Total subagents in this job'), {
    target: { value: '50' },
  })
  fireEvent.click(await fillLeadJob(dialog))
  await waitFor(() => expect(state.orchestrationBodies).toHaveLength(1))
  expect(state.orchestrationBodies[0]!.topic).toMatchObject({
    subagents: { enabled: true, maxConcurrent: 2, maxTotal: 50 },
  })
})

test('an invalid total blocks Start with the reason', async () => {
  open('/b?start=job')
  const dialog = await startDialog()
  const start = await fillLeadJob(dialog)
  fireEvent.change(subagents(dialog).getByLabelText('Total subagents in this job'), {
    target: { value: '0' },
  })
  expect(within(dialog).getByText('The total must be a whole number from 1 to 500')).toBeDefined()
  expect((start as HTMLButtonElement).disabled).toBe(true)
})

test('Claude Code (on_off): Off and On only, and On sends no count', async () => {
  state.subagentControl = 'on_off'
  open('/b?start=job')
  const dialog = await startDialog()
  expect(await subagents(dialog).findByRole('radio', { name: 'On' })).toBeDefined()
  expect(subagents(dialog).queryByRole('radio', { name: '4' })).toBeNull()
  fireEvent.click(subagents(dialog).getByRole('radio', { name: 'On' }))
  fireEvent.click(await fillLeadJob(dialog))
  await waitFor(() => expect(state.orchestrationBodies).toHaveLength(1))
  expect(state.orchestrationBodies[0]!.topic).toMatchObject({
    subagents: { enabled: true, maxConcurrent: null, maxTotal: 20 },
  })
})

test('a program Score can’t govern says so, and its subagents are sent off', async () => {
  state.subagentControl = 'none'
  open('/b?start=job')
  const dialog = await startDialog()
  expect(await subagents(dialog).findByText('Subagents aren’t supported here yet.')).toBeDefined()
  expect(subagents(dialog).queryByRole('radio', { name: 'On' })).toBeNull()
  fireEvent.click(await fillLeadJob(dialog))
  await waitFor(() => expect(state.orchestrationBodies).toHaveLength(1))
  expect(state.orchestrationBodies[0]!.topic).toMatchObject({ subagents: { enabled: false } })
})

test('settings that can’t be read: the reason shows and no subagents are sent', async () => {
  state.subagentControl = 'error'
  open('/b?start=job')
  const dialog = await startDialog()
  expect(await subagents(dialog).findByText(/Couldn’t read lead’s subagent settings/)).toBeDefined()
  fireEvent.click(await fillLeadJob(dialog))
  await waitFor(() => expect(state.orchestrationBodies).toHaveLength(1))
  expect(state.orchestrationBodies[0]!.topic).not.toHaveProperty('subagents')
})

test('a plain job sends its subagents in the room call', async () => {
  open('/b?start=job')
  const dialog = await startDialog()
  fireEvent.click(await within(dialog).findByRole('radio', { name: 'None' }))
  fireEvent.change(within(dialog).getByLabelText('What should the team do?'), {
    target: { value: 'Write the notes' },
  })
  fireEvent.click(acknowledgement(dialog))
  const start = within(dialog).getByRole('button', { name: 'Start the job' })
  await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false))
  fireEvent.click(start)
  await waitFor(() => expect(state.roomJobPosts).toHaveLength(1))
  expect(state.roomJobPosts[0]).toMatchObject({
    subagents: { enabled: true, maxConcurrent: 4, maxTotal: 20 },
  })
})

test('a saved recipe run sends its subagents in its topic', async () => {
  const dialog = await recipeDialog()
  fireEvent.change(within(dialog).getByLabelText(/Topic|Release/i, { selector: 'textarea' }), {
    target: { value: 'the 2.4 release' },
  })
  fireEvent.click(acknowledgement(dialog))
  const start = within(dialog).getByRole('button', { name: 'Start the job' })
  await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false))
  fireEvent.click(start)
  await waitFor(() => expect(state.workflowRunBodies).toHaveLength(1))
  expect(state.workflowRunBodies[0]).toMatchObject({
    topic: { subagents: { enabled: true, maxConcurrent: 4, maxTotal: 20 } },
  })
})

test('the helpers picker and its limits are gone for new jobs (SA.3)', async () => {
  open('/b?start=job')
  const dialog = await startDialog()
  for (const text of [
    'Helper agents (1 to 4)',
    'Helper steps (1 to 60)',
    'No limit (until the job ends)',
    'Audit every step after it finishes',
    'Scan the project first',
    'When the helpers split on a vote',
  ])
    expect(within(dialog).queryByText(text)).toBeNull()
  expect(within(dialog).queryByLabelText('At once (1 to 6)')).toBeNull()
})
