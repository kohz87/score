import { fireEvent, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { agents, jsonResponse, makeJob, renderInRoom } from './room-test-utils.tsx'
import { BoldTeamRoom } from './BoldTeamRoom.tsx'
import { setupRoomTest, stubRoom } from './BoldTeamRoom-helpers.tsx'

setupRoomTest()

/** Decision 178, part 2 in a group: `@agent /effort <level>` is a command, never a message; a bare `/effort` needs an addressee. */
test('@reviewer /effort max sets that agent for this chat and is never posted as a message', async () => {
  const base = stubRoom([makeJob({ id: 'job-1', title: 'Activity feed' })])
  const efforts: { url: string; method: string }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.includes('/efforts')) efforts.push({ url, method })
      if (method === 'PUT' && url.endsWith('/efforts/reviewer'))
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
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  const composer = await screen.findByRole('combobox', { name: /^Message Team room/ })
  fireEvent.change(composer, { target: { value: '@reviewer /effort max' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))

  expect(await screen.findByText(/You set reviewer’s effort to max for this chat/)).toBeDefined()
  expect(
    efforts.some((call) => call.method === 'PUT' && call.url.endsWith('/efforts/reviewer')),
  ).toBe(true)
  // Every other request goes to the room's own mock: a message would be a POST there.
  expect(
    base.mock.calls.some(
      ([url, init]) => String(url).includes('/messages') && init?.method === 'POST',
    ),
  ).toBe(false)
  await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe(''))
})

test('a bare /effort with no To chip acts on the agent the footer names (the lead here), not a refusal', async () => {
  const base = stubRoom([makeJob({ id: 'job-1', title: 'Activity feed' })])
  const efforts: { url: string; method: string }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.includes('/efforts')) efforts.push({ url, method })
      if (method === 'PUT' && url.includes('/efforts/'))
        return jsonResponse({ roomId: 'room-1', agentId: 'lead', effort: 'high' })
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
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  const composer = await screen.findByRole('combobox', { name: /^Message Team room/ })
  fireEvent.change(composer, { target: { value: '/effort high' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  expect(await screen.findByText(/You set lead’s effort to high for this chat/)).toBeDefined()
  expect(efforts.some((call) => call.method === 'PUT' && call.url.endsWith('/efforts/lead'))).toBe(
    true,
  )
  expect(
    base.mock.calls.some(
      ([url, init]) => String(url).includes('/messages') && init?.method === 'POST',
    ),
  ).toBe(false)
})
