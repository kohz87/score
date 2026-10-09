import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AgentSummary, Message } from '@score/contract'
import { createQueryClient } from '../../data/query-client.ts'
import { Composer } from './Composer.tsx'
import { messagesQuery } from './queries.ts'

const make = (id: string): AgentSummary => ({
  id,
  name: id[0]!.toUpperCase() + id.slice(1),
  role: 'Example',
  style: { color: '#6B4EFF', shape: 'circle-dot' },
  status: 'idle',
  activity: null,
  model: null,
  served: true,
})
const agents = [make('lead'), make('builder')]
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
let uploads = 0
let sendResult: Record<string, unknown>

const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
const sends = () => posts().filter(([url]) => String(url).endsWith('/messages'))
const sentBody = (call: number) =>
  JSON.parse(String(sends()[call]![1]!.body)) as Record<string, unknown>
const box = () => screen.getByRole('combobox', { name: 'Message general' }) as HTMLTextAreaElement
const input = () => screen.getByTestId('attach-input') as HTMLInputElement
function mount() {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Composer roomId="general" roomName="general" agents={agents} leadAgentId="lead" />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}
const file = (name: string, type = '', bytes = 4) =>
  new File([new Uint8Array(bytes)], name, { type })

beforeEach(() => {
  localStorage.clear()
  uploads = 0
  sendResult = { message: stored, routedTo: ['lead'], command: null }
  queryClient = createQueryClient()
  queryClient.setQueryData(messagesQuery('general').key, {
    asOfSeq: 1,
    data: { items: [], nextCursor: null, typing: {} },
  })
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open')
    this.dispatchEvent(new Event('close'))
  }
  fetchMock = vi.fn(async (request, init) => {
    const url = String(request)
    if (url === '/api/commands') return json({ items: [] })
    if (url === '/api/media') {
      uploads += 1
      const name = ((init?.body as FormData).get('file') as File).name
      const type = name.endsWith('.pdf')
        ? 'application/pdf'
        : name.endsWith('.csv')
          ? 'text/csv'
          : 'image/png'
      return json({ mediaId: `m${uploads}`, name, size: 4, contentType: type }, 201)
    }
    if (url === '/api/agents/lead/workspace')
      return json({ root: '/work', available: true, reason: null })
    if (url.startsWith('/api/agents/lead/workspace/tree'))
      return json({
        entries: [
          {
            name: 'report.md',
            kind: 'file',
            size: 3,
            mtime: '2026-10-09T00:00:00.000Z',
            hidden: false,
          },
        ],
      })
    if (init?.method === 'POST') return json(sendResult)
    return json({})
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('documents attach by button and are sent with their names; only images get a thumbnail', async () => {
  mount()
  fireEvent.change(input(), {
    target: { files: [file('report.pdf', 'application/pdf'), file('data.csv', 'text/csv')] },
  })
  await screen.findByText('report.pdf')
  await screen.findByText('data.csv')
  expect(document.querySelectorAll('.chat-attachment img')).toHaveLength(0)
  fireEvent.change(box(), { target: { value: 'read these', selectionStart: 10 } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(sends()).toHaveLength(1))
  expect(sentBody(0)).toEqual({
    text: 'read these',
    attachments: [
      { mediaId: 'm1', name: 'report.pdf' },
      { mediaId: 'm2', name: 'data.csv' },
    ],
  })
})

test('dropping and pasting files attach them; pasting text does not', async () => {
  mount()
  const form = box().closest('form')!
  fireEvent.drop(form, { dataTransfer: { files: [file('a.pdf')], types: ['Files'] } })
  await screen.findByText('a.pdf')
  fireEvent.paste(box(), { clipboardData: { files: [file('shot.png', 'image/png')] } })
  await screen.findByText('shot.png')
  const before = uploads
  fireEvent.paste(box(), { clipboardData: { files: [], getData: () => 'plain' } })
  expect(uploads).toBe(before)
})

test('files over the size limits are refused before uploading', async () => {
  mount()
  fireEvent.change(input(), {
    target: { files: [file('huge.pdf', 'application/pdf', 26 * 1024 * 1024)] },
  })
  expect((await screen.findByRole('alert')).textContent).toContain('huge.pdf is larger than 25 MB')
  fireEvent.change(input(), { target: { files: [file('big.png', 'image/png', 9 * 1024 * 1024)] } })
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain('big.png is larger than 8 MB'),
  )
  expect(uploads).toBe(0)
})

test('at most ten attachments', async () => {
  mount()
  fireEvent.change(input(), {
    target: { files: Array.from({ length: 11 }, (_, i) => file(`f${i}.pdf`, 'application/pdf')) },
  })
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain('up to 10 attachments'),
  )
  await waitFor(() => expect(document.querySelectorAll('.chat-attachment')).toHaveLength(10))
  expect(uploads).toBe(10)
  expect((screen.getByRole('button', { name: 'Attach files' }) as HTMLButtonElement).disabled).toBe(
    true,
  )
})

test('a workspace file attaches by reference, with no upload', async () => {
  mount()
  fireEvent.click(screen.getByRole('button', { name: 'Attach files' }))
  fireEvent.click(screen.getByRole('button', { name: 'From workspace…' }))
  const dialog = await screen.findByRole('dialog', { name: 'Attach from workspace' })
  const attach = within(dialog).getByRole('button', { name: 'Attach' }) as HTMLButtonElement
  expect(attach.disabled).toBe(true)
  fireEvent.click(await within(dialog).findByRole('treeitem', { name: /report\.md/ }))
  expect(attach.disabled).toBe(false)
  fireEvent.click(attach)
  await screen.findByText('report.md')
  expect(uploads).toBe(0)
  fireEvent.change(box(), { target: { value: 'look', selectionStart: 4 } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(sends()).toHaveLength(1))
  expect(sentBody(0)).toEqual({
    text: 'look',
    attachments: [{ workspace: { agentId: 'lead', path: 'report.md', root: '/work' } }],
  })
})

test('a notice from the server (a document that could not be saved) is shown after sending', async () => {
  sendResult = {
    ...sendResult,
    notices: ['report.pdf was not saved for @lead: No working folder is set'],
  }
  mount()
  fireEvent.change(input(), { target: { files: [file('report.pdf', 'application/pdf')] } })
  await screen.findByText('report.pdf')
  fireEvent.change(box(), { target: { value: 'go', selectionStart: 2 } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  expect((await screen.findByRole('status')).textContent).toContain(
    'report.pdf was not saved for @lead',
  )
})
