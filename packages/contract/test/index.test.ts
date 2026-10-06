import { expect, test } from 'vitest'
import { CONTRACT_VERSION } from '../src/index.ts'

test('exports the contract version', () => {
  expect(CONTRACT_VERSION).toBe(0)
})
