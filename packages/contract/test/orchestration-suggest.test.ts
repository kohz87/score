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
