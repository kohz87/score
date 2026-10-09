import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AgentSummary, Message } from '@score/contract'
import { createQueryClient } from '../../data/query-client.ts'
import { Composer } from './Composer.tsx'
import { startEdit, stopEdit } from './message-edit.ts'
import { messagesQuery } from './queries.ts'

// Audit wave 4 (batch B): a finished edit must not touch a composer that has moved on.
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
const mine = (id: string, text: string, to: string[] = ['lead']): Message => ({
  id,
  roomId: 'general',
  author: { kind: 'you' },
  to,
  parts: [{ kind: 'text', text }],
  createdAt: '2026-10-09T10:00:00.000Z',
  streaming: false,
  refs: [],
})
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status })
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
let queryClient: ReturnType<typeof createQueryClient>
let finishPost: (() => void) | null
const box = () => screen.getByRole('combobox', { name: 'Message general' }) as HTMLTextAreaElement
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')

beforeEach(() => {
  localStorage.clear()
  stopEdit()
  finishPost = null
  queryClient = createQueryClient()
  queryClient.setQueryData(messagesQuery('general').key, {
    asOfSeq: 1,
    data: { items: [], nextCursor: null, typing: {} },
  })
  fetchMock = vi.fn(async (input, init) => {
    if (String(input) === '/api/commands') return json({ items: [] })
    if (init?.method === 'POST') {
      // The response is held back until the test releases it.
      await new Promise<void>((resolve) => {
        finishPost = resolve
      })
      return json({ message: mine('new', 'sent'), routedTo: ['lead'], command: null })
    }
    return json({})
  })
  vi.stubGlobal('fetch', fetchMock)
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Composer roomId="general" roomName="general" agents={agents} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
})
afterEach(() => {
  cleanup()
  stopEdit()
  queryClient.clear()
  vi.unstubAllGlobals()
})

test('a correction that finishes after Cancel does not overwrite the draft typed since', async () => {
  fireEvent.change(box(), { target: { value: 'half typed' } })
  act(() => startEdit(mine('a', 'text A')))
  fireEvent.click(screen.getByRole('button', { name: 'Send correction' }))
  await waitFor(() => expect(posts()).toHaveLength(1))
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  fireEvent.change(box(), { target: { value: 'brand new draft' } })
  await act(async () => finishPost?.())
  await waitFor(() => expect(posts()).toHaveLength(1))
  expect(box().value).toBe('brand new draft')
})

test('a correction that finishes while another message is being edited leaves that edit alone', async () => {
  act(() => startEdit(mine('a', 'text A')))
  fireEvent.click(screen.getByRole('button', { name: 'Send correction' }))
  await waitFor(() => expect(posts()).toHaveLength(1))
  act(() => startEdit(mine('b', 'text B')))
  expect(box().value).toBe('text B')
  await act(async () => finishPost?.())
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(box().value).toBe('text B')
  expect(screen.getByText('Editing your message')).toBeDefined()
})

test('removing the last recipient while editing sends an explicit empty list', async () => {
  act(() => startEdit(mine('a', 'now @builder', ['lead'])))
  fireEvent.click(screen.getByRole('button', { name: 'Remove Lead' }))
  fireEvent.click(screen.getByRole('button', { name: 'Send correction' }))
  await waitFor(() => expect(posts()).toHaveLength(1))
  expect(JSON.parse(String(posts()[0]![1]!.body))).toEqual({
    text: 'now @builder',
    to: [],
    edits: 'a',
  })
  await act(async () => finishPost?.())
})
