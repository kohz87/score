import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AgentSummary, Message } from '@score/contract'
import { createQueryClient } from '../../data/query-client.ts'
import { Composer } from './Composer.tsx'
import { messagesQuery } from './queries.ts'

const lead: AgentSummary = {
  id: 'lead',
  name: 'Lead',
  role: 'Example',
  style: { color: '#6B4EFF', shape: 'circle-dot' },
  status: 'idle',
  activity: null,
  model: null,
  served: true,
}
const stored: Message = {
  id: 'stored',
  roomId: 'general',
  author: { kind: 'you' },
  to: [],
  parts: [{ kind: 'text', text: 'hi' }],
  createdAt: '2026-10-08T10:00:00.000Z',
  streaming: false,
  refs: [],
}
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status })
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
let queryClient: ReturnType<typeof createQueryClient>
let knowledgeStatus: number

const knowledgePosts = () =>
  fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/knowledge/files-from-media'))
const box = () => screen.getByRole('combobox', { name: 'Message general' }) as HTMLTextAreaElement

beforeEach(() => {
  localStorage.clear()
  knowledgeStatus = 201
  queryClient = createQueryClient()
  queryClient.setQueryData(messagesQuery('general').key, {
    asOfSeq: 1,
    data: { items: [], nextCursor: null, typing: {} },
  })
  fetchMock = vi.fn(async (request, init) => {
    const url = String(request)
    if (url === '/api/commands') return json({ items: [] })
    if (url === '/api/media') {
      const name = ((init?.body as FormData).get('file') as File).name
      return json({ mediaId: 'm1', name, size: 4, contentType: 'application/pdf' }, 201)
    }
    if (url === '/api/knowledge/tree') return json({ folders: ['inbox', 'projects'], notes: [] })
    if (url.startsWith('/api/knowledge/files-from-media')) {
      if (knowledgeStatus === 409)
        return json(
          {
            error: {
              code: 'exists',
              message: 'exists',
              details: {
                existing: [
                  { path: 'inbox/report.pdf', mtime: '2026-09-01T00:00:00.000Z', size: 4 },
                ],
              },
            },
          },
          409,
        )
      return json(
        { path: JSON.parse(String(init?.body)).path, kind: 'document', replaced: false },
        201,
      )
    }
    if (init?.method === 'POST') return json({ message: stored, routedTo: ['lead'], command: null })
    return json({})
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function attach(name: string) {
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Composer roomId="general" roomName="general" agents={[lead]} leadAgentId="lead" />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  fireEvent.change(screen.getByTestId('attach-input'), {
    target: { files: [new File([new Uint8Array(4)], name, { type: 'application/pdf' })] },
  })
  await screen.findByText(name)
}
async function send() {
  fireEvent.change(box(), { target: { value: 'read this', selectionStart: 9 } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
}

test('"Also save to Knowledge" is off by default and nothing is saved then', async () => {
  await attach('report.pdf')
  const option = screen.getByRole('checkbox', { name: 'Also save report.pdf to Knowledge' })
  expect((option as HTMLInputElement).checked).toBe(false)
  await send()
  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/messages'))).toBe(true),
  )
  expect(knowledgePosts()).toHaveLength(0)
})

test('ticking it saves the file into the chosen folder after the message is sent', async () => {
  await attach('report.pdf')
  fireEvent.click(screen.getByRole('checkbox', { name: 'Also save report.pdf to Knowledge' }))
  const folder = screen.getByRole('combobox', { name: 'Knowledge folder for report.pdf' })
  expect((folder as HTMLInputElement).value).toBe('inbox')
  fireEvent.change(folder, { target: { value: 'projects' } })
  await send()
  await waitFor(() => expect(knowledgePosts()).toHaveLength(1))
  expect(JSON.parse(String(knowledgePosts()[0]![1]!.body))).toEqual({
    mediaId: 'm1',
    path: 'projects/report.pdf',
    onConflict: 'ask',
  })
  await screen.findByText(/Added projects\/report\.pdf/)
})

test('a name that exists asks keep both or replace, showing the existing date', async () => {
  knowledgeStatus = 409
  await attach('report.pdf')
  fireEvent.click(screen.getByRole('checkbox', { name: 'Also save report.pdf to Knowledge' }))
  await send()
  const dialog = await screen.findByRole('dialog', { name: /already exists/ })
  expect(dialog.textContent).toContain('inbox/report.pdf')
  fireEvent.click(screen.getByRole('button', { name: /Replace \(existing from/ }))
  await waitFor(() => expect(knowledgePosts()).toHaveLength(2))
  expect(JSON.parse(String(knowledgePosts()[1]![1]!.body)).onConflict).toBe('replace')
})

test('a type Knowledge cannot hold has no option', async () => {
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Composer roomId="general" roomName="general" agents={[lead]} leadAgentId="lead" />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  fetchMock.mockImplementation(async (request) =>
    String(request) === '/api/media'
      ? json(
          { mediaId: 'm2', name: 'sheet.xlsx', size: 4, contentType: 'application/vnd.ms-excel' },
          201,
        )
      : json({ items: [] }),
  )
  fireEvent.change(screen.getByTestId('attach-input'), {
    target: { files: [new File([new Uint8Array(4)], 'sheet.xlsx')] },
  })
  await screen.findByText('sheet.xlsx')
  expect(screen.queryByRole('checkbox', { name: /Also save/ })).toBeNull()
})
