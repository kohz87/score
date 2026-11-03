import type { Approval, Message } from '@score/contract'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  agents,
  disposeRoomTest,
  jsonResponse,
  makeExchange,
  makeJob,
  makeMessage,
  mockFetch,
  renderInRoom,
} from './room-test-utils.tsx'
import { NeedsSlotsProvider } from './needs-slots.tsx'
import { RoomMessageStream } from './RoomMessageStream.tsx'
import { RoomRequests } from './RoomRequests.tsx'

afterEach(() => {
  disposeRoomTest()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

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

const jobs = [
  makeJob({ id: 'job-1', title: 'Activity feed', state: 'working' }),
  makeJob({ id: 'job-2', title: 'Release notes', state: 'working' }),
]
const messages: Message[] = [
  makeMessage({ id: 'm-1', jobId: 'job-1', parts: [{ kind: 'text', text: 'First thing.' }] }),
  makeMessage({
    id: 'm-2',
    jobId: 'job-1',
    author: { kind: 'agent', agentId: 'builder' },
    createdAt: '2026-10-24T09:02:00.000Z',
    parts: [
      { kind: 'text', text: 'It needs ws@8.' },
      { kind: 'approval', approvalId: 'approval-1' },
    ],
  }),
  makeMessage({
    id: 'm-3',
    jobId: 'job-1',
    createdAt: '2026-10-24T09:04:00.000Z',
    parts: [{ kind: 'text', text: 'Third thing.' }],
  }),
  makeMessage({
    id: 'm-4',
    jobId: 'job-2',
    createdAt: '2026-10-24T09:05:00.000Z',
    parts: [{ kind: 'text', text: 'Notes thing.' }],
  }),
]

function stub(options: { approvals?: Approval[]; exchange?: boolean; fenced?: boolean } = {}) {
  const exchange = options.exchange ? makeExchange({ jobId: 'job-2' }) : null
  vi.stubGlobal(
    'fetch',
    mockFetch((url) => {
      const parsed = new URL(url, 'http://x')
      if (parsed.pathname === '/api/rooms/room-1/messages')
        return jsonResponse({ asOfSeq: 1, items: messages, nextCursor: null, jobId: null })
      if (parsed.pathname === '/api/approvals')
        return jsonResponse({ asOfSeq: 1, items: options.approvals ?? [], nextCursor: null })
      if (parsed.pathname === '/api/orchestrations/fence')
        return jsonResponse({
          fenced: options.fenced ?? false,
          reason: options.fenced ? 'restore' : null,
          untrustedHistory: false,
          revision: 1,
          since: options.fenced ? '2026-10-24T09:00:00.000Z' : null,
          items: [],
          journal: { ok: true, entries: 0, bytes: 0, sizeAlarm: false },
        })
      if (parsed.pathname === '/api/tasks')
        return jsonResponse({
          asOfSeq: 1,
          columns: { planned: [], working: [], in_review: [], needs_you: [], done: [] },
        })
      if (parsed.pathname.startsWith('/api/jobs/') && exchange)
        return jsonResponse({
          asOfSeq: 1,
          items: parsed.pathname.includes('job-2') ? [exchange] : [],
        })
      if (parsed.pathname === '/api/rooms/room-1/pins')
        return jsonResponse({ items: [], revision: 0 })
      return jsonResponse({ asOfSeq: 1, items: [] })
    }),
  )
}

function renderChat() {
  return renderInRoom(
    <NeedsSlotsProvider>
      <RoomRequests
        roomId="room-1"
        jobs={jobs}
        agents={agents}
        selectedJob="all"
        messages={messages}
      />
      <div className="stream" id="bold-room-stream">
        <RoomMessageStream
          roomId="room-1"
          jobs={jobs}
          agents={agents}
          showDeleted={false}
          seek={null}
          onSeeked={() => undefined}
        />
      </div>
    </NeedsSlotsProvider>,
  )
}

function slotOf(element: HTMLElement) {
  return element.closest<HTMLElement>('[data-needs-slot]')?.dataset.needsSlot
}

test('an approval card sits right after the message that asked, inside the conversation', async () => {
  stub({ approvals: [approval] })
  renderChat()
  const card = await screen.findByRole('article', { name: /Needs you: May I install a package/ })
  await waitFor(() => expect(slotOf(card)).toBe('after:m-2'))
  expect(card.getAttribute('data-protected')).toBe('flex')
  const asked = document.getElementById('message-m-2')!
  const next = document.getElementById('message-m-3')!
  expect(asked.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(card.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  // The pinned strip is gone.
  expect(document.querySelector('.bold-pins')).toBeNull()
  expect(screen.queryByRole('region', { name: 'Needs you' })).toBeNull()
})

test('a card with no message of its own goes to the end of its topic’s run', async () => {
  stub({ exchange: true })
  renderChat()
  const card = await screen.findByRole('article', { name: /The exchange used its turns/ })
  await waitFor(() => expect(slotOf(card)).toBe('topic:job-2'))
  const last = document.getElementById('message-m-4')!
  expect(last.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

test('a card with no anchor goes to the end of the conversation', async () => {
  stub({ fenced: true })
  renderChat()
  const card = await screen.findByRole('article', { name: /Starting work is blocked/ })
  expect(slotOf(card)).toBe('end')
  const last = document.getElementById('message-m-4')!
  expect(last.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

test('an approval whose message is not loaded falls back to the end of the conversation', async () => {
  stub({ approvals: [{ ...approval, id: 'approval-9', title: 'Another approval' }] })
  renderChat()
  const card = await screen.findByRole('article', { name: /Needs you: Another approval/ })
  expect(slotOf(card)).toBe('end')
})

// The jump chip measures real boxes; jsdom has none, so the test hands out the boxes.
let viewBox = { top: 0, bottom: 400 }
let cardBoxes: Record<string, { top: number; bottom: number }> = {}
let scrollIntoView: ReturnType<typeof vi.fn>

beforeEach(() => {
  viewBox = { top: 0, bottom: 400 }
  cardBoxes = {}
  scrollIntoView = vi.fn()
  Element.prototype.scrollIntoView = scrollIntoView as unknown as Element['scrollIntoView']
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const key = this.getAttribute('data-pin-key')
    const box = key
      ? (cardBoxes[key] ?? { top: 100, bottom: 200 })
      : this.id === 'bold-room-stream'
        ? viewBox
        : { top: 0, bottom: 0 }
    return {
      ...box,
      left: 0,
      right: 100,
      width: 100,
      height: box.bottom - box.top,
      x: 0,
      y: box.top,
      toJSON: () => ({}),
    }
  })
})

async function scrolled() {
  await act(async () => {
    document.getElementById('bold-room-stream')!.dispatchEvent(new Event('scroll'))
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
  })
}

test('the jump chip shows only while a card is out of view, says which way, and takes you to it', async () => {
  stub({ approvals: [approval] })
  renderChat()
  const card = await screen.findByRole('article', { name: /Needs you: May I install a package/ })
  const key = card.getAttribute('data-pin-key')!

  // In view: no chip.
  await scrolled()
  expect(screen.queryByRole('button', { name: /need.* you/i })).toBeNull()

  // Scrolled out of view below: "1 needs you ↓", protected.
  cardBoxes[key] = { top: 900, bottom: 1000 }
  await scrolled()
  const chip = await screen.findByRole('button', { name: /1 card needs you, below/ })
  expect(chip.textContent).toBe('1 needs you ↓')
  expect(chip.getAttribute('data-protected')).toBe('inline-flex')

  fireEvent.click(chip)
  expect(scrollIntoView).toHaveBeenCalled()
  expect(document.activeElement).toBe(card)

  // Above the view: the arrow turns round.
  cardBoxes[key] = { top: -300, bottom: -200 }
  await scrolled()
  expect((await screen.findByRole('button', { name: /above/ })).textContent).toBe('1 needs you ↑')

  // Back in view: the chip goes.
  cardBoxes[key] = { top: 50, bottom: 150 }
  await scrolled()
  await waitFor(() => expect(screen.queryByRole('button', { name: /need.* you/i })).toBeNull())
})

test('with two cards out of view the chip counts both and leads to the nearest', async () => {
  stub({ approvals: [approval], fenced: true })
  renderChat()
  const approvalCard = await screen.findByRole('article', { name: /Needs you: May I install/ })
  const fence = await screen.findByRole('article', { name: /Starting work is blocked/ })
  cardBoxes[approvalCard.getAttribute('data-pin-key')!] = { top: -900, bottom: -800 }
  cardBoxes[fence.getAttribute('data-pin-key')!] = { top: 450, bottom: 600 }
  await scrolled()
  const chip = await screen.findByRole('button', { name: /2 cards need you, below/ })
  expect(chip.textContent).toBe('2 need you ↓')
  fireEvent.click(chip)
  expect(document.activeElement).toBe(fence)
})
