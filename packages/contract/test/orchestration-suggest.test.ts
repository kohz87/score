import { expect, test } from 'vitest'
import { ORCH_DEFAULTS, ORCH_LIMITS, suggestedCodingSteps } from '../src/index.ts'

test('suggestedCodingSteps adds coding helpers and advisor consults to the default, capped', () => {
  expect(
    suggestedCodingSteps({ codingHelpers: false, helperSteps: 20, codingAdvisor: false }),
  ).toBe(ORCH_DEFAULTS.codingSteps)
  expect(suggestedCodingSteps({ codingHelpers: true, helperSteps: 20, codingAdvisor: true })).toBe(
    ORCH_DEFAULTS.codingSteps + 25,
  )
  expect(suggestedCodingSteps({ codingHelpers: true, helperSteps: 500, codingAdvisor: true })).toBe(
    ORCH_LIMITS.maxCodingSteps,
  )
})

test('3.14.1: advisor choices are strictly above the agent’s model', async () => {
  const { advisorChoicesFor, claudeModelRank } = await import('../src/index.ts')
  expect(advisorChoicesFor('haiku')).toEqual(['sonnet', 'opus', 'fable'])
  expect(advisorChoicesFor('claude-sonnet-5-5')).toEqual(['opus', 'fable'])
  expect(advisorChoicesFor('opus[1m]')).toEqual(['fable'])
  expect(advisorChoicesFor(null)).toEqual(['fable'])
  expect(advisorChoicesFor('fable')).toEqual([])
  expect(advisorChoicesFor('mystery')).toEqual([])
  expect(claudeModelRank('opusplan')).toBe(3)
})
