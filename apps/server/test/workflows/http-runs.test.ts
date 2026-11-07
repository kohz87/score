import {
  ORCH_ACKNOWLEDGEMENT_TEXT,
  WorkflowDetailSchema,
  WorkflowPreflightSchema,
  WorkflowRunCreatedSchema,
  WorkflowRunEventsSchema,
  WorkflowRunListSchema,
  WorkflowRunSnapshotSchema,
  WorkflowVersionSchema,
} from '@score/contract'
import { expect, test } from 'vitest'
import { agent, definition, edge, end, gate, incarnationOf } from './wf-harness.ts'
import { app, def, eventTypes, get, h, headers, post, setupWorkflowHttp } from './http-helpers.ts'

setupWorkflowHttp()

test('a run: preflight, start, snapshot, events, stream, and the §14 routes do not see it', async () => {
  const v = WorkflowVersionSchema.parse(
    (
      await post('/api/workflows', {
        definition: definition([gate('g'), agent('a'), end()], [edge('g', 'a'), edge('a', 'done')]),
      })
    ).json(),
  )
  const pre = WorkflowPreflightSchema.parse(
    (await get(`/api/workflow-runs/preflight?workflowId=${v.workflowId}&version=1`)).json(),
  )
  expect(pre.ok).toBe(true)
  expect(pre.mapping.map((m) => m.agentId)).toEqual(['builder'])
  const body = {
    workflowId: v.workflowId,
    version: 1,
    inputs: {},
    agentMap: [{ agentId: 'builder', incarnation: incarnationOf(h, 'builder') }],
    acknowledgement: { text: ORCH_ACKNOWLEDGEMENT_TEXT },
  }
  expect(
    (await post('/api/workflow-runs', { ...body, acknowledgement: { text: 'ok' } })).statusCode,
  ).toBe(400)
  expect(
    (
      await post('/api/workflow-runs', {
        ...body,
        agentMap: [{ agentId: 'builder', incarnation: 'stale' }],
      })
    ).statusCode,
  ).toBe(409)
  const created = await post('/api/workflow-runs', body)
  expect(created.statusCode).toBe(201)
  const { run } = WorkflowRunCreatedSchema.parse(created.json())
  await h.until(() => h.orch.workflowSummary(run.id).needsYou.some((n) => n.kind === 'gate'))
  const snapshot = WorkflowRunSnapshotSchema.parse(
    (await get(`/api/workflow-runs/${run.id}`)).json(),
  )
  const nodeGate = snapshot.run.nodeGates[0]!
  expect(nodeGate.payload.question).toBe('OK g?')
  expect(
    WorkflowRunListSchema.parse((await get('/api/workflow-runs')).json()).items.map((i) => i.id),
  ).toEqual([run.id])
  // §14 does not list it, serve it, or announce it.
  expect((await get('/api/orchestrations')).json().items).toEqual([])
  expect((await get(`/api/orchestrations/${run.id}`)).statusCode).toBe(404)
  expect(eventTypes).toContain('workflow.run.upserted')
  expect(eventTypes).not.toContain('orchestration.upserted')
  // A stale page is a conflict; the right revisions decide.
  const stale = await post(`/api/workflow-runs/${run.id}/gates/${nodeGate.id}/decision`, {
    decision: 'approve',
    expectedRevision: nodeGate.revision,
    orchestrationRevision: 1,
  })
  expect(stale.statusCode).toBe(409)
  const decided = await post(`/api/workflow-runs/${run.id}/gates/${nodeGate.id}/decision`, {
    decision: 'approve',
    expectedRevision: nodeGate.revision,
    orchestrationRevision: h.orch.workflowSummary(run.id).revision,
  })
  expect(decided.statusCode).toBe(200)
  await h.until(() => h.orch.workflowSummary(run.id).status === 'succeeded')
  const events = WorkflowRunEventsSchema.parse(
    (await get(`/api/workflow-runs/${run.id}/events`)).json(),
  )
  expect(events.events.some((e) => e.kind === 'node_state' && e.nodeId === 'a')).toBe(true)
  expect(events.events.some((e) => e.kind === 'gate_decided')).toBe(true)
  // The brief and room belong to the run while it runs; afterwards they are released.
  expect(h.orch.workflowSummary(run.id).ownership).toBe('released')
})

test('run controls need the paired session; Stop ignores a stale revision', async () => {
  const v = WorkflowVersionSchema.parse(
    (
      await post('/api/workflows', {
        definition: definition(
          [agent('a', { instruction: '[fake:hold] A' }), end()],
          [edge('a', 'done')],
        ),
      })
    ).json(),
  )
  const { run } = WorkflowRunCreatedSchema.parse(
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
  expect(
    (await post(`/api/workflow-runs/${run.id}/pause`, { orchestrationRevision: 1 }, false))
      .statusCode,
  ).toBe(401)
  expect(
    (await post(`/api/workflow-runs/${run.id}/pause`, { orchestrationRevision: 1 })).statusCode,
  ).toBe(409)
  expect(
    (await post(`/api/workflow-runs/${run.id}/stop`, { orchestrationRevision: 1 })).statusCode,
  ).toBe(200)
})

test('workflow runs have their own start validation: missing required inputs are a 422', async () => {
  const v = WorkflowVersionSchema.parse(
    (
      await post('/api/workflows', {
        definition: definition(
          [agent('a', { instruction: 'Write {{inputs.topic}}' }), end()],
          [edge('a', 'done')],
          [{ name: 'topic', label: 'Topic', required: true, maxChars: 5 }],
        ),
      })
    ).json(),
  )
  const base = {
    workflowId: v.workflowId,
    version: 1,
    agentMap: [{ agentId: 'builder', incarnation: incarnationOf(h, 'builder') }],
    acknowledgement: { text: ORCH_ACKNOWLEDGEMENT_TEXT },
  }
  expect((await post('/api/workflow-runs', { ...base, inputs: {} })).json().error.code).toBe(
    'invalid_inputs',
  )
  expect(
    (await post('/api/workflow-runs', { ...base, inputs: { topic: 'too long' } })).json().error
      .code,
  ).toBe('invalid_inputs')
  expect(
    (await post('/api/workflow-runs', { ...base, inputs: { topic: 'ok', extra: 'x' } })).json()
      .error.code,
  ).toBe('invalid_inputs')
})

test('a workflow used by a run cannot be deleted; re-running it creates a new run on the same version', async () => {
  const v = WorkflowVersionSchema.parse(
    (await post('/api/workflows', { definition: def() })).json(),
  )
  const body = {
    workflowId: v.workflowId,
    version: 1,
    inputs: {},
    agentMap: [{ agentId: 'builder', incarnation: incarnationOf(h, 'builder') }],
    acknowledgement: { text: ORCH_ACKNOWLEDGEMENT_TEXT },
  }
  const first = WorkflowRunCreatedSchema.parse((await post('/api/workflow-runs', body)).json())
  await h.until(() => h.orch.workflowSummary(first.run.id).status === 'succeeded')
  const del = await app.inject({ method: 'DELETE', url: `/api/workflows/${v.workflowId}`, headers })
  expect(del.statusCode).toBe(409)
  expect(del.json().error.code).toBe('workflow_used')
  expect(
    WorkflowDetailSchema.parse((await get(`/api/workflows/${v.workflowId}`)).json()).versions[0]!
      .used,
  ).toBe(true)
  const again = WorkflowRunCreatedSchema.parse(
    (await post('/api/workflow-runs', { ...body, rerunOf: first.run.id })).json(),
  )
  expect(again.run.rerunOf).toBe(first.run.id)
  expect(again.run.id).not.toBe(first.run.id)
})
