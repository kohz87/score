import { describe, expect, test } from 'vitest'
import {
  ORCH_ACKNOWLEDGEMENT_TEXT,
  ORC_CAPABILITY_PATTERN,
  ORC_CAPABILITY_PLACEHOLDER,
  OrchAssignArgsSchema,
  OrchestrationCreateSchema,
  OrchestrationSummarySchema,
} from '../src/index.ts'
import * as f from './fixtures.ts'

const capability = `orc_${'a'.repeat(43)}`
const create = {
  goal: 'Write the release notes',
  leadAgentId: 'lead',
  allowedAgents: ['builder'],
  acknowledgement: { text: ORCH_ACKNOWLEDGEMENT_TEXT },
}

describe('orchestration contract', () => {
  test('fills defaults and requires the exact acknowledgement', () => {
    const parsed = OrchestrationCreateSchema.parse(create)
    expect(parsed.gatePolicy).toBe('every-step')
    expect(parsed.maxConcurrentSteps).toBe(2)
    expect(() =>
      OrchestrationCreateSchema.parse({ ...create, acknowledgement: { text: 'ok' } }),
    ).toThrow()
  })

  test('bounds goals, steps and concurrency', () => {
    expect(() => OrchestrationCreateSchema.parse({ ...create, goal: 'x'.repeat(8193) })).toThrow()
    expect(() => OrchestrationCreateSchema.parse({ ...create, maxSteps: 31 })).toThrow()
    expect(() => OrchestrationCreateSchema.parse({ ...create, maxConcurrentSteps: 4 })).toThrow()
    expect(() => OrchestrationCreateSchema.parse({ ...create, extra: 1 })).toThrow()
  })

  test('capability pattern accepts only orc_ tokens and differs from scm_', () => {
    expect(ORC_CAPABILITY_PATTERN.test(capability)).toBe(true)
    expect(ORC_CAPABILITY_PATTERN.test(`scm_${'a'.repeat(43)}`)).toBe(false)
    expect(ORC_CAPABILITY_PLACEHOLDER).not.toMatch(ORC_CAPABILITY_PATTERN)
  })

  test('tool arguments need a capability and a bounded command id', () => {
    const ok = { capability, commandId: 'c-1', agent: 'builder', instruction: 'Do it' }
    expect(OrchAssignArgsSchema.parse(ok).agent).toBe('builder')
    expect(() => OrchAssignArgsSchema.parse({ ...ok, commandId: 'x'.repeat(65) })).toThrow()
    expect(() => OrchAssignArgsSchema.parse({ ...ok, commandId: 'has space' })).toThrow()
    expect(() => OrchAssignArgsSchema.parse({ ...ok, capability: 'orc_short' })).toThrow()
    expect(() =>
      OrchAssignArgsSchema.parse({ ...ok, instruction: 'x'.repeat(8 * 1024 + 1) }),
    ).toThrow()
  })

  test('summary round-trips', () => {
    expect(OrchestrationSummarySchema.parse(f.orchestrationSummary)).toEqual(f.orchestrationSummary)
  })
})
