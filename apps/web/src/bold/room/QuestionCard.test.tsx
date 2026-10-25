import type { AgentQuestion } from '@score/contract'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { questionsQuery } from '../../data/question-queries.ts'
import {
  agents,
  disposeRoomTest,
  jsonResponse,
  makeJob,
  mockFetch,
  renderInRoom,
} from './room-test-utils.tsx'
import { RoomRequests } from './RoomRequests.tsx'
import { QuestionNote } from './QuestionCard.tsx'

afterEach(() => {
  disposeRoomTest()
  vi.unstubAllGlobals()
})

const base: AgentQuestion = {
  id: 'q-1',
  agentId: 'builder',
  runId: 'run-1',
  roomId: 'room-1',
  jobId: 'job-1',
  question: 'Which database?\nPick one.',
  options: [],
  multiSelect: false,
  status: 'pending',
  answer: null,
  answeredBy: null,
  delivery: 'none',
  createdAt: '2026-10-24T09:03:00.000Z',
  expiresAt: '2026-10-24T10:03:00.000Z',
  answeredAt: null,
}
const job = makeJob({ id: 'job-1', title: 'Activity feed' })

function stub(question: AgentQuestion, answer?: (body: unknown) => Response | Promise<Response>) {
  const fetchMock = mockFetch(async (url, init) => {
    if (url === '/api/questions?status=all') return jsonResponse({ asOfSeq: 1, items: [question] })
    if (url === '/api/questions/q-1/answer' && init.method === 'POST')
      return answer
        ? answer(JSON.parse(String(init.body)))
        : jsonResponse({ ...question, delivery: 'delivering' }, 202)
    if (url === '/api/orchestrations/fence')
      return jsonResponse({
        fenced: false,
        reason: null,
        untrustedHistory: false,
        revision: 1,
        since: null,
        items: [],
        journal: { ok: true, entries: 0, bytes: 0, sizeAlarm: false },
      })
    return jsonResponse({ asOfSeq: 0, items: [] })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function mount() {
  return renderInRoom(
    <RoomRequests roomId="room-1" jobs={[job]} agents={agents} selectedJob="all" messages={[]} />,
  )
}

function posts(fetchMock: ReturnType<typeof stub>) {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method === 'POST')
    .map(([, init]) => JSON.parse(String(init!.body)) as unknown)
}

test('a free-text question is a protected region; Enter sends, Shift+Enter does not', async () => {
  const fetchMock = stub(base)
  mount()
  const card = await screen.findByRole('region', { name: 'builder asks' })
  expect(card.getAttribute('data-protected')).toBe('flex')
  expect(card.className).toContain('bold-question')
  expect(card.textContent).toContain('Which database?')
  expect(card.textContent).toMatch(/waits until/)
  // Never focused on arrival.
  expect(card.contains(document.activeElement)).toBe(false)
  const box = screen.getByLabelText(/Which database/) as HTMLTextAreaElement
  const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement
  expect(send.disabled).toBe(true)
  fireEvent.change(box, { target: { value: 'Postgres' } })
  fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
  expect(posts(fetchMock)).toHaveLength(0)
  fireEvent.keyDown(box, { key: 'Enter' })
  await screen.findByText('Delivering…')
  expect(posts(fetchMock)).toEqual([{ answer: 'Postgres' }])
  expect((screen.getByLabelText(/Which database/) as HTMLTextAreaElement).disabled).toBe(true)
})

test('a single-select question answers with the tapped option', async () => {
  const fetchMock = stub({ ...base, options: ['Postgres', 'SQLite'] })
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'SQLite' }))
  await screen.findByText('Delivering…')
  expect(posts(fetchMock)).toEqual([{ answer: 'SQLite' }])
})

test('a multi-select question toggles pills and sends them in option order', async () => {
  const fetchMock = stub({ ...base, options: ['Lint', 'Test', 'Deploy'], multiSelect: true })
  mount()
  const send = (await screen.findByRole('button', { name: 'Send' })) as HTMLButtonElement
  expect(send.disabled).toBe(true)
  const deploy = screen.getByRole('button', { name: 'Deploy' })
  fireEvent.click(deploy)
  fireEvent.click(screen.getByRole('button', { name: 'Lint' }))
  expect(deploy.getAttribute('aria-pressed')).toBe('true')
  expect(send.disabled).toBe(false)
  fireEvent.click(deploy)
  expect(deploy.getAttribute('aria-pressed')).toBe('false')
  fireEvent.click(deploy)
  fireEvent.click(send)
  await screen.findByText('Delivering…')
  expect(posts(fetchMock)).toEqual([{ answer: ['Lint', 'Deploy'] }])
})

test('a failed delivery brings the inputs back with a plain note, keeping the typed text', async () => {
  stub({ ...base, delivery: 'delivering' })
  const { queryClient } = mount()
  await screen.findByText('Delivering…')
  expect((screen.getByLabelText(/Which database/) as HTMLTextAreaElement).disabled).toBe(true)
  act(() =>
    queryClient.setQueryData(questionsQuery.key, {
      asOfSeq: 2,
      data: [{ ...base, delivery: 'failed' }],
    }),
  )
  await screen.findByText('Couldn’t deliver, try again')
  expect((screen.getByLabelText(/Which database/) as HTMLTextAreaElement).disabled).toBe(false)
})

test('a 409 takes the current question and the card goes', async () => {
  stub(base, () =>
    jsonResponse(
      {
        error: {
          code: 'conflict',
          message: 'No longer pending',
          details: { ...base, status: 'expired', answeredBy: 'timeout' },
        },
      },
      409,
    ),
  )
  mount()
  const box = (await screen.findByLabelText(/Which database/)) as HTMLTextAreaElement
  fireEvent.change(box, { target: { value: 'x' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(screen.queryByRole('region', { name: 'builder asks' })).toBeNull())
})

test('stream events add a question, announce it once, and an answered one leaves', async () => {
  stub(base)
  const { emit } = mount()
  await screen.findByRole('region', { name: 'builder asks' })
  // The question already waiting when the strip opened is not announced.
  expect(screen.queryByText('builder has a question')).toBeNull()
  const second: AgentQuestion = { ...base, id: 'q-2', question: 'Second?', agentId: 'reviewer' }
  act(() => emit({ type: 'question.requested', seq: 2, ts: base.createdAt, data: second }))
  await screen.findByRole('region', { name: 'reviewer asks' })
  await screen.findByText('reviewer has a question')
  act(() =>
    emit({
      type: 'question.updated',
      seq: 3,
      ts: base.createdAt,
      data: { ...second, status: 'answered', answeredBy: 'you', answer: 'ok', delivery: 'applied' },
    }),
  )
  await waitFor(() => expect(screen.queryByRole('region', { name: 'reviewer asks' })).toBeNull())
  expect(screen.getByRole('region', { name: 'builder asks' })).toBeDefined()
})

test('an ended question is one muted line with the outcome', () => {
  const { container } = renderInRoom(
    <>
      <QuestionNote
        question={{
          ...base,
          status: 'answered',
          answeredBy: 'you',
          answer: ['a', 'b'],
          delivery: 'applied',
        }}
        agents={agents}
      />
      <QuestionNote
        question={{ ...base, status: 'expired', answeredBy: 'timeout' }}
        agents={agents}
      />
    </>,
  )
  const lines = [...container.querySelectorAll('.bold-question-note')].map(
    (node) => node.textContent,
  )
  expect(lines[0]).toContain('builder asked: Which database?')
  expect(lines[0]).toContain('you answered: a, b')
  expect(lines[1]).toContain('no answer (timed out)')
})
