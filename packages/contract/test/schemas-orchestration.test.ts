import { describe, expect, test } from 'vitest'
import * as contract from '../src/index.ts'
import { orchestrationCases } from './schemas-cases-orchestration.ts'

describe.each(orchestrationCases)('%s', (name, valid, invalid) => {
  const schema = contract[name]
  test('round-trips a valid JSON fixture', () => {
    expect(schema.parse(JSON.parse(JSON.stringify(valid)))).toEqual(valid)
  })
  test('rejects an invalid fixture', () => {
    expect(schema.safeParse(invalid).success).toBe(false)
  })
})
