import type { OutsideSession } from '@score/contract'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { BoldElsewhere } from './BoldElsewhere.tsx'
import {
  agents,
  disposeRoomTest,
  jsonResponse,
  makeJob,
  mockFetch,
  renderInRoom,
  room,
} from './room-test-utils.tsx'

const session: OutsideSession = {
  id: 'ext-telegram-1',
  agentId: 'lead',
  source: 'telegram',
  sourceLabel: 'Telegram',
  title: 'Plan the launch checklist',
  startedAt: '2026-10-23T08:00:00.000Z',
  messageCount: 4,
  busy: false,
  roomId: null,
}

afterEach(() => {
  disposeRoomTest()
  vi.unstubAllGlobals()
})

test('previews the imported chat read-only, then brings it into a new team job with the text attached', async () => {
  const job = makeJob({ id: 'job-launch', title: 'Plan the launch checklist' })
  const fetchMock = mockFetch((url, init) => {
    const parsed = new URL(url, 'http://x')
    if (parsed.pathname === '/api/team-room') return jsonResponse({ asOfSeq: 1, room, jobs: [] })
    if (parsed.pathname === '/api/outside-sessions/import')
      return jsonResponse({ roomId: 'room-imported', imported: 1 })
    if (parsed.pathname === '/api/rooms/room-imported/messages')
      return jsonResponse({
        asOfSeq: 1,
        items: [
          {
            id: 'import:1',
            roomId: 'room-imported',
            jobId: 'job-imported',
            author: { kind: 'agent', agentId: 'lead' },
            to: [],
            parts: [{ kind: 'text', text: 'Outline the launch checklist.' }],
            createdAt: '2026-10-23T08:00:00.000Z',
            streaming: false,
            refs: [],
          },
        ],
        nextCursor: null,
        jobId: 'job-imported',
      })
    if (parsed.pathname === '/api/rooms/room-1/jobs' && init.method === 'POST')
      return jsonResponse(job)
    if (parsed.pathname === '/api/messages/import%3A1/share' && init.method === 'POST')
      return jsonResponse({ messageId: 'shared-1' }, 201)
    return jsonResponse({ asOfSeq: 1, items: [] })
  })
  vi.stubGlobal('fetch', fetchMock)
  const brought = vi.fn()
  renderInRoom(<BoldElsewhere session={session} agents={agents} onBroughtIn={brought} />, ['/b'])

  expect(screen.getByText(/From Telegram · read-only/)).toBeDefined()
  expect(screen.getByText('Plan the launch checklist')).toBeDefined()
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.queryByRole('combobox')).toBeNull()
  const note = screen.getByText(/From Telegram · read-only/)
  expect(note.getAttribute('data-protected')).toBe('any')

  fireEvent.click(screen.getByRole('button', { name: 'Preview this chat' }))
  expect(await screen.findByText('Outline the launch checklist.')).toBeDefined()
  expect(screen.getByText(/Read-only preview · imported from Telegram/)).toBeDefined()
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.queryByRole('combobox')).toBeNull()

  const bring = screen.getByRole('button', { name: 'Bring into a job' })
  await waitFor(() => expect(bring.hasAttribute('disabled')).toBe(false))
  fireEvent.click(bring)
  await waitFor(() => expect(brought).toHaveBeenCalledWith('job-launch'))
  const imported = fetchMock.mock.calls.filter(
    ([url]) => String(url) === '/api/outside-sessions/import',
  )
  expect(imported).toHaveLength(1)
  expect(JSON.parse(String(imported[0]?.[1]?.body))).toEqual({
    agentId: 'lead',
    sessionId: 'ext-telegram-1',
  })
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/messages/import%3A1/share',
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ jobId: 'job-launch' }) }),
  )
})
