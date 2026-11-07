import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  beginStartJobTest,
  endStartJobTest,
  fillLeadJob,
  iso,
  open,
  startDialog,
  startJobState,
} from './BoldStartJob-helpers.tsx'

const state = startJobState

beforeEach(beginStartJobTest)
afterEach(endStartJobTest)

// 3.28.0 (decision 164): one job per chat. Starting work into a chat that has a job asks first.
const runningJob = {
  id: 'job-running',
  roomId: 'team-room',
  title: 'Story suite prompts',
  state: 'working',
  holderAgentId: 'lead',
  isDefault: false,
  exchangeBudget: 8,
  jobTurnLimit: 40,
  unread: 0,
  activeAgents: [],
  lastMessageAt: null,
  messageCount: 0,
  summary: null,
  source: null,
  reportBack: null,
  spendCapUsd: null,
  recipe: null,
  createdAt: iso,
  updatedAt: iso,
}
const ownThread = {
  ...runningJob,
  id: 'job-own',
  title: 'Team room',
  isDefault: true,
  state: 'open',
}

async function busyDialog() {
  return screen.findByRole('dialog', { name: 'Team room already has a job' })
}

test('3.28.0: starting into a chat that has a job opens the busy dialog first and posts nothing', async () => {
  state.teamJobs = [ownThread, runningJob]
  open('/b?start=job')
  const dialog = await startDialog()
  const start = await fillLeadJob(dialog)
  // Wait for the room's jobs to arrive: the busy check reads them.
  await waitFor(() =>
    expect(
      vi.mocked(fetch).mock.calls.some(([u]) => String(u).includes('/rooms/team-room/jobs')),
    ).toBe(true),
  )
  fireEvent.click(start)
  const busy = await busyDialog()
  expect(busy.getAttribute('data-protected')).toBe('block')
  expect(busy.textContent).toContain(
    '“Story suite prompts” is still running. A chat does one job at a time, so stop it first, or start this in another chat.',
  )
  expect(busy.textContent).toContain('New:')
  expect(busy.textContent).toContain('Fix the failing tests')
  expect(busy.textContent).toContain(
    'Stopping ends the running steps and keeps what the job made. It moves to Past jobs.',
  )
  expect(state.calls).toEqual([])
  // Cancel closes the dialog and keeps the form.
  fireEvent.click(within(busy).getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('dialog', { name: 'Team room already has a job' })).toBeNull()
  expect(
    (within(dialog).getByLabelText('What should the team do?') as HTMLTextAreaElement).value,
  ).toBe('Fix the failing tests')
})

test('3.28.0: a 409 job_running from the server opens the busy dialog; Stop the job and start this ends it, then starts', async () => {
  let started = 0
  state.orchestrationReply = () => {
    started += 1
    if (started === 1)
      return Response.json(
        {
          error: {
            code: 'job_running',
            message: 'This chat already has a job.',
            details: { jobId: 'job-running', title: 'Story suite prompts' },
          },
        },
        { status: 409 },
      )
    return Response.json({ error: { code: 'internal', message: 'no' } }, { status: 500 })
  }
  state.endReply = () => Response.json({ ...runningJob, state: 'closed' })
  open('/b?start=job')
  const dialog = await startDialog()
  fireEvent.click(await fillLeadJob(dialog))
  const busy = await busyDialog()
  fireEvent.click(within(busy).getByRole('button', { name: 'Stop the job and start this' }))
  await waitFor(() => expect(state.calls).toEqual(['orchestrations', 'job-end', 'orchestrations']))
  // The retry was a new attempt (a new idempotency key, not the refused one replayed).
  expect(state.orchestrationBodies).toHaveLength(2)
  expect(screen.queryByRole('dialog', { name: 'Team room already has a job' })).toBeNull()
})

test('3.28.0: if the retry still answers 409, the dialog says it is still stopping', async () => {
  state.orchestrationReply = () =>
    Response.json(
      {
        error: {
          code: 'job_running',
          message: 'This chat already has a job.',
          details: { jobId: 'job-running', title: 'Story suite prompts' },
        },
      },
      { status: 409 },
    )
  state.endReply = () => Response.json({ ...runningJob, state: 'closed' })
  open('/b?start=job')
  const dialog = await startDialog()
  fireEvent.click(await fillLeadJob(dialog))
  const busy = await busyDialog()
  fireEvent.click(within(busy).getByRole('button', { name: 'Stop the job and start this' }))
  expect(await screen.findByText('Still stopping… try again in a moment.')).toBeDefined()
})

test('3.28.0: Start in another chat keeps the work and asks for the chat, without offering the busy one', async () => {
  state.orchestrationReply = () =>
    Response.json(
      {
        error: {
          code: 'job_running',
          message: 'This chat already has a job.',
          details: { jobId: 'job-running', title: 'Story suite prompts' },
        },
      },
      { status: 409 },
    )
  open('/b?start=job')
  const dialog = await startDialog()
  fireEvent.click(await fillLeadJob(dialog))
  const busy = await busyDialog()
  fireEvent.click(within(busy).getByRole('button', { name: 'Start in another chat…' }))
  const picker = await within(dialog).findByLabelText('Start it in')
  expect(
    (within(dialog).getByLabelText('What should the team do?') as HTMLTextAreaElement).value,
  ).toBe('Fix the failing tests')
  const options = within(picker)
    .getAllByRole('option')
    .map((option) => option.textContent)
  expect(options).toEqual(['Choose a chat…', 'Design crew'])
  // Until a chat is chosen nothing can start.
  expect(
    within(dialog).getByRole('button', { name: 'Start the job' }).hasAttribute('disabled'),
  ).toBe(true)
  fireEvent.change(picker, { target: { value: 'design-crew' } })
  const start = within(dialog).getByRole('button', { name: 'Start the job' })
  await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false))
  fireEvent.click(start)
  await waitFor(() => expect(state.orchestrationBodies).toHaveLength(2))
  expect(state.orchestrationBodies[1]).toMatchObject({
    goal: 'Fix the failing tests',
    topic: { roomId: 'design-crew' },
  })
})

test('3.28.0 review: Stop the job and start this still asks for the password when the run has a check', async () => {
  state.teamJobs = [ownThread, runningJob]
  state.orchestrationReply = () =>
    Response.json({ error: { code: 'internal', message: 'no' } }, { status: 500 })
  state.endReply = () => Response.json({ ...runningJob, state: 'closed' })
  open('/b?start=job')
  const dialog = await startDialog()
  const start = await fillLeadJob(dialog)
  await waitFor(() =>
    expect(
      vi.mocked(fetch).mock.calls.some(([u]) => String(u).includes('/rooms/team-room/jobs')),
    ).toBe(true),
  )
  fireEvent.change(within(dialog).getByLabelText('Command'), { target: { value: 'pnpm test' } })
  fireEvent.change(within(dialog).getByLabelText('Folder'), { target: { value: '/work/site' } })
  await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false))
  fireEvent.click(start)
  const busy = await busyDialog()
  fireEvent.click(within(busy).getByRole('button', { name: 'Stop the job and start this' }))
  // The job ends, then the password step comes before anything starts.
  const confirm = await within(dialog).findByRole('form', { name: 'Confirm it’s you' })
  expect(state.calls).toEqual(['job-end'])
  fireEvent.change(within(confirm).getByLabelText('Security password'), {
    target: { value: 'correct horse' },
  })
  fireEvent.click(within(confirm).getByRole('button', { name: 'Confirm and start' }))
  // The stopped job isn't asked about again while the room catches up: the start goes to the server.
  await waitFor(() => expect(state.calls).toEqual(['job-end', 'security-check', 'orchestrations']))
  expect(screen.queryByRole('dialog', { name: 'Team room already has a job' })).toBeNull()
})
