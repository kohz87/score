import { describe, expect, test } from 'vitest'
import * as contract from '../src/index.ts'
import { codingCases } from './schemas-cases-coding.ts'

describe.each(codingCases)('%s', (name, valid, invalid) => {
  const schema = contract[name]
  test('round-trips a valid JSON fixture', () => {
    expect(schema.parse(JSON.parse(JSON.stringify(valid)))).toEqual(valid)
  })
  test('rejects an invalid fixture', () => {
    expect(schema.safeParse(invalid).success).toBe(false)
  })
})

// PLAN 8.8: an instructions edit names the text it started from, and the text is bounded.
test('CodingAgentPatchSchema: instructions need their etag and stay within the limit', () => {
  const patch = contract.CodingAgentPatchSchema
  expect(patch.safeParse({ instructions: 'Be bold.', instructionsEtag: 'e1' }).success).toBe(true)
  expect(patch.safeParse({ instructions: 'Be bold.' }).success).toBe(false)
  expect(patch.safeParse({ instructionsEtag: 'e1' }).success).toBe(false)
  expect(patch.safeParse({ role: 'Builder' }).success).toBe(true)
  const text = (length: number) => ({ instructions: 'x'.repeat(length), instructionsEtag: 'e1' })
  expect(patch.safeParse(text(contract.CODING_INSTRUCTIONS_MAX)).success).toBe(true)
  expect(patch.safeParse(text(contract.CODING_INSTRUCTIONS_MAX + 1)).success).toBe(false)
  expect(contract.CODING_INSTRUCTIONS_MAX).toBe(8000)
})
