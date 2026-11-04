import { expect, test } from 'vitest'
import { stepOf } from './RunCard.tsx'

test('a bounded run counts against its total', () => {
  expect(stepOf('running', 1, 4)).toBe('step 2 of 4')
  expect(stepOf('succeeded', 4, 4)).toBeNull()
})

test('3.27.0: a run with no step cap says "until you stop it" while it goes on, and nothing once it is over', () => {
  expect(stepOf('running', 1, 4, true)).toBe('until you stop it')
  expect(stepOf('running', 0, 0, true)).toBe('until you stop it')
  expect(stepOf('stopped', 1, 4, true)).toBeNull()
})
