import { screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { agents, disposeRoomTest, jsonResponse, renderInRoom } from './room-test-utils.tsx'
import { ContextBar } from './ContextBar.tsx'

/** Decision 178, part 3 wiring: the context bar's Effort button for the agent the message goes to, only when this chat sets one. */
afterEach(() => {
  disposeRoomTest()
  vi.unstubAllGlobals()
})

function stub(items: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/rooms/room-1/efforts')) return jsonResponse({ asOfSeq: 0, items })
      if (url.endsWith('/agents/lead/efforts'))
        return jsonResponse({
          agentId: 'lead',
          own: 'medium',
          levels: ['low', 'high', 'max'],
          chats: [],
        })
      return jsonResponse({}, 404)
    }),
  )
}

function bar(subjectId: string | null, to: string[] = []) {
  return (
    <ContextBar
      roomId="room-1"
      to={to}
      subjectId={subjectId}
      agents={agents}
      ownerId="lead"
      topic={undefined}
      runEffort={async () => undefined}
    />
  )
}

test('the context bar offers Effort for the agent the message goes to when this chat sets one', async () => {
  stub([{ roomId: 'room-1', agentId: 'lead', effort: 'high' }])
  renderInRoom(bar('lead'))
  expect(await screen.findByRole('button', { name: /Effort in this chat: high/ })).toBeTruthy()
})

test('no Effort button when this chat sets nothing for that agent', async () => {
  stub([])
  renderInRoom(bar('lead', ['lead']))
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(screen.queryByRole('button', { name: /Effort in this chat/ })).toBeNull()
})
