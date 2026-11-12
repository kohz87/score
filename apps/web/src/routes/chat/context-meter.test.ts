import { expect, test } from 'vitest'
import {
  codingUsageSummary,
  localCommandMenu,
  meterText,
  parseLocalCommand,
  usageSummary,
} from './context-meter.ts'
import { codingQuota, NOW, WEEK_DAY } from '../../bold/quota/quota-test-data.ts'

const full = {
  model: 'm',
  tokens: { input: 90_000, output: 10_000 },
  costUsd: 0.5,
  contextLength: 200_000,
}

test('the meter shows tokens, window and cost, and hides when usage is unknown', () => {
  expect(meterText(full)).toBe('100k of 200k tokens · $0.5000')
  expect(meterText({ ...full, tokens: null })).toBeNull()
  expect(meterText({ ...full, contextLength: null, costUsd: null })).toBe('100k tokens')
})

test('/usage summarises tokens, cost and model', () => {
  expect(usageSummary('Builder', full)).toContain('Input 90,000')
  expect(usageSummary('Builder', { ...full, tokens: null })).toBe(
    'Builder hasn’t reported any usage yet.',
  )
})

test('local commands are only the bare forms; /model with a message goes to the server', () => {
  expect(parseLocalCommand('/compress')).toEqual({ kind: 'compress' })
  expect(parseLocalCommand(' /usage ')).toEqual({ kind: 'usage' })
  expect(parseLocalCommand('/status')).toBeNull()
  expect(parseLocalCommand('/status', true)).toEqual({ kind: 'usage' })
  expect(parseLocalCommand('/model gpt-6')).toEqual({ kind: 'model', model: 'gpt-6' })
  expect(parseLocalCommand('/model gpt-6 hello there')).toBeNull()
  expect(parseLocalCommand('/compressed')).toBeNull()
  expect(parseLocalCommand('/assign @lead x')).toBeNull()
})

test('/usage for a coding agent adds the plan windows and when they were read', () => {
  const plan = { ...full, costUsd: null }
  const text = codingUsageSummary('Builder', plan, codingQuota(), 'claude-code', NOW)
  expect(text).toContain('Builder: 100k of 200k tokens')
  expect(text).not.toContain('$')
  expect(text).toContain('Plan usage, so no dollar cost')
  expect(text).toContain('CLAUDE PLAN QUOTA')
  expect(text).toContain('5 hours 62% left · resets 5:40 am')
  expect(text).toContain(`Week 80% left · resets ${WEEK_DAY}, 5:40 am`)
  expect(text).toContain('Read after the 5:05 am turn.')
})

test('/usage keeps a reported dollar cost and says when the plan reading is missing', () => {
  expect(codingUsageSummary('Builder', full, undefined, 'codex', NOW)).toContain('$0.5000')
  expect(codingUsageSummary('Builder', full, undefined, 'codex', NOW)).toContain(
    'Quota couldn’t be read.',
  )
  expect(codingUsageSummary('Builder', full, null, 'codex', NOW)).toContain(
    'Quota · shows after its first turn.',
  )
})

test('the slash menu offers /status only for a coding agent, with the quota description', () => {
  expect(localCommandMenu(false).map((item) => item.name)).toEqual(['compress', 'usage'])
  expect(localCommandMenu(true).map((item) => item.name)).toEqual(['compress', 'usage', 'status'])
  expect(localCommandMenu(false).find((item) => item.name === 'usage')?.description).toBe(
    'Show tokens and cost for this agent.',
  )
  expect(localCommandMenu(true).find((item) => item.name === 'usage')?.description).toBe(
    'Show tokens, context and plan quota',
  )
  expect(localCommandMenu(true).find((item) => item.name === 'status')?.description).toBe(
    'Show tokens, context and plan quota',
  )
})
