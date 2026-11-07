import { describe, expect, test } from 'vitest'
import * as contract from '../src/index.ts'
import * as f from './fixtures.ts'
import { watchStreamCases } from './schemas-cases-watch-stream.ts'

describe.each(watchStreamCases)('%s', (name, valid, invalid) => {
  const schema = contract[name]
  test('round-trips a valid JSON fixture', () => {
    expect(schema.parse(JSON.parse(JSON.stringify(valid)))).toEqual(valid)
  })
  test('rejects an invalid fixture', () => {
    expect(schema.safeParse(invalid).success).toBe(false)
  })
})

test('C1: a Watch frame may carry the Agent call id its sub-agent step ran under', () => {
  const sub = { ...f.watch, parentCallId: 'toolu_agent_1' }
  expect(contract.WatchFrameSchema.parse(sub)).toHaveProperty('parentCallId', 'toolu_agent_1')
  expect(contract.WatchFrameSchema.parse(f.watch)).not.toHaveProperty('parentCallId')
  expect(contract.WatchFrameSchema.safeParse({ ...f.watch, parentCallId: '' }).success).toBe(false)
})
