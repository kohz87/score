import {
  ORCH_ACKNOWLEDGEMENT_TEXT,
  WorkflowDetailSchema,
  WorkflowRunCreatedSchema,
  WorkflowRunListSchema,
  WorkflowVersionSchema,
} from '@score/contract'
import { expect, test } from 'vitest'
import { agent, definition, edge, end, gate, incarnationOf } from './wf-harness.ts'
import { def, eventTypes, get, h, post, setupWorkflowHttp } from './http-helpers.ts'

setupWorkflowHttp()

test('delete with runs asks for the name, refuses while a run goes, then removes the runs and their rooms', async () => {
  const gated = WorkflowVersionSchema.parse(
    (
      await post('/api/workflows', {
        definition: definition([gate('g'), agent('a'), end()], [edge('g', 'a'), edge('a', 'done')]),
      })
    ).json(),
  )
  const runBody = (workflowId: string) => ({
    workflowId,
    version: 1,
    inputs: {},
    agentMap: [{ agentId: 'builder', incarnation: incarnationOf(h, 'builder') }],
    acknowledgement: { text: ORCH_ACKNOWLEDGEMENT_TEXT },
  })
  const running = WorkflowRunCreatedSchema.parse(
    (await post('/api/workflow-runs', runBody(gated.workflowId))).json(),
  )
  const url = `/api/workflows/${gated.workflowId}/delete-with-runs`
  const name = WorkflowDetailSchema.parse(
    (await get(`/api/workflows/${gated.workflowId}`)).json(),
  ).name
  expect((await post(url, { confirm: 'wrong' })).statusCode).toBe(400)
  const refused = await post(url, { confirm: name })
  expect(refused.statusCode).toBe(409)
  expect(refused.json().error.code).toBe('run_active')

  const done = WorkflowVersionSchema.parse(
    (await post('/api/workflows', { definition: def() })).json(),
  )
  const finished = WorkflowRunCreatedSchema.parse(
    (await post('/api/workflow-runs', runBody(done.workflowId))).json(),
  )
  await h.until(() => h.orch.workflowSummary(finished.run.id).status === 'succeeded')
  const doneName = WorkflowDetailSchema.parse(
    (await get(`/api/workflows/${done.workflowId}`)).json(),
  ).name
  const removed = await post(`/api/workflows/${done.workflowId}/delete-with-runs`, {
    confirm: doneName,
  })
  expect(removed.statusCode).toBe(200)
  expect(removed.json()).toEqual({ deletedRuns: 1 })
  expect(eventTypes).toContain('room.deleted')
  expect((await get(`/api/workflows/${done.workflowId}`)).statusCode).toBe(404)
  const runs = WorkflowRunListSchema.parse((await get('/api/workflow-runs')).json())
  expect(runs.items.map((run) => run.id)).toEqual([running.run.id])
})

test('delete with runs refuses, and deletes nothing, for a draining run and for a busy run room', async () => {
  const mk = async () => {
    const v = WorkflowVersionSchema.parse(
      (await post('/api/workflows', { definition: def() })).json(),
    )
    const created = WorkflowRunCreatedSchema.parse(
      (
        await post('/api/workflow-runs', {
          workflowId: v.workflowId,
          version: 1,
          inputs: {},
          agentMap: [{ agentId: 'builder', incarnation: incarnationOf(h, 'builder') }],
          acknowledgement: { text: ORCH_ACKNOWLEDGEMENT_TEXT },
        })
      ).json(),
    )
    await h.until(() => h.orch.workflowSummary(created.run.id).status === 'succeeded')
    const detail = WorkflowDetailSchema.parse((await get(`/api/workflows/${v.workflowId}`)).json())
    return { id: v.workflowId, name: detail.name, run: created.run.id }
  }
  const expectRefused = async (r: { id: string; name: string; run: string }) => {
    const res = await post(`/api/workflows/${r.id}/delete-with-runs`, { confirm: r.name })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('run_active')
    expect((await get(`/api/workflows/${r.id}`)).statusCode).toBe(200)
    expect(
      WorkflowRunListSchema.parse((await get('/api/workflow-runs')).json()).items.map((x) => x.id),
    ).toContain(r.run)
  }

  // Draining: terminal, but a requested stop was never acknowledged.
  const draining = await mk()
  h.db.sqlite
    .prepare(
      `UPDATE orc_attempts SET state = 'running', stop_requested_at = ?, stop_acknowledged_at = NULL
       WHERE orchestration_id = ?`,
    )
    .run(new Date().toISOString(), draining.run)
  await expectRefused(draining)

  // Busy: an agent turn is pending in the run's room.
  const busy = await mk()
  const roomId = (
    h.db.sqlite.prepare('SELECT room_id AS r FROM orchestrations WHERE id = ?').get(busy.run) as {
      r: string
    }
  ).r
  const messageId = (
    h.db.sqlite.prepare('SELECT id FROM messages WHERE room_id = ? LIMIT 1').get(roomId) as {
      id: string
    }
  ).id
  h.db.sqlite
    .prepare(
      `INSERT INTO message_runs (message_id, room_id, agent_id, chain_id, hop, turn_id, parent_message_id, input, agents, state, created_at)
       VALUES (?1, ?2, 'builder', ?1, 0, 'turn-busy', ?1, 'go', '[]', 'pending', 'x')`,
    )
    .run(messageId, roomId)
  await expectRefused(busy)
})
