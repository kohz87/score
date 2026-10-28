// 3.15 (decision 151): the advisor on call to the workers. A Claude Code worker that edits gets the advisor (a Claude Code
// agent) as a subagent it asks itself; its consults are counted from the worker's tool calls.
import { afterEach, expect, test } from 'vitest'
import { agentAdvisorModel, onCallConsults } from '../../src/domain/orchestration/advisor.ts'
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

test('3.14.1: a worker with its own advisor (a Claude Code agent setting) is reminded when to ask it', async () => {
  h = await harness({
    lead: {
      script: byTurn({ 1: async (t) => void (await t.call('orch.plan', { entries: ['x'] })) }),
    },
  })
  const id = await h.create()
  await h.settle()
  coding('coder', 'workspace-write', 'sonnet')
  expect(agentAdvisorModel(h.db.sqlite, 'coder')).toBeNull()
  h.db.sqlite.prepare("UPDATE coding_agents SET advisor_model = 'opus' WHERE id = 'coder'").run()
  expect(agentAdvisorModel(h.db.sqlite, 'coder')).toBe('opus')
  // A Hermes agent has no such setting.
  expect(agentAdvisorModel(h.db.sqlite, 'builder')).toBeNull()
  const input = renderStepInput({
    o: { id },
    step: { id: 's9', instruction: 'do it', after_steps: [], role: null } as never,
    dependencies: [],
    advisorOnCall: true,
  })
  expect(input).toContain('An advisor (a stronger model) is on call through your advisor tool')
})

test('the workers’ consults are read from their Claude Code advisor calls (tool advisor)', async () => {
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
  const call = (seq: number, tool: string, status: string) =>
    h.db.sqlite
      .prepare(
        `INSERT INTO tool_calls (run_id, seq, tool, status, started_at, call_id) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, seq, tool, status, `2026-01-01T00:00:0${seq}.000Z`, `c${seq}`)
  call(1, 'advisor', 'ok')
  call(2, 'Read', 'ok')
  call(3, 'advisor', 'running')
  expect(onCallConsults(h.db.sqlite, id)).toEqual([
    {
      stepId: 's1',
      agentId: 'builder',
      at: '2026-01-01T00:00:01.000Z',
      question: '',
      status: 'done',
      totalTokens: null,
    },
    {
      stepId: 's1',
      agentId: 'builder',
      at: '2026-01-01T00:00:03.000Z',
      question: '',
      status: 'running',
      totalTokens: null,
    },
  ])
  expect(h.orch.snapshot(id).orchestration.advisor).toMatchObject({
    mode: 'on_call',
    onCall: [{ stepId: 's1' }, { stepId: 's1', status: 'running' }],
  })
  // Not confirmed ended (unknown): it may still be running, so the consult stays live.
  h.db.sqlite
    .prepare(
      "UPDATE orc_attempts SET state = 'unknown' WHERE orchestration_id = ? AND step_id = 's1'",
    )
    .run(id)
  expect(onCallConsults(h.db.sqlite, id).map((c) => c.status)).toEqual(['done', 'running'])
  // A consult cut off with its run never shows as live once the run is over.
  h.db.sqlite
    .prepare(
      "UPDATE orc_attempts SET state = 'terminated' WHERE orchestration_id = ? AND step_id = 's1'",
    )
    .run(id)
  expect(onCallConsults(h.db.sqlite, id).map((c) => c.status)).toEqual(['done', 'failed'])
})
