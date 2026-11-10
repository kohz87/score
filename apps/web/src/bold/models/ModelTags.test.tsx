import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { AgentSummary, StreamEvent } from '@score/contract'
import { afterEach, expect, test, vi } from 'vitest'
import { ChatRowEffort } from '../efforts/ChatRowEffort.tsx'
import { DirectEffortBlock } from '../efforts/DirectEffortBlock.tsx'
import { EffortControl } from '../efforts/EffortControl.tsx'
import { MemberEffortTag } from '../efforts/MemberEffortTag.tsx'
import { agents, disposeRoomTest, jsonResponse, renderInRoom } from '../room/room-test-utils.tsx'
import { roomModelsQuery } from './model-queries.ts'
import { useRunEffort } from '../efforts/use-run-effort.ts'
import { useRunModel } from './use-run-model.ts'

/** Decision 182, the tag and This chat: one "model · effort" tag everywhere, one menu with two parts. */
afterEach(() => {
  disposeRoomTest()
  vi.unstubAllGlobals()
})

const builder = agents.find((agent) => agent.id === 'builder')!
const deep = {
  roomId: 'room-1',
  agentId: 'builder',
  model: 'example-large',
  provider: 'demo',
  label: 'deep',
}

type Call = { method: string; path: string; body: unknown }

function stub(
  chatModels: object[],
  chatEfforts: object[] = [],
  extra: (path: string) => Response | undefined = () => undefined,
) {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
      const other = extra(path)
      if (other) return other
      if (method === 'PUT' && path.includes('/rooms/room-1/models/'))
        return jsonResponse({ roomId: 'room-1', agentId: 'builder', current: null, replaced: deep })
      if (method === 'PUT' && path.includes('/rooms/room-1/efforts/'))
        return jsonResponse({ roomId: 'room-1', agentId: 'builder', effort: null })
      if (path.endsWith('/rooms/room-1/models'))
        return jsonResponse({ asOfSeq: 0, items: chatModels })
      if (path.endsWith('/rooms/room-1/efforts'))
        return jsonResponse({ asOfSeq: 0, items: chatEfforts })
      if (path.endsWith('/agents/builder/efforts'))
        return jsonResponse({
          agentId: 'builder',
          own: 'medium',
          levels: ['low', 'high', 'max'],
          chats: [],
        })
      if (path.endsWith('/agents/builder/model-settings'))
        return jsonResponse({
          effort: null,
          fallbacks: [],
          fallbacksEditable: true,
          aliases: [{ name: 'deep', model: 'example-large', provider: 'demo', editable: true }],
          speech: {
            stt: { provider: null, model: null },
            tts: { provider: null, model: null, voice: null },
          },
        })
      if (path.includes('/api/models?'))
        return jsonResponse({
          items: [
            {
              provider: 'demo',
              providerLabel: 'Demo',
              model: 'example-large',
              available: true,
              reason: null,
              free: false,
              price: null,
            },
          ],
        })
      if (path.endsWith('/agents/builder/subagents')) return jsonResponse({}, 404)
      return jsonResponse({}, 404)
    }),
  )
  return calls
}

test('the chat list row shows the combined tag, amber for a model set differently, nothing when both are its own', async () => {
  stub([deep], [])
  renderInRoom(<ChatRowEffort roomId="room-1" agentId="builder" />)
  const tag = await screen.findByText('deep')
  expect(tag.closest('.bold-chat-effort')!.className).toContain('bold-effort--max')
  expect(tag.closest('.bold-chat-effort')!.textContent).toBe('deep · its own')
})

test('the chat list row shows nothing when the chat sets neither', async () => {
  stub([], [])
  renderInRoom(<ChatRowEffort roomId="room-1" agentId="builder" />)
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(document.querySelector('.bold-chat-effort')).toBeNull()
})

test('a Members tag for a model only reads "deep · its own"; effort only reads "its own · high", plain', async () => {
  stub([deep])
  renderInRoom(<MemberEffortTag roomId="room-1" agent={builder} />)
  const tag = await screen.findByRole('button', {
    name: /in this chat: model deep, effort its own\. Change/,
  })
  expect(tag.textContent).toBe('deep · its own')
  expect(tag.className).toContain('bold-effort--max')
})

test('effort only reads "its own · high" in the plain style', async () => {
  stub([], [{ roomId: 'room-1', agentId: 'builder', effort: 'high' }])
  renderInRoom(<MemberEffortTag roomId="room-1" agent={builder} />)
  const tag = await screen.findByRole('button', { name: /model its own, effort high\. Change/ })
  expect(tag.textContent).toBe('its own · high')
  expect(tag.className).not.toContain('bold-effort--max')
})

function Bar({ agent = builder }: { agent?: AgentSummary }) {
  return (
    <EffortControl
      agent={agent}
      model={deep}
      current={null}
      runEffort={useRunEffort('room-1', 'group')}
      runModel={useRunModel('room-1', 'group')}
    />
  )
}

test('the tag opens one menu with a Model part and an Effort part; picking a model sends /model, and each part can go back', async () => {
  const calls = stub([deep])
  renderInRoom(<Bar />)
  fireEvent.click(
    await screen.findByRole('button', { name: /model deep, effort its own\. Change/ }),
  )
  const modelMenu = await screen.findByRole('menu', { name: 'Model for builder' })
  expect(screen.getByRole('menu', { name: 'Effort for builder' })).toBeTruthy()
  expect(
    within(modelMenu)
      .getByRole('menuitemradio', { name: /\/model deep/ })
      .getAttribute('aria-checked'),
  ).toBe('true')
  fireEvent.click(within(modelMenu).getByRole('menuitemradio', { name: /\/model default/ }))
  await waitFor(() =>
    expect(calls.some((c) => c.method === 'PUT' && c.path.endsWith('/models/builder'))).toBe(true),
  )
  expect(calls.find((c) => c.method === 'PUT' && c.path.endsWith('/models/builder'))!.body).toEqual(
    { model: null },
  )
})

test('a coding agent’s menu lists only its own program’s models', async () => {
  const coder = {
    ...builder,
    id: 'coder',
    name: 'coder',
    runtime: 'claude-code',
    model: { id: 'sonnet', label: 'sonnet' },
  } as AgentSummary
  stub([], [], (path) =>
    path.endsWith('/agents/coder/efforts')
      ? jsonResponse({ agentId: 'coder', own: null, levels: ['low'], chats: [] })
      : path.endsWith('/coding-agents/runtimes/claude-code/models')
        ? jsonResponse({
            source: 'aliases',
            models: [
              { id: 'sonnet', name: 'Sonnet' },
              { id: 'opus', name: 'Opus' },
            ],
          })
        : undefined,
  )
  renderInRoom(
    <EffortControl
      agent={coder}
      model={{ ...deep, agentId: 'coder', model: 'opus', label: 'opus' }}
      current={null}
      runEffort={async () => undefined}
      runModel={async () => undefined}
    />,
  )
  fireEvent.click(await screen.findByRole('button', { name: /model opus/ }))
  const menu = await screen.findByRole('menu', { name: 'Model for coder' })
  expect(within(menu).getByText('/model sonnet')).toBeTruthy()
  expect(within(menu).getByText('/model opus')).toBeTruthy()
  expect(menu.textContent).toContain('its own is Claude Code · sonnet')
})

test('This chat (one-to-one) has a Model row, Change model and Change effort, and Back to its own clears both', async () => {
  const calls = stub([deep], [{ roomId: 'room-1', agentId: 'builder', effort: 'high' }])
  renderInRoom(<DirectEffortBlock agent={builder} roomId="room-1" />)
  expect(await screen.findByText('deep (example-large)')).toBeTruthy()
  expect(screen.getByRole('button', { name: /Change model/ })).toBeTruthy()
  expect(screen.getByRole('button', { name: /Change effort for builder/ })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Back to its own' }))
  await waitFor(() => {
    expect(calls.some((c) => c.method === 'PUT' && c.path.endsWith('/models/builder'))).toBe(true)
    expect(calls.some((c) => c.method === 'PUT' && c.path.endsWith('/efforts/builder'))).toBe(true)
  })
  expect(screen.getByText(/Back to its own clears both; each tag clears one/)).toBeTruthy()
})

test('model.changed sets or clears an agent’s model in the chat’s list, ending on the newest', () => {
  const query = roomModelsQuery('room-1')
  const event = (model: string | null, label: string | null, roomId = 'room-1'): StreamEvent =>
    ({
      seq: 1,
      type: 'model.changed',
      ts: '2026-11-10T00:00:00.000Z',
      data: { roomId, agentId: 'builder', model, label, reason: 'person' },
    }) as StreamEvent
  const set = query.reduce({ items: [] }, event('example-large', 'deep'))
  expect(set.items).toEqual([
    { roomId: 'room-1', agentId: 'builder', model: 'example-large', provider: null, label: 'deep' },
  ])
  expect(query.reduce(set, event('other', 'other', 'room-2'))).toBe(set)
  expect(query.reduce(set, event(null, null)).items).toEqual([])
})
