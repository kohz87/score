import { fireEvent, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { agents, jsonResponse, makeJob, renderInRoom } from './room-test-utils.tsx'
import { BoldTeamRoom } from './BoldTeamRoom.tsx'
import { setupRoomTest, stubRoom } from './BoldTeamRoom-helpers.tsx'

setupRoomTest()

/**
 * An older room (routed by @mentions) handles `/effort` and `@agent /effort` as commands, and nothing else changes: its other
 * words are sent as text, with no "I don't know" notice (decision 178).
 */
function stubOlder(commands: boolean) {
  const base = stubRoom([makeJob({ id: 'job-old', title: '#activity-feed' })], { older: true })
  const efforts: { url: string; method: string }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.includes('/efforts')) efforts.push({ url, method })
      if (method === 'PUT' && url.includes('/efforts/'))
        return jsonResponse({ roomId: 'room-old', agentId: 'builder', effort: 'high' })
      if (url.includes('/rooms/room-old/efforts') && method === 'GET')
        return jsonResponse({ asOfSeq: 0, items: [] })
      // A named job keeps the room off its empty state, where the chat's own lines are not shown.
      if (url.includes('/api/rooms/room-old/jobs') && method === 'GET')
        return jsonResponse({
          asOfSeq: 1,
          items: [
            makeJob({ id: 'job-feed', roomId: 'room-old', title: 'Feed work', isDefault: false }),
          ],
        })
      if (commands && url.endsWith('/api/commands')) return jsonResponse({ items: [] })
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
  const posted = () =>
    base.mock.calls
      .filter(([url, init]) => String(url).includes('/messages') && init?.method === 'POST')
      .map(([, init]) => (JSON.parse(String(init?.body)) as { text: string }).text)
  return { efforts, posted }
}

async function send(text: string) {
  const composer = await screen.findByRole('combobox', { name: /^Message #activity-feed/ })
  fireEvent.change(composer, { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
}

test('@builder /effort high in an older room sets that agent for this chat and posts nothing', async () => {
  const { efforts, posted } = stubOlder(false)
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b?room=room-old'])
  await send('@builder /effort high')
  expect(await screen.findByText(/You set builder’s effort to high for this chat/)).toBeDefined()
  expect(
    efforts.some((call) => call.method === 'PUT' && call.url.endsWith('/efforts/builder')),
  ).toBe(true)
  expect(posted()).toEqual([])
})

test('a bare /effort high in an older room with no one addressed says who, and posts nothing', async () => {
  const { efforts, posted } = stubOlder(false)
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b?room=room-old'])
  await send('/effort high')
  expect(await screen.findByText(/Say who: @agent \/effort <level>/)).toBeDefined()
  expect(efforts.some((call) => call.method === 'PUT')).toBe(false)
  expect(posted()).toEqual([])
})

test('an older room sends its other slash words as text, with no "I don’t know" notice', async () => {
  const { posted } = stubOlder(true)
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b?room=room-old'])
  await send('/nonsense this')
  await waitFor(() => expect(posted()).toEqual(['/nonsense this']))
  expect(screen.queryByText(/I don’t know \/nonsense/)).toBeNull()
})
