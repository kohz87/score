import { expect, test } from 'vitest'
import { currentExchange } from './thread-model.ts'
import { makeExchange } from './room-test-utils.tsx'

test('the current exchange is the latest one still working, not a finished older row', () => {
  const done = makeExchange({
    id: 'done',
    state: 'done',
    pause: null,
    createdAt: '2026-10-24T10:00:00.000Z',
  })
  const live = makeExchange({
    id: 'live',
    state: 'live',
    pause: null,
    createdAt: '2026-10-24T10:01:00.000Z',
  })
  const stopped = makeExchange({
    id: 'stopped',
    state: 'stopped',
    pause: null,
    createdAt: '2026-10-24T10:02:00.000Z',
  })
  expect(currentExchange([done])).toBe(done)
  expect(currentExchange([done, live, stopped])).toBe(live)
})

test('the one exchange is the one that needs you, else the latest live one', () => {
  const live = makeExchange({ id: 'live', state: 'live', pause: null })
  const waiting = makeExchange({ id: 'waiting' })
  expect(currentExchange([waiting, live])?.id).toBe('waiting')
  expect(currentExchange([live, waiting])?.id).toBe('waiting')
})
