import { screen, within } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import {
  directRoom,
  renderDirect,
  resetDirectChatTest,
  stub as stubDirectChat,
} from './DirectChat-test-helpers.tsx'

let questionItems: unknown[] = []

function stub() {
  return stubDirectChat(undefined, undefined, undefined, () => questionItems)
}

afterEach(() => {
  questionItems = []
  resetDirectChatTest()
})

test('an open question is a card above the conversation and an ended one a muted line where it was asked', async () => {
  const asked = {
    id: 'q-1',
    agentId: 'builder',
    runId: 'run-1',
    roomId: directRoom.id,
    jobId: 'chat-new',
    question: 'Which port?',
    options: ['8080', '9090'],
    multiSelect: false,
    status: 'pending',
    answer: null,
    answeredBy: null,
    delivery: 'none',
    createdAt: '2026-10-24T11:13:30.000Z',
    expiresAt: null,
    answeredAt: null,
  }
  questionItems = [
    asked,
    {
      ...asked,
      id: 'q-0',
      question: 'Keep the cursor?',
      status: 'answered',
      answer: 'Yes',
      answeredBy: 'you',
      delivery: 'applied',
      createdAt: '2026-10-24T11:12:30.000Z',
    },
  ]
  stub()
  renderDirect()
  const card = await screen.findByRole('region', { name: 'builder asks' })
  expect(card.getAttribute('data-protected')).toBe('flex')
  expect(within(card).getByRole('button', { name: '9090' })).toBeTruthy()
  const note = await screen.findByText(/builder asked: Keep the cursor\?/)
  expect(note.textContent).toContain('you answered: Yes')
})
