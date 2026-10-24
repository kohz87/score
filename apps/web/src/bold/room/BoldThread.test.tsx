import type { Approval, Exchange, Job, Message } from '@score/contract'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { BoldThread } from './BoldThread.tsx'
import {
  agents,
  disposeRoomTest,
  jsonResponse,
  makeExchange,
  makeJob,
  makeMessage,
  mockFetch,
  room,
  renderInRoom,
} from './room-test-utils.tsx'

afterEach(() => {
  disposeRoomTest()
  vi.unstubAllGlobals()
})

type Setup = {
  jobs: Job[]
  exchanges?: Exchange[]
  messages?: Message[]
  approvals?: Approval[]
}

function stub({ jobs, exchanges = [], messages = [], approvals = [] }: Setup) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchMock = mockFetch((url, init) => {
    calls.push({ url, init })
    if (url === '/api/team-room') return jsonResponse({ asOfSeq: 1, room, jobs })
    if (url === '/api/agents') return jsonResponse({ asOfSeq: 1, items: agents })
    if (url === '/api/rooms/room-1/jobs') return jsonResponse({ asOfSeq: 1, items: jobs })
    if (url.startsWith('/api/rooms/room-1/messages') && init.method !== 'POST')
      return jsonResponse({ asOfSeq: 1, items: messages, nextCursor: null, jobId: 'job-1' })
    if (/^\/api\/jobs\/[^/]+\/exchanges$/.test(url))
      return jsonResponse({ asOfSeq: 1, items: exchanges })
    if (url === '/api/approvals?status=all')
      return jsonResponse({ asOfSeq: 1, items: approvals, nextCursor: null })
    if (init.method === 'POST') return jsonResponse({ ok: true })
    return jsonResponse({ asOfSeq: 0, items: [] })
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}

const job = makeJob()

test('without a job the thread offers the named jobs to open', async () => {
  stub({ jobs: [makeJob({ isDefault: true, title: 'Team room' }), job] })
  const picked = vi.fn()
  renderInRoom(<BoldThread jobId={null} onSelectJob={picked} />, ['/b'])
  fireEvent.click(await screen.findByRole('button', { name: /Activity feed/ }))
  expect(picked).toHaveBeenCalledWith('job-1')
  expect(screen.queryByRole('button', { name: /^Team room/ })).toBeNull()
})

test('an empty job says so and keeps the step-in box', async () => {
  stub({ jobs: [job] })
  renderInRoom(<BoldThread jobId="job-1" onSelectJob={() => undefined} />, ['/b'])
  expect(await screen.findByText('Nothing here yet. Write below to step in.')).toBeTruthy()
  expect(screen.getByLabelText('Step in')).toBeTruthy()
})

test('a job that no longer exists is said plainly', async () => {
  stub({ jobs: [job] })
  renderInRoom(<BoldThread jobId="gone" onSelectJob={() => undefined} />, ['/b'])
  expect(await screen.findByText('This job no longer exists.')).toBeTruthy()
})

test('the header counts turns and each send-back starts the next round', async () => {
  stub({
    jobs: [job],
    exchanges: [makeExchange({ state: 'live', pause: null, turnsUsed: 5 })],
    messages: [
      makeMessage({
        id: 'm1',
        author: { kind: 'agent', agentId: 'reviewer' },
        parts: [
          { kind: 'text', text: 'Needs work.' },
          { kind: 'review', verdict: 'changes_requested', taskId: null },
        ],
      }),
      makeMessage({
        id: 'm2',
        createdAt: '2026-10-24T09:02:00.000Z',
        author: { kind: 'agent', agentId: 'builder' },
        parts: [{ kind: 'text', text: 'Fixed it.' }],
      }),
    ],
  })
  renderInRoom(<BoldThread jobId="job-1" onSelectJob={() => undefined} />, ['/b'])
  expect(await screen.findByText(/5 of 8 turns used/)).toBeTruthy()
  expect(await screen.findByRole('heading', { name: 'Round 2' })).toBeTruthy()
  expect(screen.getByText('Fixed it.')).toBeTruthy()
  expect(document.querySelector('.bold-request')).toBeNull()
})

test('a paused exchange shows a protected decision card and step-in answers it', async () => {
  const calls = stub({ jobs: [job], exchanges: [makeExchange()] })
  renderInRoom(<BoldThread jobId="job-1" onSelectJob={() => undefined} />, ['/b'])
  const card = await screen.findByLabelText(/^Needs you/)
  expect(card.getAttribute('data-protected')).toBe('flex')
  fireEvent.change(screen.getByLabelText('Step in'), { target: { value: 'Carry on' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send step-in' }))
  await waitFor(() =>
    expect(calls.some((c) => c.url === '/api/exchanges/exchange-1/decision')).toBe(true),
  )
  const call = calls.find((c) => c.url === '/api/exchanges/exchange-1/decision')!
  expect(JSON.parse(String(call.init.body))).toEqual({ option: 'step_in', text: 'Carry on' })
})

// The strip may be filtered to another job or covered by the phone sheet, so the thread never points at a card it
// can't guarantee is visible: it shows the approval itself.
test('a pending approval in the thread is its real card, never a pointer to a strip that may be hidden', async () => {
  const approval: Approval = {
    id: 'approval-1',
    origin: 'score-run',
    phase: 'human_pending',
    status: 'pending',
    actionable: true,
    linkedTo: null,
    agentId: 'builder',
    title: 'May I install a package?',
    command: 'npm install ws@8',
    cwd: '~/app',
    description: 'The websocket feed needs ws.',
    choices: ['once', 'deny'],
    createdAt: '2026-10-24T09:03:00.000Z',
    expiresAt: null,
    decision: null,
    delivery: 'none',
    blocking: null,
    refs: [],
  }
  stub({
    jobs: [job],
    approvals: [approval],
    messages: [
      makeMessage({
        id: 'approval-message',
        author: { kind: 'agent', agentId: 'builder' },
        parts: [{ kind: 'approval', approvalId: approval.id }],
      }),
    ],
  })
  renderInRoom(<BoldThread jobId="job-1" onSelectJob={() => undefined} />, ['/b'])
  expect(await screen.findByText('May I install a package?')).toBeTruthy()
  expect(screen.queryByText('Waiting in Needs you')).toBeNull()
})

test('stop asks first and sends once confirmed; a finished job cannot be stopped', async () => {
  const calls = stub({ jobs: [job] })
  renderInRoom(<BoldThread jobId="job-1" onSelectJob={() => undefined} />, ['/b'])
  fireEvent.click(await screen.findByRole('button', { name: 'Stop' }))
  const dialog = screen.getByRole('alertdialog')
  expect(dialog.getAttribute('data-protected')).toBe('block')
  expect(calls.some((c) => c.url === '/api/jobs/job-1/stop')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Stop job' }))
  await waitFor(() => expect(calls.some((c) => c.url === '/api/jobs/job-1/stop')).toBe(true))
  expect(await screen.findByText('Stop sent.')).toBeTruthy()
})

test('a done job has Stop disabled', async () => {
  stub({ jobs: [makeJob({ state: 'done' })] })
  renderInRoom(<BoldThread jobId="job-1" onSelectJob={() => undefined} />, ['/b'])
  const stop = (await screen.findByRole('button', { name: 'Stop' })) as HTMLButtonElement
  expect(stop.disabled).toBe(true)
})

test('a job with a recipe that is not in the run list says so', async () => {
  stub({ jobs: [makeJob({ recipe: { kind: 'workflow', ref: 'wf-9' } })] })
  renderInRoom(<BoldThread jobId="job-1" onSelectJob={() => undefined} />, ['/b'])
  expect(await screen.findByLabelText('Recipe run')).toBeTruthy()
  expect(await screen.findByText(/links to workflow wf-9/)).toBeTruthy()
  expect(screen.queryByRole('link', { name: 'Open the run' })).toBeNull()
})

test('a 403 on the step-in box asks to pair this browser, and a done job has the box disabled', async () => {
  const fetchMock = mockFetch((url, init) => {
    if (url === '/api/team-room') return jsonResponse({ asOfSeq: 1, room, jobs: [job] })
    if (url === '/api/agents') return jsonResponse({ asOfSeq: 1, items: agents })
    if (url === '/api/rooms/room-1/jobs') return jsonResponse({ asOfSeq: 1, items: [job] })
    if (init.method === 'POST')
      return jsonResponse({ error: { code: 'forbidden', message: 'no' } }, 403)
    if (url.startsWith('/api/rooms/room-1/messages'))
      return jsonResponse({ asOfSeq: 1, items: [], nextCursor: null, jobId: 'job-1' })
    return jsonResponse({ asOfSeq: 0, items: [] })
  })
  vi.stubGlobal('fetch', fetchMock)
  renderInRoom(<BoldThread jobId="job-1" onSelectJob={() => undefined} />, ['/b'])
  fireEvent.change(await screen.findByLabelText('Step in'), { target: { value: 'Hello' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send step-in' }))
  expect(await screen.findByText('Pair this browser first.')).toBeTruthy()
})

test('the step-in box is disabled on a closed job', async () => {
  stub({ jobs: [makeJob({ state: 'closed' })] })
  renderInRoom(<BoldThread jobId="job-1" onSelectJob={() => undefined} />, ['/b'])
  const box = (await screen.findByLabelText('Step in')) as HTMLInputElement
  expect(box.disabled).toBe(true)
})
