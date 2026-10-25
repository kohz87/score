import type { AgentQuestion } from '@score/contract'
import { screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { questionNeedsYou, roomQuestions } from '../../data/question-queries.ts'
import { disposeRoomTest, jsonResponse, mockFetch, renderInRoom } from './room-test-utils.tsx'
import { useRoomNeedsYouState } from './use-needs-you.ts'

afterEach(() => {
  disposeRoomTest()
  vi.unstubAllGlobals()
})

const question: AgentQuestion = {
  id: 'q-1',
  agentId: 'builder',
  runId: 'run-1',
  roomId: 'room-1',
  jobId: null,
  question: 'Which?',
  options: [],
  multiSelect: false,
  status: 'pending',
  answer: null,
  answeredBy: null,
  delivery: 'none',
  createdAt: '2026-10-24T09:03:00.000Z',
  expiresAt: null,
  answeredAt: null,
}

test('pending and delivering questions need you; ended ones do not', () => {
  expect(questionNeedsYou(question)).toBe(true)
  expect(questionNeedsYou({ ...question, status: 'answered', delivery: 'delivering' })).toBe(true)
  expect(questionNeedsYou({ ...question, status: 'answered', delivery: 'applied' })).toBe(false)
  expect(questionNeedsYou({ ...question, status: 'withdrawn' })).toBe(false)
  expect(questionNeedsYou({ ...question, status: 'expired' })).toBe(false)
})

test('a room keeps its own questions; the team room also takes the ones naming no room', () => {
  const none = { ...question, id: 'q-2', roomId: null }
  const other = { ...question, id: 'q-3', roomId: 'room-2' }
  const jobbed = { ...question, id: 'q-4', jobId: 'job-9' }
  const all = [question, none, other, jobbed]
  expect(roomQuestions(all, 'room-1', false, 'all').map((item) => item.id)).toEqual(['q-1', 'q-4'])
  expect(roomQuestions(all, 'room-1', true, 'all').map((item) => item.id)).toEqual([
    'q-1',
    'q-2',
    'q-4',
  ])
  expect(roomQuestions(all, 'room-1', true, 'job-1').map((item) => item.id)).toEqual(['q-1', 'q-2'])
})

function Probe() {
  const state = useRoomNeedsYouState({ roomId: 'room-1', jobs: [], teamRoom: true })
  return <span>{`total:${state.total} questions:${state.questionCount}`}</span>
}

test('the room total counts questions', async () => {
  vi.stubGlobal(
    'fetch',
    mockFetch((url) =>
      url === '/api/questions?status=all'
        ? jsonResponse({
            asOfSeq: 1,
            items: [question, { ...question, id: 'q-2', status: 'expired' }],
          })
        : jsonResponse({ asOfSeq: 0, items: [] }),
    ),
  )
  renderInRoom(<Probe />)
  await screen.findByText('total:1 questions:1')
})
