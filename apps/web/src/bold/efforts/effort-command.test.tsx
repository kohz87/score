import { act, screen, waitFor } from '@testing-library/react'
import type { AgentSummary } from '@score/contract'
import { afterEach, expect, test, vi } from 'vitest'
import { agents, disposeRoomTest, jsonResponse, renderInRoom } from '../room/room-test-utils.tsx'
import { runTopicCommand, type TopicCommandContext } from '../room/topic-commands.ts'
import { useEffortModelNotice } from './use-effort-model-notice.ts'
import { parseEffortArgs, runEffortCommand, type EffortSay } from './effort-command.ts'
import { createQueryClient } from '../../data/query-client.ts'

/** Decision 178, part 2: `/effort` in the composer (the command, its note and Undo, the wrong level, `@agent /effort`). */
afterEach(() => {
  disposeRoomTest()
  vi.unstubAllGlobals()
})

const builder = agents.find((agent) => agent.id === 'builder')!
const reviewer = agents.find((agent) => agent.id === 'reviewer')!

test('parseEffortArgs: nothing shows, default goes back to own, anything else is a level', () => {
  expect(parseEffortArgs('')).toEqual({ kind: 'show' })
  expect(parseEffortArgs('  Default ')).toEqual({ kind: 'own' })
  expect(parseEffortArgs('MAX')).toEqual({ kind: 'set', level: 'max' })
})

type Call = { method: string; path: string; body: unknown }

function stub(
  current: string | null,
  levels = ['low', 'medium', 'high', 'max'],
  own: string | null = 'medium',
) {
  const calls: Call[] = []
  let effort = current
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : null
      calls.push({ method, path, body })
      if (method === 'PUT') {
        effort = (body as { effort: string | null }).effort
        return jsonResponse({ roomId: 'room-1', agentId: 'builder', effort })
      }
      if (path.endsWith('/rooms/room-1/efforts'))
        return jsonResponse({
          items: effort ? [{ roomId: 'room-1', agentId: 'builder', effort }] : [],
        })
      const agent = /\/agents\/(\w+)\/efforts$/.exec(path)?.[1]
      if (agent) return jsonResponse({ agentId: agent, own, levels, chats: [] })
      return jsonResponse({}, 404)
    }),
  )
  return calls
}

function sayRecorder() {
  const lines: { text: string; action?: { label: string; run: () => void } }[] = []
  const say: EffortSay = (text, action) => lines.push({ text, ...(action ? { action } : {}) })
  return { lines, say }
}

const run = (
  args: string,
  say: EffortSay,
  agent: AgentSummary = builder,
  roomKind: 'direct' | 'group' = 'group',
) =>
  runEffortCommand({
    roomId: 'room-1',
    roomKind,
    agent,
    args,
    queryClient: createQueryClient(),
    say,
  })

test('setting a level sends it for this chat and offers Undo, which puts back the effort it replaced', async () => {
  const calls = stub('medium')
  const { lines, say } = sayRecorder()
  await run('high', say)
  const put = calls.find((call) => call.method === 'PUT')!
  expect(put.body).toEqual({ effort: 'high' })
  expect(lines[0]!.text).toBe('You set builder’s effort to high for this chat')
  expect(lines[0]!.action?.label).toBe('Undo')
  lines[0]!.action!.run()
  await waitFor(() => expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(2))
  expect(calls.filter((call) => call.method === 'PUT')[1]!.body).toEqual({ effort: 'medium' })
})

test('a change to another level in this chat is a change, and back to own is null', async () => {
  const calls = stub('high')
  const { lines, say } = sayRecorder()
  await run('max', say)
  expect(calls.find((call) => call.method === 'PUT')!.body).toEqual({ effort: 'max' })
  calls.length = 0
  await run('default', say)
  expect(calls.find((call) => call.method === 'PUT')!.body).toEqual({ effort: null })
  expect(lines.at(-1)!.text).toContain('back on its own effort')
})

test('a level the agent does not take sends nothing and says which it takes', async () => {
  const calls = stub(null, ['low', 'high'])
  const { lines, say } = sayRecorder()
  await run('max', say)
  expect(calls.some((call) => call.method === 'PUT')).toBe(false)
  expect(lines[0]!.text).toBe('builder takes low, high. Nothing was sent.')
})

test('the state reads as the chat’s own when it sets none, and as its level when it does', async () => {
  stub(null)
  const first = sayRecorder()
  await run('', first.say)
  expect(first.lines[0]!.text).toBe('builder uses its own effort in this chat: medium.')
  stub('max')
  const second = sayRecorder()
  await run('', second.say)
  expect(second.lines[0]!.text).toBe(
    'builder thinks at effort max in this chat (its own is medium).',
  )
})

test('in a one-to-one the note says the level and its own, with Undo', async () => {
  stub('medium')
  const { lines, say } = sayRecorder()
  await run('low', say, builder, 'direct')
  expect(lines[0]!.text).toBe('builder works at effort low in this chat (its own is medium).')
})

test('the composer’s `/effort` acts on the agent it is addressed to, and `@agent /effort` names one', async () => {
  const calls = stub('medium')
  const lines: string[] = []
  const ctx: TopicCommandContext = {
    room: {
      id: 'room-1',
      kind: 'room',
      name: 'Team room',
      members: ['builder', 'reviewer'],
    } as TopicCommandContext['room'],
    agents: [builder, reviewer],
    jobs: [],
    current: undefined,
    workspaces: [],
    queryClient: createQueryClient(),
    pick: () => undefined,
    say: (text) => lines.push(text),
  }
  // The target is the addressee: a bare `/effort high` with `builder` on the To chip.
  await runTopicCommand('effort', 'high', ctx, 'builder')
  expect(calls.find((call) => call.method === 'PUT')!.path).toMatch(/\/efforts\/builder$/)
  // `@reviewer /effort max`: the agent named before the command, not the one addressed.
  calls.length = 0
  await runTopicCommand('effort', 'max', ctx, 'reviewer')
  expect(calls.find((call) => call.method === 'PUT')!.path).toMatch(/\/efforts\/reviewer$/)
})

test('a `reason: model` change is said in the chat once, and not again on remount', async () => {
  const lines: string[] = []
  const say: EffortSay = (text) => lines.push(text)
  function Probe() {
    useEffortModelNotice('room-1', [builder], say)
    return <p>probe</p>
  }
  const calls = stub(null)
  const view = renderInRoom(<Probe />)
  await waitFor(() =>
    expect(calls.some((call) => call.path.endsWith('/rooms/room-1/efforts'))).toBe(true),
  )
  act(() =>
    view.emit({
      seq: 5,
      ts: '2026-11-10T10:00:00.000Z',
      type: 'effort.changed',
      data: { roomId: 'room-1', agentId: 'builder', effort: null, reason: 'model' },
    }),
  )
  await waitFor(() => expect(lines).toHaveLength(1))
  expect(lines[0]).toContain('builder went back to its own effort')
  expect(screen.getByText('probe')).toBeTruthy()
})
