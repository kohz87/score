// 3.15 (decision 151): the advisor on call to the workers. A Claude Code worker that edits gets the advisor (a Claude Code
// agent) as a subagent it asks itself; its consults are counted from the worker's tool calls.
import { afterEach, expect, test } from 'vitest'
import { onCallAdvisor, onCallConsults } from '../../src/domain/orchestration/advisor.ts'
import { renderStepInput } from '../../src/domain/orchestration/render.ts'
import { insertCodingAgent } from '../../src/runtimes/coding/store.ts'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { harness, type Harness } from './harness.ts'

let h: Harness
afterEach(async () => {
  await h?.close()
  h = undefined as never
})

function coding(
  id: string,
  permission: 'read-only' | 'workspace-write' | 'full',
  model: string | null,
) {
  insertCodingAgent(h.db.sqlite, {
    id,
    name: id,
    role: '',
    runtime: 'claude-code',
    workspace: '/tmp/ws',
    permission,
    model,
    style: { color: '#19C39A', shape: 'hexagon' },
    createdAt: new Date().toISOString(),
  } as never)
}

test('who gets the advisor on call, and the note in their step', async () => {
  h = await harness({
    lead: {
      script: byTurn({ 1: async (t) => void (await t.call('orch.plan', { entries: ['x'] })) }),
    },
  })
  const id = await h.create({ advisorAgentId: 'reviewer' })
  await h.settle()
  const step = (agentId: string, stepId: string, role: string | null = null) =>
    h.db.sqlite
      .prepare(
        `INSERT INTO orc_steps (orchestration_id, id, seq, agent_id, agent_incarnation, instruction, after_steps, status, estimate_usd, created_in_attempt, created_at, updated_at, role)
         VALUES (?, ?, 1, ?, 'x', 'do it', '[]', 'queued', 0.5, 'a', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?)`,
      )
      .run(id, stepId, agentId, role)
  coding('coder', 'workspace-write', 'sonnet')
  coding('reader', 'read-only', 'haiku')
  step('coder', 's9')
  step('reader', 's8')
  step('coder', 'h9', 'helper')
  // A Hermes advisor can't be a Claude subagent.
  expect(onCallAdvisor(h.db.sqlite, id, 's9')).toBeNull()
  coding('reviewer', 'read-only', 'opus')
  expect(onCallAdvisor(h.db.sqlite, id, 's9')).toEqual({ advisorId: 'reviewer', model: 'opus' })
  // Not for a read-only worker, nor for helper work.
  expect(onCallAdvisor(h.db.sqlite, id, 's8')).toBeNull()
  expect(onCallAdvisor(h.db.sqlite, id, 'h9')).toBeNull()
  // Checkpoints only: no subagent.
  h.db.sqlite.prepare("UPDATE orchestrations SET advisor_mode = 'checkpoints' WHERE id = ?").run(id)
  expect(onCallAdvisor(h.db.sqlite, id, 's9')).toBeNull()
  const row = h.rows<Record<string, unknown>>('SELECT * FROM orc_steps WHERE id = ?', 's9')[0]!
  const input = renderStepInput({
    o: { id },
    step: { ...(row as object), after_steps: [] } as never,
    dependencies: [],
    advisorOnCall: true,
  })
  expect(input).toContain('An advisor (a stronger model) is on call as the subagent "advisor"')
})

test('the workers’ consults are read from their advisor subagent calls', async () => {
  h = await harness({
    lead: {
      // The advisor reads the plan first (assign waits for it), so the step is assigned on the second turn.
      script: byTurn({
        1: async (t) =>
          void (await t.call('orch.assign', { agent: 'builder', instruction: 'x [fake:hold]' })),
        2: async (t) =>
          void (await t.call('orch.assign', { agent: 'builder', instruction: 'x [fake:hold]' })),
      }),
    },
  })
  const id = await h.create({ gatePolicy: 'none', advisorAgentId: 'reviewer' })
  await h.until(() =>
    h.orch.snapshot(id).orchestration.attempts.some((a) => a.stepId === 's1' && a.runId),
  )
  const runId = h.orch.snapshot(id).orchestration.attempts.find((a) => a.stepId === 's1')!.runId!
  const call = (seq: number, sub: object) =>
    h.db.sqlite
      .prepare(
        `INSERT INTO tool_calls (run_id, seq, tool, status, started_at, call_id, subagent) VALUES (?, ?, 'Agent', 'ok', ?, ?, ?)`,
      )
      .run(runId, seq, `2026-01-01T00:00:0${seq}.000Z`, `c${seq}`, JSON.stringify(sub))
  call(1, {
    status: 'done',
    subagentType: 'advisor',
    description: 'Is rules.ts:41 safe to change?',
    totalTokens: 9200,
  })
  call(2, {
    status: 'done',
    subagentType: 'general-purpose',
    description: 'search',
    totalTokens: 100,
  })
  expect(onCallConsults(h.db.sqlite, id)).toEqual([
    {
      stepId: 's1',
      agentId: 'builder',
      at: '2026-01-01T00:00:01.000Z',
      question: 'Is rules.ts:41 safe to change?',
      status: 'done',
      totalTokens: 9200,
    },
  ])
  expect(h.orch.snapshot(id).orchestration.advisor).toMatchObject({
    mode: 'on_call',
    onCall: [{ stepId: 's1' }],
  })
})
