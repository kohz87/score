import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { createQueryClient } from '../../data/query-client.ts'
import { FenceScreen } from './FenceScreen.tsx'

afterEach(cleanup)

const fence = (items: { kind: 'journal'; ref: string; detail: string }[]) => ({
  fenced: true,
  reason: 'execution_frozen',
  untrustedHistory: true,
  revision: 3,
  since: '2026-10-13T00:00:00.000Z',
  items,
  journal: { ok: true, entries: 4, bytes: 100, sizeAlarm: false },
})
const show = (value: ReturnType<typeof fence>) =>
  render(
    <QueryClientProvider client={createQueryClient()}>
      <FenceScreen fence={value} />
    </QueryClientProvider>,
  )

test('FV #1: while Score holds all agent work the screen says why and offers no way to lift it', () => {
  const sentence =
    'Score is holding all agent work: this folder is a copy. Run scripts/score installation reset-history to continue.'
  show(fence([{ kind: 'journal', ref: 'execution-frozen', detail: sentence }]))
  expect(screen.getByRole('status').textContent).toBe(sentence)
  expect(screen.queryByRole('button', { name: /lift/i })).toBeNull()
  expect(screen.queryByRole('checkbox')).toBeNull()
})

test('an ordinary fence keeps its review list and the Lift button', () => {
  show(fence([{ kind: 'journal', ref: 'journal', detail: 'The journal is behind.' }]))
  expect(screen.getByRole('button', { name: /lift the block/i })).toBeTruthy()
})
