import { expect, test } from 'vitest'
import { meterFraction, meterText, parseLocalCommand, usageSummary } from './context-meter.ts'

const full = {
  model: 'm',
  tokens: { input: 90_000, output: 10_000 },
  costUsd: 0.5,
  contextLength: 200_000,
}

test('the meter shows tokens, window and cost, and hides when usage is unknown', () => {
  expect(meterText(full)).toBe('100k of 200k tokens · $0.5000')
  expect(meterFraction(full)).toBe(0.5)
  expect(meterText({ ...full, tokens: null })).toBeNull()
  expect(meterText({ ...full, contextLength: null, costUsd: null })).toBe('100k tokens')
  expect(meterFraction({ ...full, contextLength: null })).toBeNull()
})

test('/usage summarises tokens, cost and model', () => {
  expect(usageSummary('Builder', full)).toContain('Input 90,000')
  expect(usageSummary('Builder', { ...full, tokens: null })).toBe(
    'Builder has not reported any usage yet.',
  )
})

test('local commands are only the bare forms; /model with a message goes to the server', () => {
  expect(parseLocalCommand('/compress')).toEqual({ kind: 'compress' })
  expect(parseLocalCommand(' /usage ')).toEqual({ kind: 'usage' })
  expect(parseLocalCommand('/model gpt-6')).toEqual({ kind: 'model', model: 'gpt-6' })
  expect(parseLocalCommand('/model gpt-6 hello there')).toBeNull()
  expect(parseLocalCommand('/compressed')).toBeNull()
  expect(parseLocalCommand('/assign @lead x')).toBeNull()
})
