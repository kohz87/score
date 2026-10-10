import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Message } from '@score/contract'
import { createQueryClient } from '../../data/query-client.ts'
import { SaveToKnowledge, saveCandidates } from '../knowledge/SaveToKnowledge.tsx'

const base: Message = {
  id: 'msg-1',
  roomId: 'general',
  author: { kind: 'agent', agentId: 'builder' },
  to: [],
  parts: [{ kind: 'text', text: 'Here is the plan.' }],
  createdAt: '2026-10-08T10:05:00.000Z',
  streaming: false,
  refs: [],
}
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status })
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>

beforeEach(() => {
  fetchMock = vi.fn(async (request, init) => {
    const url = String(request)
    if (url === '/api/knowledge/tree') return json({ folders: ['inbox'], notes: [] })
    if (url.startsWith('/api/knowledge/files/') && init?.method === 'PUT')
      return json(
        {
          path: decodeURIComponent(new URL(url, 'http://x').pathname.slice(21)),
          kind: 'note',
          replaced: false,
        },
        201,
      )
    if (url === '/api/knowledge/files-from-media')
      return json(
        { path: JSON.parse(String(init?.body)).path, kind: 'document', replaced: false },
        201,
      )
    return json({})
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('an agent reply is offered as a note, a user message with only text is not', () => {
  expect(saveCandidates(base, 'Builder').map((c) => c.key)).toEqual(['reply'])
  expect(saveCandidates({ ...base, author: { kind: 'you' } }, 'You')).toEqual([])
})

test('attachments of any message are offered; unsupported types are disabled', () => {
  const message: Message = {
    ...base,
    author: { kind: 'you' },
    parts: [
      { kind: 'document', mediaId: 'm1', name: 'a.pdf', contentType: 'application/pdf', size: 3 },
      {
        kind: 'document',
        mediaId: 'm2',
        name: 'b.xlsx',
        contentType: 'application/vnd.ms-excel',
        size: 3,
      },
    ],
  }
  expect(saveCandidates(message, 'You').map((c) => [c.label, c.supported])).toEqual([
    ['a.pdf', true],
    ['b.xlsx', false],
  ])
})

test('saving a reply writes a note that links back to the room', async () => {
  const onClose = vi.fn()
  render(
    <QueryClientProvider client={createQueryClient()}>
      <SaveToKnowledge message={base} authorName="Builder" onClose={onClose} />
    </QueryClientProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await screen.findByText(/Added inbox\/Reply from Builder/)
  const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')!
  expect(String(put[0])).toContain('/api/knowledge/files/inbox/Reply%20from%20Builder')
  const blob = put[1]!.body as Blob
  const text = await new Promise<string>((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.readAsText(blob)
  })
  expect(text).toContain('Here is the plan.')
  expect(text).toContain('(/chat/general#message-msg-1)')
  fireEvent.click(screen.getByRole('button', { name: 'Done' }))
  expect(onClose).toHaveBeenCalled()
})

test('saving an attachment sends the chat upload by id', async () => {
  const message: Message = {
    ...base,
    author: { kind: 'you' },
    parts: [
      { kind: 'document', mediaId: 'm1', name: 'a.pdf', contentType: 'application/pdf', size: 3 },
    ],
  }
  render(
    <QueryClientProvider client={createQueryClient()}>
      <SaveToKnowledge message={message} authorName="You" onClose={() => undefined} />
    </QueryClientProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/knowledge/files-from-media')).toBe(
      true,
    ),
  )
})
