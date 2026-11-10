import { QueryClient } from '@tanstack/react-query'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { AgentEfforts, ChatEffortsResponse } from '@score/contract'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { agents, disposeRoomTest, jsonResponse, renderInRoom } from '../room/room-test-utils.tsx'
import { DirectEffortBlock } from './DirectEffortBlock.tsx'
import { EffortControl, EffortTag } from './EffortControl.tsx'
import { runEffortCommand } from './effort-command.ts'

/** Effort per chat, the states that come from a failed or late read: "unknown", the menu's note, focus, and the layout rules. */
afterEach(() => {
  disposeRoomTest()
  vi.unstubAllGlobals()
})

const builder = agents.find((agent) => agent.id === 'builder')!

type Call = { method: string; path: string; body: unknown }

/**
 * Serves one chat's efforts and answers the agent's efforts with `agentStatus` (a 503 when the read fails) once `gate`
 * opens. Every request is recorded.
 */
function stub(
  chat: ChatEffortsResponse['items'],
  options: { agentStatus?: number; gate?: Promise<unknown> } = {},
) {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (method === 'PUT' && path.includes('/rooms/room-1/efforts/')) {
        const body = JSON.parse(String(init?.body)) as { effort: string | null }
        return jsonResponse({ roomId: 'room-1', agentId: builder.id, effort: body.effort })
      }
      if (path.endsWith('/rooms/room-1/efforts')) return jsonResponse({ asOfSeq: 0, items: chat })
      if (path.endsWith(`/agents/${builder.id}/efforts`)) {
        await options.gate
        if (options.agentStatus)
          return jsonResponse(
            { code: 'unavailable', message: 'Score can’t read this agent’s effort.' },
            options.agentStatus,
          )
        return jsonResponse(efforts())
      }
      return jsonResponse({}, 404)
    }),
  )
  return calls
}

const efforts = (over: Partial<AgentEfforts> = {}): AgentEfforts => ({
  agentId: builder.id,
  own: 'medium',
  levels: ['low', 'medium', 'high', 'xhigh', 'max'],
  chats: [],
  ...over,
})

const high: ChatEffortsResponse['items'] = [
  { roomId: 'room-1', agentId: builder.id, effort: 'high' },
]

test('an unreadable own setting reads "unknown", and the menu says the levels can’t be listed, offering only Back to its own', async () => {
  stub([], { agentStatus: 503 })
  renderInRoom(<DirectEffortBlock agent={builder} roomId="room-1" />)
  fireEvent.click(await screen.findByRole('button', { name: /Change effort/ }))
  const menu = await screen.findByRole('menu', { name: `Effort for ${builder.name}` })
  expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(1)
  expect(within(menu).getByRole('menuitemradio', { name: /\/effort default/ })).toBeTruthy()
  expect(
    within(menu).getByText(/Can’t list the levels builder’s model takes right now/),
  ).toBeTruthy()
  expect(menu.textContent).toContain('its own setting is unknown')
  expect(screen.getByText('its own: unknown')).toBeTruthy()
  expect(screen.queryByText(/model’s default/)).toBeNull()
})

test('Back to its own still works from the menu when the levels can’t be read', async () => {
  const calls = stub(high, { agentStatus: 503 })
  renderInRoom(<DirectEffortBlock agent={builder} roomId="room-1" />)
  fireEvent.click(await screen.findByRole('button', { name: /Change effort/ }))
  const menu = await screen.findByRole('menu', { name: `Effort for ${builder.name}` })
  fireEvent.click(within(menu).getByRole('menuitemradio', { name: /\/effort default/ }))
  await waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true))
  expect(calls.find((call) => call.method === 'PUT')!.body).toEqual({ effort: null })
})

test('a level can’t be set while the levels are unknown: nothing is sent, and the chat says why', async () => {
  const calls = stub([], { agentStatus: 503 })
  const say = vi.fn()
  await runEffortCommand({
    roomId: 'room-1',
    roomKind: 'direct',
    agent: builder,
    args: 'high',
    queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    say,
  })
  expect(calls.some((call) => call.method === 'PUT')).toBe(false)
  expect(say).toHaveBeenCalledWith(
    'Score can’t list the levels builder takes right now. Nothing was sent.',
  )
})

test('/effort default still goes back to the own setting when the levels are unknown', async () => {
  const calls = stub(high, { agentStatus: 503 })
  const say = vi.fn()
  await runEffortCommand({
    roomId: 'room-1',
    roomKind: 'direct',
    agent: builder,
    args: 'default',
    queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    say,
  })
  expect(calls.find((call) => call.method === 'PUT')!.body).toEqual({ effort: null })
  expect(say).toHaveBeenCalledWith(
    expect.stringContaining('back on its own effort in this chat (unknown)'),
    expect.objectContaining({ label: 'Undo' }),
  )
})

test('a menu opened before its data arrives takes focus on the checked choice once it renders', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  stub(high, { gate })
  renderInRoom(<EffortControl agent={builder} current="high" runEffort={async () => undefined} />)
  fireEvent.click(await screen.findByRole('button', { name: /Effort in this chat: high/ }))
  expect(screen.queryByRole('menu')).toBeNull()
  release()
  const menu = await screen.findByRole('menu', { name: `Effort for ${builder.name}` })
  const checked = within(menu)
    .getAllByRole('menuitemradio')
    .find((item) => item.getAttribute('aria-checked') === 'true')!
  await waitFor(() => expect(document.activeElement).toBe(checked))
})

test('a Members tag opens its choices from its right edge, so they stay inside the panel', async () => {
  stub(high)
  renderInRoom(<EffortTag agent={builder} current="high" runEffort={async () => undefined} />)
  const choice = document.querySelector('.bold-effort-choice')
  expect(choice?.classList.contains('bold-effort-choice--end')).toBe(true)
})

test('CSS: a phone shows every effort button at 44px, and an end-aligned menu opens leftward from its tag', () => {
  const css = readFileSync(join(__dirname, 'efforts.css'), 'utf8')
  expect(css).toMatch(
    /@media \(max-width: 860px\) \{\s*\[data-ui='bold'\] \.bold-effort-button \{\s*min-height: 44px;/,
  )
  expect(css).toMatch(/\.bold-effort-choice--end \.bold-effort-menu \{\s*left: auto;\s*right: 0;/)
})

test('CSS: a level tag wraps onto its own line instead of cutting the agent’s name', () => {
  const list = readFileSync(join(__dirname, '../chats/chats-list.css'), 'utf8')
  expect(list).toMatch(/\.bold-chat-top \{[^}]*flex-wrap: wrap/)
  expect(list).toMatch(/\.bold-chat-top b \{[^}]*flex: 0 1 auto;[^}]*min-width: 0/)
  const css = readFileSync(join(__dirname, 'efforts.css'), 'utf8')
  expect(css).toMatch(/\.bold-chat-effort \{\s*flex: none;/)
})
