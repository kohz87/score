import { OrchestrationEventsSchema } from '@score/contract'
import { afterEach, expect, test } from 'vitest'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { harness, type Harness } from './harness.ts'

let h: Harness
afterEach(async () => {
  await h?.close()
})

test('the event history carries per-command verdicts, admissions, results and decisions in causal order', async () => {
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.plan', { entries: ['a'] })
          await t.call('orch.assign', { agent: 'builder', instruction: 'draft it' })
          await t.call('orch.assign', { agent: 'nobody', instruction: 'x' })
          await t.call('orch.note', { text: 'hello' })
        },
        2: async (t) => {
          await t.call('orch.finish', { outcome: 'success', summary: 'done' })
        },
      }),
    },
  })
  const id = await h.create({ gatePolicy: 'every-step' })
  await h.until(() => h.orch.snapshot(id).orchestration.gates.length === 1)
  const gate = h.orch.snapshot(id).orchestration
  await h.orch.gateDecision(id, 'g1', {
    decision: 'approve',
    expectedRevision: 1,
    orchestrationRevision: gate.revision,
  })
  await h.until(() => h.orch.summary(id).status === 'succeeded')
  const { events } = OrchestrationEventsSchema.parse(h.orch.events(id))
  const kinds = events.map((e) => e.kind)
  expect(kinds[0]).toBe('run_started')
  expect(kinds).toContain('lead_wake')
  expect(kinds).toContain('step_admitted')
  expect(kinds).toContain('step_result')
  const refused = events.find((e) => e.kind === 'command' && e.verdict === 'refused')
  expect(refused?.tool).toBe('orch.assign')
  expect(refused?.code).toBe('agent_not_allowed')
  const accepted = events.filter((e) => e.kind === 'command' && e.tool === 'orch.assign')
  expect(accepted.some((e) => e.verdict === 'accepted' && e.stepId === 's1')).toBe(true)
  expect(events.find((e) => e.summary.startsWith('Note: hello'))).toBeDefined()
  // A step is opened by its gate, decided, admitted, then reports back, in that order.
  const at = (kind: string) => events.findIndex((e) => e.kind === kind && e.stepId === 's1')
  expect(at('gate_opened')).toBeLessThan(at('gate_decided'))
  expect(at('gate_decided')).toBeLessThan(at('step_admitted'))
  expect(at('step_admitted')).toBeLessThan(at('step_result'))
  // Ids are stable across reads, so a client can tell which events are new.
  expect(h.orch.events(id).events.map((e) => e.id)).toEqual(events.map((e) => e.id))
  expect(new Set(events.map((e) => e.id)).size).toBe(events.length)
})
