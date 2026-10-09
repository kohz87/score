import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AgentSummary, Message } from '@score/contract'
import { createQueryClient } from '../../data/query-client.ts'
import { Composer } from './Composer.tsx'
import { messagesQuery } from './queries.ts'
import type { Recognizer } from './voice.ts'

// Stop, slash commands, context meter and voice input (PLAN 5.25).
const agent = (id: string): AgentSummary => ({
  id,
  name: id[0]!.toUpperCase() + id.slice(1),
  role: 'Example',
  style: { color: '#6B4EFF', shape: 'circle-dot' },
  status: 'idle',
  activity: null,
  model: null,
  served: true,
})
const agents = [agent('lead'), agent('builder')]
const reply = (streaming: boolean): Message => ({
  id: 'reply-1',
  roomId: 'general',
  author: { kind: 'agent', agentId: 'builder' },
  to: [],
  parts: [{ kind: 'text', text: 'working' }],
  createdAt: '2026-10-09T10:00:00.000Z',
  streaming,
  refs: [],
})
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status })
const context = {
  model: 'm',
  tokens: { input: 90_000, output: 10_000 },
  costUsd: 0.25,
  contextLength: 200_000,
}
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
let queryClient: ReturnType<typeof createQueryClient>

function mount(items: Message[] = []) {
  queryClient.setQueryData(messagesQuery('general').key, {
    asOfSeq: 1,
    data: { items, nextCursor: null, typing: {} },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Composer roomId="general" roomName="general" agents={agents} leadAgentId="lead" />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}
const box = () => screen.getByRole('combobox', { name: 'Message general' }) as HTMLTextAreaElement
const type = (value: string) =>
  fireEvent.change(box(), { target: { value, selectionStart: value.length } })
const calls = (method: string) => fetchMock.mock.calls.filter(([, init]) => init?.method === method)

beforeEach(() => {
  localStorage.clear()
  queryClient = createQueryClient()
  fetchMock = vi.fn(async (input, init) => {
    const url = String(input)
    if (url === '/api/commands') return json({ items: [] })
    if (url.endsWith('/context')) return json(context)
    if (init?.method === 'POST' || init?.method === 'PUT') return json({ ok: true })
    return json({})
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  queryClient.clear()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

test('Send turns into Stop while a reply is being written, and Stop posts to the reply', async () => {
  mount([reply(true)])
  expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
  await waitFor(() => expect(calls('POST')).toHaveLength(1))
  expect(String(calls('POST')[0]![0])).toBe('/api/rooms/general/messages/reply-1/stop')
})

test('typing a follow-up brings Send back, and a finished reply shows only Send', () => {
  mount([reply(true)])
  type('and also this')
  expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
  cleanup()
  mount([reply(false)])
  expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
})

test('the context meter shows usage of the agent that answered last, and hides when unknown', async () => {
  mount([reply(false)])
  expect(await screen.findByText('Builder: 100k of 200k tokens · $0.2500')).toBeTruthy()
  cleanup()
  fetchMock.mockImplementation(async (input) =>
    String(input).endsWith('/context')
      ? json({ model: null, tokens: null, costUsd: null, contextLength: null })
      : json({ items: [] }),
  )
  queryClient.clear()
  mount([reply(false)])
  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/context'))).toBe(true),
  )
  expect(document.querySelector('.chat-meter')).toBeNull()
})

test('/usage shows a local card and sends nothing to the room', async () => {
  mount([reply(false)])
  type('/usage')
  // The first Enter completes the command from the menu, the second runs it.
  fireEvent.keyDown(box(), { key: 'Enter' })
  fireEvent.keyDown(box(), { key: 'Enter' })
  expect(await screen.findByText(/Input 90,000/)).toBeTruthy()
  expect(calls('POST')).toHaveLength(0)
  expect(box().value).toBe('')
})

test('/model <name> sets the agent model with the existing PUT', async () => {
  mount([reply(false)])
  type('/model gpt-6')
  fireEvent.keyDown(box(), { key: 'Enter' })
  await waitFor(() => expect(calls('PUT')).toHaveLength(1))
  expect(String(calls('PUT')[0]![0])).toBe('/api/agents/builder/model')
  expect(JSON.parse(String(calls('PUT')[0]![1]!.body))).toEqual({ model: 'gpt-6' })
  expect(await screen.findByText('Builder now uses gpt-6.')).toBeTruthy()
  expect(calls('POST')).toHaveLength(0)
})

test('/compress explains that Hermes has no API for it instead of sending the text', async () => {
  mount([reply(false)])
  type('/compress')
  fireEvent.keyDown(box(), { key: 'Enter' })
  fireEvent.keyDown(box(), { key: 'Enter' })
  expect(await screen.findByText(/can’t compact Builder’s session/)).toBeTruthy()
  expect(calls('POST')).toHaveLength(0)
})

test('/model with a message still goes to the server as before', async () => {
  mount()
  type('/model gpt-6 hello')
  fireEvent.keyDown(box(), { key: 'Enter' })
  await waitFor(() => expect(calls('POST')).toHaveLength(1))
  expect(calls('PUT')).toHaveLength(0)
})

class FakeRecognizer implements Recognizer {
  static last: FakeRecognizer | null = null
  continuous = false
  interimResults = false
  lang = ''
  onresult: Recognizer['onresult'] = null
  onend: Recognizer['onend'] = null
  onerror: Recognizer['onerror'] = null
  started = false
  constructor() {
    FakeRecognizer.last = this
  }
  start() {
    this.started = true
  }
  stop() {
    this.started = false
    this.onend?.()
  }
  abort() {
    this.started = false
  }
  say(transcript: string, isFinal: boolean) {
    this.onresult?.({ resultIndex: 0, results: [{ isFinal, 0: { transcript } }] })
  }
}

test('no microphone button where the browser has no speech recognition', () => {
  mount()
  expect(screen.queryByRole('button', { name: 'Voice input' })).toBeNull()
})

test('voice: tap to start, interim words land in the draft, silence for 2 s stops it', () => {
  vi.stubGlobal('webkitSpeechRecognition', FakeRecognizer)
  vi.useFakeTimers()
  mount()
  type('Please')
  const mic = screen.getByRole('button', { name: 'Voice input' })
  expect(mic.getAttribute('aria-pressed')).toBe('false')
  fireEvent.click(mic)
  expect(mic.getAttribute('aria-pressed')).toBe('true')
  const recognizer = FakeRecognizer.last!
  expect(recognizer.started && recognizer.interimResults && recognizer.continuous).toBe(true)
  act(() => recognizer.say('add pagin', false))
  expect(box().value).toBe('Please add pagin')
  act(() => recognizer.say('add pagination', true))
  expect(box().value).toBe('Please add pagination')
  act(() => {
    vi.advanceTimersByTime(1900)
  })
  expect(mic.getAttribute('aria-pressed')).toBe('true')
  act(() => {
    vi.advanceTimersByTime(200)
  })
  expect(mic.getAttribute('aria-pressed')).toBe('false')
  expect(recognizer.started).toBe(false)
})

test('voice: tapping again stops, and a blocked microphone is reported', () => {
  vi.stubGlobal('SpeechRecognition', FakeRecognizer)
  mount()
  const mic = screen.getByRole('button', { name: 'Voice input' })
  fireEvent.click(mic)
  fireEvent.click(mic)
  expect(mic.getAttribute('aria-pressed')).toBe('false')
  fireEvent.click(mic)
  act(() => FakeRecognizer.last!.onerror?.({ error: 'not-allowed' }))
  expect(screen.getByRole('alert').textContent).toBe('Microphone access was blocked.')
})
