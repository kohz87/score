import { describe, expect, test } from 'vitest'
import * as contract from '../src/index.ts'
import { modelConfigCases } from './schemas-cases-model-config.ts'

describe.each(modelConfigCases)('%s', (name, valid, invalid) => {
  const schema = contract[name]
  test('round-trips a valid JSON fixture', () => {
    expect(schema.parse(JSON.parse(JSON.stringify(valid)))).toEqual(valid)
  })
  test('rejects an invalid fixture', () => {
    expect(schema.safeParse(invalid).success).toBe(false)
  })
})

describe('model settings (audit5-e)', () => {
  const ref = (n: number) => ({ provider: 'openrouter', model: `m/${n}` })
  const chain = Array.from({ length: 11 }, (_, n) => ref(n))
  test('a fallback chain of any length reads and saves', () => {
    expect(contract.ModelSettingsUpdateSchema.safeParse({ fallbacks: chain }).success).toBe(true)
    const settings = {
      fallbacks: chain,
      fallbacksEditable: true,
      aliases: [],
      speech: {
        stt: { provider: null, model: null },
        tts: { provider: null, model: null, voice: null },
      },
    }
    expect(contract.ModelSettingsSchema.safeParse(settings).success).toBe(true)
  })
  test('speech-to-text can be set back to Automatic', () => {
    expect(
      contract.ModelSettingsUpdateSchema.safeParse({ speech: { stt: { provider: null } } }).success,
    ).toBe(true)
  })
})
