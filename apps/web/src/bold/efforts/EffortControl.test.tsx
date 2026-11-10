import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { AgentEfforts, ChatEffortsResponse } from '@score/contract'
import { afterEach, expect, test, vi } from 'vitest'
import { agents, disposeRoomTest, jsonResponse, renderInRoom } from '../room/room-test-utils.tsx'
import { DirectEffortBlock } from './DirectEffortBlock.tsx'
import { EffortChatsCard } from './EffortChatsCard.tsx'
import { EffortControl, EffortTag } from './EffortControl.tsx'
import { chatEffortOf, useRoomEfforts } from './effort-queries.ts'
import { useRunEffort } from './use-run-effort.ts'

/** Decision 178, parts 3 to 5 and 8: the context bar's Effort button, Chat info's tags and This chat, the agent's list. */
afterEach(() => {
  disposeRoomTest()
  vi.unstubAllGlobals()
})

const builder = agents.find((agent) => agent.id === 'builder')!

const efforts = (over: Partial<AgentEfforts> = {}): AgentEfforts => ({
  agentId: builder.id,
  own: 'medium',
  levels: ['low', 'medium', 'high', 'xhigh', 'max'],
  chats: [],
  ...over,
})

type Call = { method: string; path: string; body: unknown; key: string | null }

/** Serves the chat's efforts and the agent's efforts, and answers each PUT; every request is recorded. */
function stub(chat: ChatEffortsResponse['items'], agentEfforts: AgentEfforts = efforts()) {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      const method = init?.method ?? 'GET'
      calls.push({
        method,
        path,
        body: init?.body ? JSON.parse(String(init.body)) : null,
        key: new Headers(init?.headers).get('Idempotency-Key'),
      })
      if (method === 'PUT' && path.includes('/rooms/room-1/efforts/')) {
        const body = JSON.parse(String(init?.body)) as { effort: string | null }
        return jsonResponse({ roomId: 'room-1', agentId: builder.id, effort: body.effort })
      }
      if (path.endsWith('/rooms/room-1/efforts')) return jsonResponse({ asOfSeq: 0, items: chat })
      if (path.endsWith('/agents/builder/subagents'))
        return jsonResponse({
          agentId: 'builder',
          control: 'limits',
          enabled: true,
          maxConcurrent: 3,
          model: null,
          maxIterations: 50,
          timeoutSeconds: null,
        })
      if (path.endsWith(`/agents/${builder.id}/efforts`)) return jsonResponse(agentEfforts)
      return jsonResponse({}, 404)
    }),
  )
  return calls
}

/** The context bar's control as the bar renders it: this chat's effort, changed through the real `/effort` command. */
function ContextBarProbe() {
  const current = chatEffortOf(useRoomEfforts('room-1').items, builder.id)
  return (
    <EffortControl agent={builder} current={current} runEffort={useRunEffort('room-1', 'group')} />
  )
}

test('the context bar shows Effort only when this chat sets one; max uses the amber style', async () => {
  stub([{ roomId: 'room-1', agentId: builder.id, effort: 'max' }])
  renderInRoom(<ContextBarProbe />)
  const button = await screen.findByRole('button', { name: /Effort in this chat: max/ })
  expect(button.className).toContain('bold-effort--max')
})

test('nothing is shown for an agent on its own in this chat', async () => {
  stub([])
  renderInRoom(<ContextBarProbe />)
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: /Effort in this chat/ })).toBeNull(),
  )
  renderInRoom(<EffortTag agent={builder} current={null} runEffort={async () => undefined} />)
  expect(screen.queryByRole('button', { name: /effort in this chat/i })).toBeNull()
})

test('a level is set for this chat only; the menu offers only the levels the agent takes', async () => {
  const calls = stub(
    [{ roomId: 'room-1', agentId: builder.id, effort: 'high' }],
    efforts({ levels: ['low', 'high'] }),
  )
  renderInRoom(<ContextBarProbe />)
  fireEvent.click(await screen.findByRole('button', { name: /Effort in this chat: high/ }))
  const menu = await screen.findByRole('menu', { name: `Effort for ${builder.name}` })
  expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(3) // low, high, default
  expect(within(menu).queryByText('/effort max')).toBeNull()
  fireEvent.click(within(menu).getByRole('menuitemradio', { name: /\/effort low/ }))
  await waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true))
  const put = calls.find((call) => call.method === 'PUT')!
  expect(put.path).toMatch(/\/api\/rooms\/room-1\/efforts\/builder$/)
  expect(put.body).toEqual({ effort: 'low' })
  expect(put.key).toBeTruthy()
})

test('Back to its own sends null', async () => {
  const calls = stub([{ roomId: 'room-1', agentId: builder.id, effort: 'high' }])
  renderInRoom(<ContextBarProbe />)
  fireEvent.click(await screen.findByRole('button', { name: /Effort in this chat: high/ }))
  const menu = await screen.findByRole('menu')
  fireEvent.click(within(menu).getByRole('menuitemradio', { name: /\/effort default/ }))
  await waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true))
  expect(calls.find((call) => call.method === 'PUT')!.body).toEqual({ effort: null })
})

test('the menu takes the keyboard: focus starts on the checked choice, arrows and End move, Escape closes and returns focus', async () => {
  stub([{ roomId: 'room-1', agentId: builder.id, effort: 'medium' }])
  renderInRoom(<ContextBarProbe />)
  const button = await screen.findByRole('button', { name: /Effort in this chat: medium/ })
  fireEvent.click(button)
  const menu = await screen.findByRole('menu')
  const items = within(menu).getAllByRole('menuitemradio')
  const checked = items.findIndex((item) => item.getAttribute('aria-checked') === 'true')
  await waitFor(() => expect(document.activeElement).toBe(items[checked]))
  fireEvent.keyDown(menu, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(items[checked + 1])
  fireEvent.keyDown(menu, { key: 'End' })
  expect(document.activeElement).toBe(items[items.length - 1])
  fireEvent.keyDown(menu, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  // Focus goes back to the button a frame later (the subagents control does the same).
  await waitFor(() => expect(document.activeElement).toBe(button))
})

test('a Members tag opens the choices for that agent', async () => {
  stub([{ roomId: 'room-1', agentId: builder.id, effort: 'high' }])
  renderInRoom(<EffortTag agent={builder} current="high" runEffort={async () => undefined} />)
  fireEvent.click(await screen.findByRole('button', { name: /effort in this chat: high/ }))
  expect(await screen.findByRole('menu')).toBeTruthy()
})

test('the agent settings list is absent when no chat sets a different effort', async () => {
  stub([], efforts({ chats: [] }))
  renderInRoom(<EffortChatsCard agentId={builder.id} />)
  await waitFor(() => expect(screen.queryByLabelText('Chats that override effort')).toBeNull())
})

test('the agent settings list names each chat with its level and the line under them', async () => {
  stub(
    [],
    efforts({
      chats: [
        {
          roomId: 'room-1',
          roomName: 'Team room',
          roomKind: 'group',
          jobTitle: 'Release notes 2.4',
          effort: 'max',
        },
        {
          roomId: 'room-2',
          roomName: 'builder',
          roomKind: 'direct',
          jobTitle: null,
          effort: 'low',
        },
      ],
    }),
  )
  renderInRoom(<EffortChatsCard agentId={builder.id} />)
  const card = await screen.findByLabelText('Chats that override effort')
  expect(within(card).getByText('Set differently in 2 chats')).toBeTruthy()
  expect(within(card).getByText('max').className).toContain('bold-effort--max')
  expect(within(card).getByText('low').className).not.toContain('bold-effort--max')
  expect(within(card).getByText(/Every other chat uses medium/)).toBeTruthy()
})

test('This chat (one-to-one) offers Change effort, and Back to its own only when the chat sets one', async () => {
  stub([{ roomId: 'room-1', agentId: builder.id, effort: 'high' }])
  renderInRoom(<DirectEffortBlock agent={builder} roomId="room-1" />)
  expect(await screen.findByRole('button', { name: /Back to its own/ })).toBeTruthy()
  expect(screen.getByRole('button', { name: /Change effort/ })).toBeTruthy()
})

test('This chat says Its own when the chat sets nothing', async () => {
  stub([])
  renderInRoom(<DirectEffortBlock agent={builder} roomId="room-1" />)
  expect(await screen.findByText('Its own')).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Back to its own/ })).toBeNull()
  expect(await screen.findByText('up to 3')).toBeTruthy()
})
