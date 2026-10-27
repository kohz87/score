import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { UnknownCard } from './RunDecisions.tsx'

// 3.7.12 (owner pasted the card): a turn the person stopped and Hermes cancelled says so in plain words, and the card
// says what "Stop waiting for this" does.

afterEach(() => cleanup())

const attempt = (overrides: Record<string, unknown>) => ({
  id: 'a1',
  stepId: null,
  unknownReason: 'run_cancelled',
  stopRequestedAt: '2026-10-27T04:49:49.101Z',
  ...overrides,
})
function show(overrides: Record<string, unknown> = {}) {
  const abandon = { mutate: vi.fn(), isPending: false, error: null }
  render(
    <QueryClientProvider client={new QueryClient()}>
      <UnknownCard
        run={{ revision: 7, attempts: [attempt(overrides)] } as never}
        attemptId="a1"
        actions={{ abandon, waiver: { mutate: vi.fn(), isPending: false, error: null } } as never}
      />
    </QueryClientProvider>,
  )
  return abandon
}

test('a stopped turn Hermes cancelled says so, and Stop waiting needs the checkbox', () => {
  const abandon = show()
  const card = screen.getByRole('region', { name: 'Not confirmed as ended' })
  expect(card.textContent).toContain('Hermes cancelled the run after it was stopped')
  expect(card.textContent).toContain('A running job then pauses for you to decide')
  const button = screen.getByRole('button', { name: 'Stop waiting for this' })
  expect(button.hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(button)
  expect(abandon.mutate).toHaveBeenCalledWith({
    attemptIds: ['a1'],
    orchestrationRevision: 7,
    acknowledge: true,
  })
})

test('other reasons read as plain words', () => {
  show({ unknownReason: 'crash_after_send_started', stopRequestedAt: null })
  expect(screen.getByRole('region', { name: 'Not confirmed as ended' }).textContent).toContain(
    'Score restarted while sending it',
  )
})
