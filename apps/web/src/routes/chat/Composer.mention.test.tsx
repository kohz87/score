import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AgentSummary } from '@score/contract'
import { createQueryClient } from '../../data/query-client.ts'
import { Composer } from './Composer.tsx'
import { requestMention } from './composer-mention.ts'
import { messagesQuery } from './queries.ts'

// PLAN 10.10: a click on a member of the room stage asks this composer for "@id ".
const agent = (id: string): AgentSummary => ({
  id,
  name: id,
  role: 'Example',
  style: { color: '#6B4EFF', shape: 'circle-dot' },
  status: 'idle',
  activity: null,
  model: null,
  served: true,
})
let queryClient: ReturnType<typeof createQueryClient>
const box = () => screen.getByRole('combobox', { name: 'Message general' }) as HTMLTextAreaElement

beforeEach(() => {
  localStorage.clear()
  queryClient = createQueryClient()
  queryClient.setQueryData(messagesQuery('general').key, {
    asOfSeq: 1,
    data: { items: [], nextCursor: null, typing: {} },
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ items: [] }))),
  )
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Composer roomId="general" roomName="general" agents={[agent('lead'), agent('builder')]} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
})
afterEach(() => {
  cleanup()
  queryClient.clear()
  vi.unstubAllGlobals()
})

test('a mention request writes "@id " at the caret and focuses the composer', () => {
  fireEvent.change(box(), { target: { value: 'ask for a review' } })
  box().setSelectionRange(3, 3)
  act(() => requestMention('general', 'builder'))
  expect(box().value).toBe('ask @builder for a review')
  expect(document.activeElement).toBe(box())
  expect(box().selectionStart).toBe(13)
})

test('a request for another room is ignored, and an empty composer just gets the mention', () => {
  act(() => requestMention('other', 'builder'))
  expect(box().value).toBe('')
  act(() => requestMention('general', 'lead'))
  expect(box().value).toBe('@lead ')
  act(() => requestMention('general', 'builder'))
  expect(box().value).toBe('@lead @builder ')
})
