import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  acknowledgement,
  beginStartJobTest,
  endStartJobTest,
  iso,
  open,
  startDialog,
  startJobState,
  workflow,
} from './BoldStartJob-helpers.tsx'

const state = startJobState

beforeEach(beginStartJobTest)
afterEach(endStartJobTest)

/** 3.24.0: the chat header's + Job is gone; Start a job opens from the composer's + menu ("Start a run…"). */
async function openStartFromComposer() {
  fireEvent.click(await screen.findByRole('button', { name: 'Attach, voice and commands' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Start a run…' }))
}

test('?start=job and the room button open the dialog, and the checklist protects Start', async () => {
  open('/b?start=job')
  const dialog = await startDialog()
  expect(dialog.getAttribute('data-protected')).toBe('block')
  expect(dialog.hasAttribute('data-decision')).toBe(true)
  const checks = within(dialog).getByRole('region', { name: 'Before it starts' })
  expect(checks.getAttribute('data-protected')).toBe('block')
  const start = within(dialog).getByRole('button', { name: 'Start the job' })
  expect(start.hasAttribute('disabled')).toBe(true)

  fireEvent.change(within(dialog).getByLabelText('What should the team do?'), {
    target: { value: 'Write the release notes' },
  })
  expect(start.hasAttribute('disabled')).toBe(true)
  fireEvent.click(acknowledgement(dialog))
  await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false))

  // A filled-in form asks before it is thrown away.
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
  fireEvent.click(await within(dialog).findByRole('button', { name: 'Discard' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Start a job' })).toBeNull())
  await openStartFromComposer()
  expect(await startDialog()).toBeDefined()
})

test('the recipe, When and required inputs each block and then unblock Start', async () => {
  open('/b?start=job')
  const dialog = await startDialog()
  const start = within(dialog).getByRole('button', { name: 'Start the job' })
  fireEvent.change(within(dialog).getByLabelText('What should the team do?'), {
    target: { value: 'Write the release notes' },
  })
  fireEvent.click(acknowledgement(dialog))
  await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false))
  expect(within(dialog).getByText('Agents allowed')).toBeDefined()

  fireEvent.click(within(dialog).getByRole('radio', { name: 'None' }))
  expect(within(dialog).queryByText('Agents allowed')).toBeNull()
  await waitFor(() =>
    expect(within(dialog).getByText('The job opens in the team room')).toBeDefined(),
  )

  // A schedule runs as a routine of the lead: the recipe choice goes away and Start stays open.
  fireEvent.click(within(dialog).getByRole('radio', { name: 'On a schedule' }))
  expect(within(dialog).getByRole('combobox', { name: 'Schedule' })).toBeDefined()
  expect(within(dialog).queryByRole('radiogroup', { name: 'Recipe' })).toBeNull()
  await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false))

  fireEvent.click(within(dialog).getByRole('radio', { name: 'Now, once' }))
  fireEvent.click(within(dialog).getByRole('radio', { name: 'lead decides' }))
  await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false))

  fireEvent.click(within(dialog).getByRole('radio', { name: 'Release recipe' }))
  fireEvent.click(within(dialog).getByRole('radio', { name: 'Now, once' }))
  await waitFor(() => expect(within(dialog).getByText(/version 1/)).toBeDefined())
  expect(start.hasAttribute('disabled')).toBe(true)
  expect(within(dialog).getByText('Fill in Topic')).toBeDefined()
  fireEvent.change(within(dialog).getByLabelText(/^Topic/), { target: { value: '2.4' } })
  await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false))
})

test('an archived recipe is not offered', async () => {
  state.extraWorkflows = [
    { ...workflow, id: 'wf_old', name: 'Old recipe', archivedAt: iso },
    { ...workflow, id: 'wf_new', name: 'New recipe' },
  ]
  open('/b?start=job')
  const dialog = await startDialog()
  expect(await within(dialog).findByRole('radio', { name: 'New recipe' })).toBeDefined()
  expect(within(dialog).queryByRole('radio', { name: 'Old recipe' })).toBeNull()
})

test('a ?recipe= link to an archived recipe says so and falls back to lead decides', async () => {
  state.extraWorkflows = [{ ...workflow, id: 'wf_old', name: 'Old recipe', archivedAt: iso }]
  open('/b?start=job&recipe=wf_old')
  const dialog = await startDialog()
  expect(
    await within(dialog).findByText('That recipe is archived. Unarchive it in Recipes to use it.'),
  ).toBeDefined()
  expect(
    within(dialog).getByRole('radio', { name: 'lead decides' }).getAttribute('aria-checked'),
  ).toBe('true')
})

test('existing routines are listed as scheduled jobs', async () => {
  open('/b?start=job')
  const dialog = await startDialog()
  const scheduled = await within(dialog).findByRole('region', { name: 'Scheduled' })
  expect(scheduled.textContent).toContain('Nightly build check')
  expect(scheduled.textContent).toContain('lead · Every weekday at 9:00')
})

test('a failed preflight check keeps Start disabled and names the problem', async () => {
  state.preflightFails = true
  open('/b?start=job')
  const dialog = await startDialog()
  fireEvent.change(within(dialog).getByLabelText('What should the team do?'), {
    target: { value: 'Write the release notes' },
  })
  fireEvent.click(acknowledgement(dialog))
  await waitFor(() => expect(within(dialog).getByText('Hermes is not reachable')).toBeDefined())
  expect(
    within(dialog).getByRole('button', { name: 'Start the job' }).hasAttribute('disabled'),
  ).toBe(true)
})

test('3.13.2: a preflight refusal shows the server’s reason, not "could not be read"', async () => {
  state.preflightRefusal = {
    code: 'unsupported_agent',
    message:
      'swarm-1 has full access. Job steps need a coding agent that is read-only or limited to its workspace.',
  }
  open('/b?start=job')
  const dialog = await startDialog()
  expect(await within(dialog).findByText(/swarm-1 has full access/)).toBeDefined()
  expect(within(dialog).queryByText('The checks could not be read')).toBeNull()
})

test('3.13.2: a long task is never cut; past its limit Start says why', async () => {
  open('/b?start=job')
  const dialog = await startDialog()
  const box = within(dialog).getByLabelText('What should the team do?') as HTMLTextAreaElement
  // Longer than the old 4,000-character cut, within a lead job's 8 KB.
  const long = 'Implement the spec. '.repeat(330)
  fireEvent.change(box, { target: { value: long } })
  expect(box.value).toBe(long)
  expect(box.hasAttribute('maxLength')).toBe(false)
  expect(within(dialog).getByText(/KB of 8\.0 KB/)).toBeDefined()
  fireEvent.change(box, { target: { value: 'x'.repeat(9000) } })
  expect((await within(dialog).findByRole('alert')).textContent).toMatch(
    /too long.*file the agents can read/,
  )
  fireEvent.click(acknowledgement(dialog))
  expect(
    within(dialog).getByRole('button', { name: 'Start the job' }).hasAttribute('disabled'),
  ).toBe(true)
})

test('a trigger created by the dialog shows its address and secret once, in a protected card', async () => {
  open('/b?start=job')
  const dialog = await startDialog()
  fireEvent.change(within(dialog).getByLabelText('What should the team do?'), {
    target: { value: 'Write the release notes' },
  })
  fireEvent.click(acknowledgement(dialog))
  fireEvent.click(within(dialog).getByRole('radio', { name: 'When another app calls' }))
  fireEvent.change(within(dialog).getByLabelText('Trigger name'), {
    target: { value: 'New lead' },
  })
  fireEvent.change(within(dialog).getByLabelText('The app it comes from'), {
    target: { value: 'Tickets' },
  })
  const start = within(dialog).getByRole('button', { name: 'Start the job' })
  await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false))
  fireEvent.click(start)

  expect(await screen.findByRole('heading', { name: 'Trigger created' })).toBeDefined()
  const secret = document.querySelector('.start-secret') as HTMLElement
  expect(secret.getAttribute('data-protected')).toBe('block')
  expect(secret.textContent).toContain('https://score.test/hooks/trg_unit')
  expect(secret.textContent).toContain('whsec_unit_secret')
  expect(state.triggerBody).toMatchObject({
    name: 'New lead',
    app: 'Tickets',
    mapping: { ref: 'ref', title: 'title', link: 'link', details: 'details' },
    template: 'Write the release notes',
    reportBack: { mode: 'off' },
  })

  // The room behind the dialog has its own D10 "Done" filter; this is the result's Done.
  fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Start a job' })).toBeNull())
  await openStartFromComposer()
  const reopened = await startDialog()
  expect(within(reopened).queryByText('whsec_unit_secret')).toBeNull()
})
