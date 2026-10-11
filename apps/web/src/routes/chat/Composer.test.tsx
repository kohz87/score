import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AgentSummary, Message } from '@score/contract'
import { createQueryClient } from '../../data/query-client.ts'
import { Composer } from './Composer.tsx'
import { messagesQuery } from './queries.ts'

const make = (id: string, color: string, shape: AgentSummary['style']['shape']): AgentSummary => ({
  id,
  name: id[0]!.toUpperCase() + id.slice(1),
  role: 'Example',
  style: { color, shape },
  status: 'idle',
  activity: null,
  model: null,
  served: true,
})
const agents = [
  make('lead', '#6B4EFF', 'circle-dot'),
  make('builder', '#19C39A', 'triangle'),
  make('reviewer', '#FFB61E', 'diamond'),
]
const commands = [
  { name: 'assign', usage: '/assign @agent <title>', description: 'Create a task.' },
  { name: 'model', usage: '/model <model> <message…>', description: 'Use a model.' },
  { name: 'remember', usage: '/remember <fact>', description: 'Save a fact.' },
]
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

function posts() {
  return fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
}
function body(call: number) {
  return JSON.parse(String(posts()[call]![1]!.body)) as Record<string, unknown>
}
function mount(roomId = 'general') {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Composer roomId={roomId} roomName={roomId} agents={agents} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}
const box = () => screen.getByRole('combobox', { name: 'Message general' }) as HTMLTextAreaElement
function type(value: string) {
  fireEvent.change(box(), { target: { value, selectionStart: value.length } })
}
const press = (key: string, init: object = {}) => fireEvent.keyDown(box(), { key, ...init })

beforeEach(() => {
  localStorage.clear()
  queryClient = createQueryClient()
  queryClient.setQueryData(messagesQuery('general').key, {
    asOfSeq: 1,
    data: { items: [], nextCursor: null, typing: {} },
  })
  fetchMock = vi.fn(async (input, init) => {
    if (String(input) === '/api/commands') return json({ items: commands })
    if (init?.method === 'POST') return json({ message: stored, routedTo: ['lead'], command: null })
    return json({})
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  queryClient.clear()
  vi.unstubAllGlobals()
})

test('Enter sends, Shift+Enter does not, and the optimistic message is replaced by the stored one', async () => {
  mount()
  type('hello')
  press('Enter', { shiftKey: true })
  expect(posts()).toHaveLength(0)
  press('Enter')
  const key = messagesQuery('general').key
  const items = () =>
    (queryClient.getQueryData(key) as { data: { items: Message[] } }).data.items.map((m) => m.id)
  expect(items()[0]).toMatch(/^pending-/)
  await waitFor(() => expect(items()).toEqual(['stored']))
  expect(body(0)).toEqual({ text: 'hello' })
  const init = posts()[0]![1]!
  expect(new Headers(init.headers).get('Idempotency-Key')).toBeTruthy()
  expect(box().value).toBe('')
  expect(localStorage.getItem('score.chat.draft.general')).toBeNull()
})

test('To chips: default is the room lead; add and remove', () => {
  mount()
  expect(screen.getByText('Room lead')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Add someone' }))
  fireEvent.click(within(screen.getByRole('list', { name: 'Add someone' })).getByText('Builder'))
  expect(screen.getByRole('button', { name: 'Remove Builder' })).toBeDefined()
  expect(screen.queryByText('Room lead')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Remove Builder' }))
  expect(screen.getByText('Room lead')).toBeDefined()
})

test('chips and Plan first are sent as to and planFirst', async () => {
  mount()
  fireEvent.click(screen.getByRole('button', { name: 'Add someone' }))
  fireEvent.click(within(screen.getByRole('list', { name: 'Add someone' })).getByText('Reviewer'))
  const plan = screen.getByRole('button', { name: 'Plan first' })
  expect(plan.getAttribute('aria-pressed')).toBe('false')
  fireEvent.click(plan)
  expect(plan.getAttribute('aria-pressed')).toBe('true')
  type('look at this')
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(posts()).toHaveLength(1))
  expect(body(0)).toEqual({ text: 'look at this', to: ['reviewer'], planFirst: true })
})

test('@autocomplete filters agents and is keyboard operable', () => {
  mount()
  type('ping @b')
  const list = screen.getByRole('listbox', { name: 'Agents' })
  expect(within(list).getAllByRole('option')).toHaveLength(1)
  type('ping @')
  expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(3)
  press('ArrowDown')
  expect(screen.getAllByRole('option')[1]!.getAttribute('aria-selected')).toBe('true')
  expect(box().getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[1]!.id)
  press('Enter')
  expect(box().value).toBe('ping @builder ')
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(posts()).toHaveLength(0)
  type('x @re')
  press('Tab')
  expect(box().value).toBe('x @reviewer ')
  type('@')
  press('Escape')
  expect(screen.queryByRole('listbox')).toBeNull()
})

test('slash menu comes from /api/commands and supports arrows, Enter, Escape and click', async () => {
  mount()
  type('/')
  const list = await screen.findByRole('listbox', { name: 'Commands' })
  await screen.findByText('Create a task.')
  expect(
    within(list)
      .getAllByRole('option')
      .map((o) => o.textContent),
  ).toEqual([
    '/assignCreate a task.',
    '/modelUse a model.',
    '/rememberSave a fact.',
    '/compressCompact this agent’s session.',
    '/usageShow tokens and cost for this agent.',
  ])
  press('ArrowUp')
  expect(screen.getAllByRole('option')[4]!.getAttribute('aria-selected')).toBe('true')
  press('ArrowDown')
  press('ArrowDown')
  press('Enter')
  expect(box().value).toBe('/model ')
  expect(screen.queryByRole('listbox')).toBeNull()
  type('/re')
  expect(screen.getAllByRole('option')).toHaveLength(1)
  press('Escape')
  expect(screen.queryByRole('listbox')).toBeNull()
  type('/a')
  fireEvent.click(screen.getByRole('option'))
  expect(box().value).toBe('/assign ')
  type('/assign @builder do it')
  expect(screen.queryByRole('listbox')).toBeNull()
})

test('failed send keeps the draft, removes the optimistic message and shows the usage', async () => {
  fetchMock.mockImplementation(async (input, init) =>
    init?.method === 'POST'
      ? json(
          {
            error: {
              code: 'bad_request',
              message: 'x',
              details: { error: 'Missing title.', usage: '/assign @agent <title>' },
            },
          },
          400,
        )
      : json({ items: commands }),
  )
  mount()
  type('/assign @builder x')
  press('Enter')
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toBe('Missing title. Usage: /assign @agent <title>')
  expect(box().value).toBe('/assign @builder x')
  expect(localStorage.getItem('score.chat.draft.general')).toBe('/assign @builder x')
  const data = queryClient.getQueryData(messagesQuery('general').key) as {
    data: { items: unknown[] }
  }
  expect(data.data.items).toHaveLength(0)
})

test('501 and network errors explain themselves; a retry reuses the idempotency key', async () => {
  fetchMock.mockImplementation(async (input, init) =>
    init?.method === 'POST'
      ? json(
          {
            error: {
              code: 'not_implemented',
              message: 'n',
              details: { usage: '/routine @agent <schedule> <prompt>' },
            },
          },
          501,
        )
      : json({ items: commands }),
  )
  mount()
  type('/routine @builder daily go')
  press('Enter')
  expect((await screen.findByRole('alert')).textContent).toBe(
    'That command isn’t available yet. Usage: /routine @agent <schedule> <prompt>',
  )
  press('Enter')
  await waitFor(() => expect(posts()).toHaveLength(2))
  const key = (n: number) => new Headers(posts()[n]![1]!.headers).get('Idempotency-Key')
  expect(key(0)).toBe(key(1))
})

test('/assign result links to the created task', async () => {
  fetchMock.mockImplementation(async (input, init) =>
    init?.method === 'POST'
      ? json({
          message: stored,
          routedTo: [],
          command: { kind: 'assign', taskId: 't_1', taskKey: 'T-1' },
        })
      : json({ items: commands }),
  )
  mount()
  type('/assign @builder Fix it')
  press('Enter')
  const status = await screen.findByRole('status')
  expect(status.textContent).toBe('Created task T-1')
  expect(within(status).getByRole('link', { name: 'T-1' }).getAttribute('href')).toBe('/tasks/t_1')
})

test('drafts persist per room and are restored', () => {
  const first = mount()
  type('half a thought')
  first.unmount()
  expect(localStorage.getItem('score.chat.draft.general')).toBe('half a thought')
  mount()
  expect(box().value).toBe('half a thought')
  cleanup()
  mount('elsewhere')
  expect((screen.getByRole('combobox') as HTMLTextAreaElement).value).toBe('')
})

test('works when storage is blocked and attach stays available', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  mount()
  type('still works')
  expect(box().value).toBe('still works')
  const attach = screen.getByRole('button', { name: 'Attach files' })
  expect(attach.hasAttribute('disabled')).toBe(false)
  vi.restoreAllMocks()
})

test('attached images upload as multipart and are sent as attachments', async () => {
  fetchMock.mockImplementation(async (input, init) => {
    if (String(input) === '/api/commands') return json({ items: commands })
    if (String(input) === '/api/media')
      return json({ mediaId: 'm1', name: 'dot.png', size: 3, contentType: 'image/png' }, 201)
    if (init?.method === 'POST') return json({ message: stored, routedTo: ['lead'], command: null })
    return json({})
  })
  mount()
  const input = screen.getByTestId('attach-input') as HTMLInputElement
  fireEvent.change(input, {
    target: { files: [new File([new Uint8Array([1, 2, 3])], 'dot.png', { type: 'image/png' })] },
  })
  await screen.findByText('dot.png')
  const upload = posts()[0]!
  expect(String(upload[0])).toBe('/api/media')
  expect(upload[1]!.body).toBeInstanceOf(FormData)
  expect(new Headers(upload[1]!.headers).get('content-type')).toBeNull()
  type('see this')
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(posts()).toHaveLength(2))
  expect(body(1)).toEqual({ text: 'see this', attachments: [{ mediaId: 'm1', name: 'dot.png' }] })
  await waitFor(() => expect(screen.queryByText('dot.png')).toBeNull())
})

test('text typed while a send is in flight survives the response and its draft stays stored', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  fetchMock.mockImplementation(async (input, init) => {
    if (String(input) === '/api/commands') return json({ items: commands })
    if (init?.method === 'POST') {
      await gate
      return json({ message: stored, routedTo: ['lead'], command: null })
    }
    return json({})
  })
  mount()
  type('first')
  press('Enter')
  await waitFor(() => expect(posts()).toHaveLength(1))
  type('second')
  release()
  await waitFor(() => expect(box().disabled).toBe(false))
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(box().value).toBe('second')
  expect(localStorage.getItem('score.chat.draft.general')).toBe('second')
})

test('on a touch device Enter adds a newline and the Send button sends', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(hover: none) and (pointer: coarse)',
  }))
  mount()
  type('hello')
  press('Enter')
  expect(posts()).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(posts()).toHaveLength(1))
})

test('with "Send with Ctrl+Enter" on desktop, Enter does not send and Ctrl+Enter does', async () => {
  localStorage.setItem('score.sendKey', 'ctrl-enter')
  mount()
  type('hello')
  press('Enter')
  expect(posts()).toHaveLength(0)
  press('Enter', { ctrlKey: true })
  await waitFor(() => expect(posts()).toHaveLength(1))
  expect(body(0)).toEqual({ text: 'hello' })
})
