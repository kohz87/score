import { expect, test } from 'vitest'
import { ApiError } from '../data/api.ts'
import { PAIR_BROWSER, pairingProblem } from './bold-errors.ts'

test('every bold surface words a pairing problem the same way', () => {
  expect(pairingProblem(new ApiError(401, 'not_paired', 'Pair first'))).toBe(PAIR_BROWSER)
  expect(pairingProblem(new ApiError(403, 'forbidden', 'Pair first'))).toBe(PAIR_BROWSER)
  expect(pairingProblem(new ApiError(400, 'not_paired', 'Pair first'))).toBe(PAIR_BROWSER)
  expect(pairingProblem(new ApiError(409, 'conflict', 'Someone answered first'))).toBeNull()
  expect(pairingProblem(new Error('network'))).toBeNull()
})
