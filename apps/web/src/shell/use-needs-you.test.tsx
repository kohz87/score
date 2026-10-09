import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { Approval } from '@score/contract'
import { createQueryClient, StreamContext } from '../data/query-client.ts'
import { createStreamClient } from '../data/stream.ts'
import { createStreamQueryRegistry } from '../data/resync.ts'
import { useNeedsYou } from './use-needs-you.ts'

class Source extends EventTarget {
  static current: Source
  constructor() {
    super()
    Source.current = this
  }
  close() {}
}
const approval = (overrides: Partial<Approval>): Approval => ({
  id: 'a1',
  origin: 'score-run',
  phase: 'human_pending',
  status: 'pending',
  actionable: true,
  linkedTo: null,
  agentId: 'builder',
  title: 'Install',
  command: 'pnpm add ws',
  cwd: null,
  description: '',
  choices: ['once', 'deny'],
  createdAt: '2026-10-08T10:00:00.000Z',
  expiresAt: null,
  decision: null,
  delivery: 'none',
  blocking: null,
  refs: [],
  ...overrides,
})
const disposers: (() => void)[] = []
afterEach(() => {
  cleanup()
  disposers.splice(0).forEach((dispose) => dispose())
  vi.unstubAllGlobals()
})
function Probe() {
  return <p>{useNeedsYou() ? 'needs you' : 'calm'}</p>
}

test('turns on for an actionable human approval from the list or the stream, and off when it is answered', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ asOfSeq: 1, items: [], nextCursor: null }))),
  )
  const queryClient = createQueryClient()
  const client = createStreamClient({ EventSourceImpl: Source })
  const queries = createStreamQueryRegistry(queryClient, client)
  disposers.push(() => {
    queries.dispose()
    client.close()
    queryClient.clear()
  })
  render(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client, queries }}>
        <Probe />
      </StreamContext>
    </QueryClientProvider>,
  )
  await screen.findByText('calm')
  const emit = (type: string, data: Approval, seq: number) =>
    act(() =>
      Source.current.dispatchEvent(
        new MessageEvent(type, {
          data: JSON.stringify({ seq, ts: '2026-10-08T10:00:00.000Z', type, data }),
          lastEventId: String(seq),
        }),
      ),
    )
  emit('approval.requested', approval({}), 2)
  await waitFor(() => expect(screen.getByText('needs you')).toBeTruthy())
  emit('approval.updated', approval({ phase: 'decided', status: 'approved', actionable: false }), 3)
  await waitFor(() => expect(screen.getByText('calm')).toBeTruthy())
})
