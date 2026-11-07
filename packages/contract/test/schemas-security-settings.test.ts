import { describe, expect, test } from 'vitest'
import * as contract from '../src/index.ts'
import { securitySettingsCases } from './schemas-cases-security-settings.ts'

describe.each(securitySettingsCases)('%s', (name, valid, invalid) => {
  const schema = contract[name]
  test('round-trips a valid JSON fixture', () => {
    expect(schema.parse(JSON.parse(JSON.stringify(valid)))).toEqual(valid)
  })
  test('rejects an invalid fixture', () => {
    expect(schema.safeParse(invalid).success).toBe(false)
  })
})

test('messaging setup requests accept one-line values for env keys only', () => {
  const ok = contract.MessagingSetupRequestSchema.safeParse({
    values: { SLACK_BOT_TOKEN: 'xoxb-1' },
  })
  expect(ok.success).toBe(true)
  for (const values of [{ lower: 'x' }, { SLACK_BOT_TOKEN: 'a\nb' }, { SLACK_BOT_TOKEN: '-x' }])
    expect(contract.MessagingSetupRequestSchema.safeParse({ values }).success).toBe(false)
  expect(contract.MessagingSetupRequestSchema.safeParse({ values: {}, extra: 1 }).success).toBe(
    false,
  )
})
