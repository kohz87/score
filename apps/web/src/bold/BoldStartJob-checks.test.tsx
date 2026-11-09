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

test('a check is folded, needs the folder, and starting asks for the password first (3.13)', async () => {
  state.orchestrationReply = () =>
    Response.json(
      { error: { code: 'invalid_check', message: 'That folder is outside your workspace roots.' } },
      { status: 400 },
    )
  open('/b?start=job')
  const dialog = await startDialog()
  const section = dialog.querySelector('details.start-check') as HTMLDetailsElement
  expect(section.open).toBe(false)
  expect(section.getAttribute('data-protected')).toBe('block')
  expect(
    within(section).getByText(/Score runs this command in the folder, without a shell/),
  ).toBeDefined()
  const start = await fillLeadJob(dialog)

  fireEvent.change(within(dialog).getByLabelText('Command'), { target: { value: 'pnpm test' } })
  // No folder known yet: Start is blocked and says why.
  await waitFor(() => expect(start.hasAttribute('disabled')).toBe(true))
  expect(within(dialog).getByText(/absolute folder/)).toBeDefined()
  fireEvent.change(within(dialog).getByLabelText('Folder'), { target: { value: '/work/site' } })
  fireEvent.click(within(dialog).getByLabelText('Also run after every step'))
  fireEvent.change(within(dialog).getByLabelText('Timeout (minutes, 1 to 60)'), {
    target: { value: '5' },
  })
  await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false))

  fireEvent.click(start)
  const confirm = await within(dialog).findByRole('form', { name: 'Confirm it’s you' })
  expect(confirm.getAttribute('data-protected')).toBe('block')
  // Nothing was posted before the person proved it.
  expect(state.calls).toEqual([])
  fireEvent.change(within(confirm).getByLabelText('Security password'), {
    target: { value: 'correct horse' },
  })
  fireEvent.click(within(confirm).getByRole('button', { name: 'Confirm and start' }))

  // The server's own words for a refused check show inline.
  expect(await within(dialog).findByText(/outside your workspace roots/)).toBeDefined()
  expect(state.calls).toEqual(['security-check', 'orchestrations'])
  expect(state.orchestrationBodies[0]).toMatchObject({
    check: { command: 'pnpm test', workspace: '/work/site', timeoutSec: 300, when: 'each_step' },
  })
})

test('a job without a check posts none and starts without the password prompt (3.13)', async () => {
  open('/b?start=job')
  const dialog = await startDialog()
  const start = await fillLeadJob(dialog)
  fireEvent.click(start)
  await waitFor(() => expect(state.calls).toEqual(['orchestrations']))
  expect(state.orchestrationBodies[0]).not.toHaveProperty('check')
  expect(within(dialog).queryByRole('form', { name: 'Confirm it’s you' })).toBeNull()
})

test('a check, an advisor and voters together: one body, and nothing posted before the password (3.13-3.15)', async () => {
  open('/b?start=job')
  const dialog = await startDialog()
  const section = dialog.querySelector('fieldset.start-voters') as HTMLFieldSetElement
  fireEvent.change(within(dialog).getByLabelText('Advisor'), { target: { value: 'reviewer' } })
  // SA.3: voters are picked from Add (the helpers picker is gone for new jobs).
  fireEvent.click(within(section).getByRole('button', { name: 'Add' }))
  fireEvent.click(within(section).getByRole('button', { name: 'builder' }))
  fireEvent.click(within(section).getByRole('button', { name: 'Add' }))
  fireEvent.click(within(section).getByRole('button', { name: 'designer' }))
  fireEvent.change(within(dialog).getByLabelText('Command'), { target: { value: 'pnpm test' } })
  fireEvent.change(within(dialog).getByLabelText('Folder'), { target: { value: '/work/site' } })
  const start = await fillLeadJob(dialog)
  fireEvent.click(start)
  const confirm = await within(dialog).findByRole('form', { name: 'Confirm it’s you' })
  expect(state.calls).toEqual([])
  expect(state.orchestrationBodies).toEqual([])
  // Focus moves to the password field when the form appears.
  await waitFor(() =>
    expect(document.activeElement).toBe(within(confirm).getByLabelText('Security password')),
  )
  fireEvent.change(within(confirm).getByLabelText('Security password'), {
    target: { value: 'correct horse' },
  })
  fireEvent.click(within(confirm).getByRole('button', { name: 'Confirm and start' }))
  await waitFor(() => expect(state.orchestrationBodies.length).toBe(1))
  expect(state.calls).toEqual(['security-check', 'orchestrations'])
  expect(state.orchestrationBodies[0]).toMatchObject({
    advisorAgentId: 'reviewer',
    helpers: { agentIds: [], voterIds: ['builder', 'designer'] },
    check: { command: 'pnpm test', workspace: '/work/site' },
  })
})

test('a wrong password shows inline and posts nothing; a fresh_auth_required answer re-opens the form (3.13)', async () => {
  state.securityReply = () =>
    Response.json({ error: { code: 'wrong_password', message: 'no' } }, { status: 401 })
  open('/b?start=job')
  const dialog = await startDialog()
  fireEvent.change(within(dialog).getByLabelText('Command'), { target: { value: 'pnpm test' } })
  fireEvent.change(within(dialog).getByLabelText('Folder'), { target: { value: '/work/site' } })
  fireEvent.click(await fillLeadJob(dialog))
  let confirm = await within(dialog).findByRole('form', { name: 'Confirm it’s you' })
  fireEvent.change(within(confirm).getByLabelText('Security password'), {
    target: { value: 'wrong horse' },
  })
  fireEvent.click(within(confirm).getByRole('button', { name: 'Confirm and start' }))
  expect(await within(confirm).findByText('That is not the security password.')).toBeDefined()
  expect(state.orchestrationBodies).toEqual([])

  state.securityReply = () => Response.json({ ok: true })
  state.orchestrationReply = () =>
    Response.json({ error: { code: 'fresh_auth_required', message: 'again' } }, { status: 403 })
  fireEvent.click(within(confirm).getByRole('button', { name: 'Confirm and start' }))
  await waitFor(() => expect(state.orchestrationBodies.length).toBe(1))
  confirm = await within(dialog).findByRole('form', { name: 'Confirm it’s you' })
  expect(within(confirm).getByText(/Confirm your password or passkey again/)).toBeDefined()
})

test('a bad check timeout opens the folded check section so the reason is visible (3.13)', async () => {
  open('/b?start=job')
  const dialog = await startDialog()
  const section = dialog.querySelector('details.start-check') as HTMLDetailsElement
  fireEvent.change(within(dialog).getByLabelText('Command'), { target: { value: 'pnpm test' } })
  await waitFor(() => expect(section.open).toBe(true))
})
