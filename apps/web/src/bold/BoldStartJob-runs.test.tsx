import { fireEvent, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  acknowledgement,
  beginStartJobTest,
  endStartJobTest,
  fillLeadJob,
  iso,
  open,
  openWith,
  recipeDialog,
  room,
  startDialog,
  startJobState,
  workflow,
} from './BoldStartJob-helpers.tsx'

const state = startJobState

beforeEach(beginStartJobTest)
afterEach(endStartJobTest)

function chatsFetch(rooms: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://x')
      const body =
        url.pathname === '/api/rooms'
          ? { asOfSeq: 1, rooms, directs: [] }
          : { asOfSeq: 0, items: [], rooms: [], directs: [], projects: [] }
      return Promise.resolve(Response.json(body))
    }),
  )
}

test('3.23.0: a lead-decides run carries its topic in the one call and makes no second job call', async () => {
  open('/b?start=job')
  const dialog = await startDialog()
  fireEvent.click(await fillLeadJob(dialog))
  await waitFor(() => expect(state.orchestrationBodies).toHaveLength(1))
  expect(state.orchestrationBodies[0]).toMatchObject({
    topic: { roomId: 'team-room', title: 'Fix the failing tests' },
  })
  expect(state.orchestrationBodies[0]?.topic).toHaveProperty('exchangeBudget')
  expect(state.calls).toEqual(['orchestrations'])
  expect(state.roomJobPosts).toEqual([])
  // The old "the orchestration exists, the job doesn't" card is gone: the failure stays a plain error.
  expect(within(dialog).queryByText('Create the job again')).toBeNull()
})

test('3.23.0: a recipe run carries its topic in the one call too', async () => {
  const dialog = await recipeDialog()
  fireEvent.change(within(dialog).getByLabelText(/Topic|Release/i, { selector: 'textarea' }), {
    target: { value: 'the 2.4 release' },
  })
  fireEvent.click(acknowledgement(dialog))
  const start = within(dialog).getByRole('button', { name: 'Start the job' })
  await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false))
  fireEvent.click(start)
  await waitFor(() => expect(state.workflowRunBodies).toHaveLength(1))
  expect(state.workflowRunBodies[0]).toMatchObject({ topic: { roomId: 'team-room' } })
  expect(state.roomJobPosts).toEqual([])
})

test('3.23.0: a run answered without its topic shows an error, never a success card with an empty id', async () => {
  state.orchestrationReply = () =>
    Response.json(
      {
        orchestration: {
          id: 'orch-1',
          title: 'Fix the failing tests',
          status: 'running',
          pauseReason: null,
          leadAgentId: 'lead',
          roomId: 'team-room',
          briefId: 'brief-1',
          gatePolicy: 'lead-asks',
          revision: 1,
          ownership: 'owned',
          steps: { total: 0, active: 0, succeeded: 0, failed: 0 },
          leadTurnsUsed: 0,
          maxLeadTurns: 8,
          needsYou: [],
          createdAt: iso,
          updatedAt: iso,
          endedAt: null,
        },
        preflight: state.lastOrchestrationPreflight,
      },
      { status: 201 },
    )
  open('/b?start=job')
  const dialog = await startDialog()
  fireEvent.click(await fillLeadJob(dialog))
  expect(
    await within(dialog).findByText(
      'The run started but Score didn’t get its topic; open it from Recipes.',
    ),
  ).toBeDefined()
  expect(within(dialog).queryByText(/Open the job|Open it/)).toBeNull()
})

test('3.23.0: a plain job (recipe None) still makes its job with the room call', async () => {
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
  expect(state.roomJobPosts[0]).not.toHaveProperty('recipe')
  expect(state.orchestrationBodies).toEqual([])
})

test('3.23.0: /run <name> preselects the saved recipe with that name, in any case', async () => {
  openWith({ roomId: 'team-room', recipeName: 'RELEASE recipe' })
  const dialog = await startDialog()
  await waitFor(() =>
    expect(
      within(dialog).getByRole('radio', { name: 'Release recipe' }).getAttribute('aria-checked'),
    ).toBe('true'),
  )
  expect(within(dialog).queryByText(/No saved recipe is called/)).toBeNull()
})

test('3.23.0: /run <name> with no such recipe opens on lead decides and says so', async () => {
  openWith({ roomId: 'team-room', recipeName: 'Nothing like it' })
  const dialog = await startDialog()
  expect(
    await within(dialog).findByText(/No saved recipe is called “Nothing like it”/),
  ).toBeDefined()
  expect(
    within(dialog).getByRole('radio', { name: 'lead decides' }).getAttribute('aria-checked'),
  ).toBe('true')
})

test('3.23.0: several recipes with the same name are not guessed at', async () => {
  state.extraWorkflows = [{ ...workflow, id: 'wf_other' }]
  openWith({ roomId: 'team-room', recipeName: 'release recipe' })
  const dialog = await startDialog()
  expect(await within(dialog).findByText(/More than one recipe is called/)).toBeDefined()
})

test('3.23.0: a run asked for in a direct chat is refused in the checklist', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://x')
      const body =
        url.pathname === '/api/rooms'
          ? { asOfSeq: 1, rooms: [], directs: [{ ...room, id: 'direct-1', kind: 'direct' }] }
          : { asOfSeq: 0, items: [], rooms: [], directs: [], projects: [] }
      return Promise.resolve(Response.json(body))
    }),
  )
  openWith({ roomId: 'direct-1' })
  const dialog = await startDialog()
  expect(await within(dialog).findByText('Runs start in a group chat.')).toBeDefined()
  expect(
    within(dialog).getByRole('button', { name: 'Start the job' }).hasAttribute('disabled'),
  ).toBe(true)
})

test('3.23.0: a run asked for in an archived chat is refused, never moved to the team room', async () => {
  chatsFetch([{ ...room, id: 'old-chat', name: 'Old chat', archived: true }])
  openWith({ roomId: 'old-chat' })
  const dialog = await startDialog()
  expect(
    await within(dialog).findByText('This chat is archived; unarchive it to start a run here.'),
  ).toBeDefined()
  expect(
    within(dialog).getByRole('button', { name: 'Start the job' }).hasAttribute('disabled'),
  ).toBe(true)
})

test('3.23.0: a run asked for in a chat that does not exist is refused', async () => {
  chatsFetch([])
  openWith({ roomId: 'no-such-chat' })
  const dialog = await startDialog()
  expect(await within(dialog).findByText('Couldn’t find that chat.')).toBeDefined()
  expect(
    within(dialog).getByRole('button', { name: 'Start the job' }).hasAttribute('disabled'),
  ).toBe(true)
})
