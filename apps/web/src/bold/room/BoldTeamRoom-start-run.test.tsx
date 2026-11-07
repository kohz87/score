import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { agents, jsonResponse, makeJob, renderInRoom } from './room-test-utils.tsx'
import { BoldTeamRoom } from './BoldTeamRoom.tsx'
import { StartJobContext, type StartJobOptions } from '../BoldStartJob.tsx'
import { lastRequest, setupRoomTest, stubRoom } from './BoldTeamRoom-helpers.tsx'

setupRoomTest()

// 3.28.0: starting work while the chat has a job asks first (the busy dialog), whichever way it was started.
function renderBusy(jobsList = [makeJob({ id: 'job-1', title: 'Story suite prompts' })]) {
  const opened: (StartJobOptions | undefined)[] = []
  const fetchMock = stubRoom(jobsList)
  const fallback = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input, init) => {
    if (String(input) === '/api/jobs/job-1/end' && init?.method === 'POST')
      return jsonResponse(makeJob({ id: 'job-1', title: 'Story suite prompts', state: 'closed' }))
    return fallback(input, init)
  })
  renderInRoom(
    <StartJobContext value={{ openStartJob: (options) => opened.push(options) }}>
      <BoldTeamRoom agents={agents} />
    </StartJobContext>,
    ['/b'],
  )
  return { opened, fetchMock }
}

async function startRunFromMenu() {
  await screen.findByRole('region', { name: 'Current job' })
  fireEvent.click(await screen.findByRole('button', { name: 'Attach, voice and commands' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Start a run…' }))
  return screen.findByRole('dialog', { name: 'Team room already has a job' })
}

test('the + menu’s Start a run… with a job running opens the busy dialog instead of Start a job', async () => {
  const { opened } = renderBusy()
  const dialog = await startRunFromMenu()
  expect(dialog.getAttribute('data-protected')).toBe('block')
  expect(dialog.textContent).toContain('“Story suite prompts” is still running.')
  expect(dialog.textContent).toContain('New: a new run')
  expect(opened).toEqual([])
  // Cancel is where focus starts; Escape cancels and focus goes back to a sensible place (the composer).
  expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }))
  fireEvent.keyDown(dialog, { key: 'Escape' })
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Team room already has a job' })).toBeNull(),
  )
  expect(opened).toEqual([])
  expect(document.activeElement).toBe(screen.getByRole('combobox', { name: /^Message Team room/ }))
})

test('the busy dialog keeps Tab inside it', async () => {
  renderBusy()
  const dialog = await startRunFromMenu()
  const buttons = within(dialog).getAllByRole('button')
  expect(buttons.map((button) => button.textContent)).toEqual([
    'Stop the job and start this',
    'Start in another chat…',
    'Cancel',
  ])
  buttons[2]!.focus()
  fireEvent.keyDown(buttons[2]!, { key: 'Tab' })
  expect(document.activeElement).toBe(buttons[0])
  fireEvent.keyDown(buttons[0]!, { key: 'Tab', shiftKey: true })
  expect(document.activeElement).toBe(buttons[2])
})

test('/run with a job running asks first too, naming the recipe; Stop the job and start this ends it and then opens Start a job', async () => {
  const { opened, fetchMock } = renderBusy()
  await screen.findByRole('region', { name: 'Current job' })
  const composer = await screen.findByRole('combobox', { name: /^Message Team room/ })
  fireEvent.change(composer, { target: { value: '/run Write and review' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  const dialog = await screen.findByRole('dialog', { name: 'Team room already has a job' })
  expect(dialog.textContent).toContain('New: run “Write and review”')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Stop the job and start this' }))
  await waitFor(() => expect(lastRequest(fetchMock, '/api/jobs/job-1/end', 'POST')).toBeDefined())
  await waitFor(() =>
    expect(opened).toEqual([{ roomId: 'room-1', recipeName: 'Write and review' }]),
  )
  expect(screen.queryByRole('dialog', { name: 'Team room already has a job' })).toBeNull()
  // The job ended, so its bar is gone.
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Current job' })).toBeNull())
})

test('Start in another chat… opens Start a job with the chat picker and without the busy chat', async () => {
  const { opened } = renderBusy()
  const dialog = await startRunFromMenu()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Start in another chat…' }))
  expect(opened).toEqual([{ pickChat: true, exceptRoomId: 'room-1' }])
  expect(screen.queryByRole('dialog', { name: 'Team room already has a job' })).toBeNull()
})

test('with no job running, Start a run… goes straight to Start a job', async () => {
  const opened: (StartJobOptions | undefined)[] = []
  stubRoom([makeJob({ id: 'job-1', title: 'Old', state: 'closed' })])
  renderInRoom(
    <StartJobContext value={{ openStartJob: (options) => opened.push(options) }}>
      <BoldTeamRoom agents={agents} />
    </StartJobContext>,
    ['/b'],
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Attach, voice and commands' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Start a run…' }))
  await waitFor(() => expect(opened).toEqual([{ roomId: 'room-1' }]))
  expect(screen.queryByRole('dialog', { name: 'Team room already has a job' })).toBeNull()
})

test('3.30.0 gate: an older chat’s bar follows the job you’re in, as Info and the composer do', async () => {
  stubRoom([
    makeJob({ id: 'job-default', title: 'Team room', isDefault: true }),
    makeJob({ id: 'job-1', title: 'Activity feed', createdAt: '2026-10-24T09:00:00.000Z' }),
    makeJob({ id: 'job-2', title: 'Release notes', createdAt: '2026-10-24T09:30:00.000Z' }),
  ])
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b?job=job-1'])
  const bar = await screen.findByRole('region', { name: 'Current job' })
  await waitFor(() => expect(within(bar).getByText('Activity feed')).toBeDefined())
  expect(within(bar).getByRole('button', { name: '+1 more open' })).toBeDefined()
  expect(screen.getByLabelText('Where this message goes').textContent).toContain('in Activity feed')
})
