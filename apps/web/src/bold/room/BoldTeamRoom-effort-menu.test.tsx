import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { agents, jsonResponse, makeJob, renderInRoom } from './room-test-utils.tsx'
import { BoldTeamRoom } from './BoldTeamRoom.tsx'
import { setupRoomTest, stubRoom } from './BoldTeamRoom-helpers.tsx'

setupRoomTest()

/** Decision 178, part 2 in a group: `@reviewer /eff` opens the effort choices for reviewer; a pick keeps the mention. */
function stubEfforts(base: ReturnType<typeof stubRoom>) {
  const efforts: { url: string; method: string }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.includes('/efforts')) efforts.push({ url, method })
      if (method === 'PUT' && url.includes('/efforts/'))
        return jsonResponse({ roomId: 'room-1', agentId: 'reviewer', effort: 'max' })
      if (url.includes('/rooms/') && url.endsWith('/efforts') && method === 'GET')
        return jsonResponse({ asOfSeq: 0, items: [] })
      const agent = /\/agents\/([^/]+)\/efforts$/.exec(url)?.[1]
      if (agent)
        return jsonResponse({
          agentId: agent,
          own: 'medium',
          levels: ['low', 'medium', 'high', 'max'],
          chats: [],
        })
      return base(input, init)
    }),
  )
  return efforts
}

function messagePosts(base: ReturnType<typeof stubRoom>) {
  return base.mock.calls.filter(
    ([url, init]) => String(url).includes('/messages') && init?.method === 'POST',
  )
}

test('@reviewer /eff opens reviewer’s effort choices; picking max keeps the mention and sets reviewer', async () => {
  const base = stubRoom([makeJob({ id: 'job-1', title: 'Activity feed' })])
  const efforts = stubEfforts(base)
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  const composer = await screen.findByRole('combobox', { name: /^Message Team room/ })
  fireEvent.change(composer, { target: { value: '@reviewer /eff' } })
  const list = await screen.findByRole('listbox', { name: 'Commands' })
  expect(within(list).getByText(/Effort for reviewer in this chat/)).toBeTruthy()
  expect(within(list).getByText('/effort max')).toBeTruthy()
  expect(within(list).getByText('/effort default')).toBeTruthy()

  fireEvent.click(within(list).getByText('/effort max'))
  expect((composer as HTMLTextAreaElement).value).toBe('@reviewer /effort max ')
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  expect(await screen.findByText(/You set reviewer’s effort to max for this chat/)).toBeDefined()
  expect(
    efforts.some((call) => call.method === 'PUT' && call.url.endsWith('/efforts/reviewer')),
  ).toBe(true)
  expect(messagePosts(base)).toHaveLength(0)
  await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe(''))
})

test('Enter on the open @reviewer /eff palette completes the first choice, and a second Enter sends it', async () => {
  const base = stubRoom([makeJob({ id: 'job-1', title: 'Activity feed' })])
  const efforts = stubEfforts(base)
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  const composer = await screen.findByRole('combobox', { name: /^Message Team room/ })
  fireEvent.change(composer, { target: { value: '@reviewer /effort' } })
  await screen.findByRole('listbox', { name: 'Commands' })
  fireEvent.keyDown(composer, { key: 'Enter' })
  expect((composer as HTMLTextAreaElement).value).toBe('@reviewer /effort low ')
  fireEvent.keyDown(composer, { key: 'Enter' })
  await waitFor(() =>
    expect(
      efforts.some((call) => call.method === 'PUT' && call.url.endsWith('/efforts/reviewer')),
    ).toBe(true),
  )
  expect(messagePosts(base)).toHaveLength(0)
})

test('other commands after an @agent mention open no palette, and a level reviewer does not take is refused', async () => {
  const base = stubRoom([makeJob({ id: 'job-1', title: 'Activity feed' })])
  stubEfforts(base)
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  const composer = await screen.findByRole('combobox', { name: /^Message Team room/ })
  fireEvent.change(composer, { target: { value: '@reviewer /orchestrate' } })
  expect(screen.queryByRole('listbox', { name: 'Commands' })).toBeNull()
  fireEvent.change(composer, { target: { value: '@reviewer /effort turbo' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  expect(
    await screen.findByText(/reviewer takes low, medium, high, max\. Nothing was sent\./),
  ).toBeDefined()
  expect(messagePosts(base)).toHaveLength(0)
})
