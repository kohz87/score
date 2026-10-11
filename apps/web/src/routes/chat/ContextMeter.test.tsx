import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { SessionContextSnapshot, StreamEvent } from '@score/contract'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamQueryRegistry, immediateFrameScheduler } from '../../data/resync.ts'
import { createStreamClient } from '../../data/stream.ts'
import { ContextMeter, ringLevel } from './ContextMeter.tsx'

const base: SessionContextSnapshot = {
  asOfSeq: 1,
  window: 128_000,
  used: 54_000,
  measuredAt: '2026-10-11T10:00:00.000Z',
  model: 'fake-model',
  source: 'provider_usage',
  parts: [
    { kind: 'system_prompt', label: 'System prompt', tokens: 3000 },
    { kind: 'tool_definitions', label: 'Tool definitions', tokens: 9000 },
    { kind: 'conversation', label: 'Messages', tokens: 42_000 },
  ],
  autoCompactAt: 64_000,
  compactions: 0,
}
class Source extends EventTarget {
  static current: Source
  constructor() {
    super()
    Source.current = this
  }
  close() {}
  emit(event: StreamEvent) {
    this.dispatchEvent(
      new MessageEvent(event.type, { data: JSON.stringify(event), lastEventId: String(event.seq) }),
    )
  }
}
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status })
let reading: SessionContextSnapshot
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
const disposers: (() => void)[] = []

function mount(props: Partial<Parameters<typeof ContextMeter>[0]> = {}) {
  const queryClient = createQueryClient()
  const client = createStreamClient({ EventSourceImpl: Source })
  const queries = createStreamQueryRegistry(queryClient, client, immediateFrameScheduler)
  disposers.push(() => {
    queries.dispose()
    client.close()
    queryClient.clear()
  })
  render(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client, queries }}>
        <ContextMeter roomId="r" agentId="builder" name="Builder" finishedReplies={0} {...props} />
      </StreamContext>
    </QueryClientProvider>,
  )
}
beforeEach(() => {
  reading = base
  fetchMock = vi.fn(async (input, init) => {
    if (init?.method === 'POST') return json({ commandId: 'cmd-1' }, 202)
    return json(reading)
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  disposers.splice(0).forEach((dispose) => dispose())
  vi.unstubAllGlobals()
})

test('ring levels step at 75 % and 90 %, and an unknown window has none', () => {
  expect([null, 0.5, 0.749, 0.75, 0.89, 0.9, 1].map(ringLevel)).toEqual([
    'normal',
    'normal',
    'normal',
    'warn',
    'warn',
    'high',
    'high',
  ])
})

test('the ring names the agent and the share used; colour is never the only signal', async () => {
  reading = { ...base, used: 100_000 }
  mount()
  const ring = await screen.findByRole('button', { name: 'Builder context: 78 % of 128k' })
  expect(ring.className).toContain('--warn')
  expect(ring.textContent).toBe('78%')
  cleanup()
  reading = { ...base, used: 120_000 }
  mount()
  expect((await screen.findByRole('button', { name: /94 % of 128k/ })).className).toContain(
    '--high',
  )
})

test('an unknown window shows tokens only, without a percentage', async () => {
  reading = { ...base, window: null, parts: null }
  mount()
  const ring = await screen.findByRole('button', { name: 'Builder context: 54k tokens' })
  expect(ring.textContent).toBe('54k')
})

test('the popover lists what uses the context, the model and the auto-compact point; Escape closes it', async () => {
  mount()
  const ring = await screen.findByRole('button', { name: /Builder context/ })
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(ring)
  const panel = screen.getByRole('dialog', { name: 'Builder context details' })
  expect(ring.getAttribute('aria-expanded')).toBe('true')
  expect(panel.textContent).toContain('54,000 tokens used of 128,000 (42 %)')
  expect(panel.textContent).toContain('fake-model')
  expect(panel.textContent).toContain('Hermes compacts automatically at 64,000 tokens (50 %)')
  const rows = within(within(panel).getByRole('list')).getAllByRole('listitem')
  expect(rows.map((row) => row.textContent)).toEqual([
    'System prompt3,000 · 2.3 %',
    'Tool definitions9,000 · 7 %',
    'Messages42,000 · 32.8 %',
  ])
  fireEvent.keyDown(panel, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(ring)
})

test('clicking outside closes the popover', async () => {
  mount()
  fireEvent.click(await screen.findByRole('button', { name: /Builder context/ }))
  expect(screen.getByRole('dialog')).toBeDefined()
  fireEvent.pointerDown(document.body)
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('without a breakdown the popover says so and still offers Compact', async () => {
  reading = { ...base, parts: null, source: null, autoCompactAt: null }
  mount()
  fireEvent.click(await screen.findByRole('button', { name: /Builder context/ }))
  const panel = screen.getByRole('dialog')
  expect(panel.textContent).toContain('breakdown of what uses the context isn’t available')
  expect(within(panel).getByRole('button', { name: 'Compact' })).toBeDefined()
})

test('Compact asks first, posts keepRecent, shows progress and then Hermes’s before and after', async () => {
  mount()
  fireEvent.click(await screen.findByRole('button', { name: /Builder context/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Compact' }))
  expect(screen.getByRole('dialog').textContent).toContain(
    'Hermes will summarise Builder’s older exchanges',
  )
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: 'Compact now' }))
  await waitFor(() => {
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!
    expect(String(post[0])).toBe('/api/agents/builder/sessions/score-r-builder/compact')
    expect(JSON.parse(String(post[1]!.body))).toEqual({ keepRecent: 2 })
  })
  expect((await screen.findAllByText('Compacting Builder…')).length).toBeGreaterThan(0)
  reading = { ...base, used: 9000, compactions: 1 }
  act(() =>
    Source.current.emit({
      type: 'session.compacted',
      seq: 7,
      ts: '2026-10-11T10:01:00.000Z',
      data: {
        commandId: 'cmd-1',
        agentId: 'builder',
        sessionId: 'score-r-builder',
        roomId: 'r',
        status: 'compacted',
        reason: null,
        keepRecent: 2,
        before: { messages: 40, tokens: 54_000 },
        after: { messages: 8, tokens: 9000 },
      },
    } as StreamEvent),
  )
  expect(
    (await screen.findAllByText('Compacted: 40 → 8 messages, 54,000 → 9,000 tokens.')).length,
  ).toBeGreaterThan(0)
  await screen.findByRole('button', { name: 'Builder context: 7 % of 128k' })
  expect(screen.getByRole('button', { name: 'Compact' }).hasAttribute('disabled')).toBe(false)
})

test('a failed compaction explains why, and a refusal from the server is shown', async () => {
  mount()
  fireEvent.click(await screen.findByRole('button', { name: /Builder context/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Compact' }))
  fetchMock.mockImplementation(async (_input, init) =>
    init?.method === 'POST'
      ? json(
          {
            error: { code: 'session_busy', message: 'Builder is busy in this room; stop it first' },
          },
          409,
        )
      : json(reading),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Compact now' }))
  expect((await screen.findByRole('alert')).textContent).toContain('busy in this room')
})
