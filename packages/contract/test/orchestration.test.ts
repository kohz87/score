import { describe, expect, test } from 'vitest'
import {
  ORCH_ACKNOWLEDGEMENT_TEXT,
  ORC_CAPABILITY_PATTERN,
  ORC_CAPABILITY_PLACEHOLDER,
  LimitsDecisionSchema,
  NeedsYouSchema,
  OrchAssignArgsSchema,
  QuotaDecisionSchema,
  OrchestrationCreateSchema,
  OrchestrationEventsSchema,
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

  test('event history entries need a stable id and a time', () => {
    const event = {
      id: 'cmd:a1:c1',
      at: '2026-10-10T10:00:00.000Z',
      kind: 'command',
      stepId: 's1',
      attemptId: 'a1',
      tool: 'orch.assign',
      verdict: 'accepted',
      code: null,
      summary: 'Assigned s1',
    }
    expect(OrchestrationEventsSchema.parse({ asOfSeq: 3, events: [event] }).events).toHaveLength(1)
    expect(() =>
      OrchestrationEventsSchema.parse({ asOfSeq: 3, events: [{ ...event, kind: 'nope' }] }),
    ).toThrow()
  })

  test('the quota guard: floor 0–50, the held-step item, its answers and ifQuotaLow', () => {
    expect(
      OrchestrationCreateSchema.parse({ ...create, quotaFloorPercent: 0 }).quotaFloorPercent,
    ).toBe(0)
    expect(() => OrchestrationCreateSchema.parse({ ...create, quotaFloorPercent: 51 })).toThrow()
    expect(() => OrchestrationCreateSchema.parse({ ...create, quotaFloorPercent: 2.5 })).toThrow()
    expect(
      LimitsDecisionSchema.parse({ quotaFloorPercent: null, orchestrationRevision: 1 }),
    ).toBeTruthy()
    expect(() => LimitsDecisionSchema.parse({ orchestrationRevision: 1 })).toThrow()
    for (const answer of ['use_anyway', 'wait', 'stop'])
      expect(QuotaDecisionSchema.parse({ answer, orchestrationRevision: 2 }).answer).toBe(answer)
    expect(() => QuotaDecisionSchema.parse({ answer: 'ok', orchestrationRevision: 2 })).toThrow()
    expect(
      NeedsYouSchema.parse({
        kind: 'quota_low',
        stepId: 's3',
        agentId: 'builder',
        window: '5 hours',
        group: null,
        leftPercent: 6,
        resetsAt: '2026-10-17T13:40:00.000Z',
      }).kind,
    ).toBe('quota_low')
    const args = { capability, commandId: 'c1', agent: 'builder', instruction: 'Do it' }
    expect(OrchAssignArgsSchema.parse({ ...args, ifQuotaLow: 'ask_owner' }).ifQuotaLow).toBe(
      'ask_owner',
    )
    expect(() => OrchAssignArgsSchema.parse({ ...args, ifQuotaLow: 'always' })).toThrow()
  })
})
