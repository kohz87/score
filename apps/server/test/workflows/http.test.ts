import {
  ORCH_ACKNOWLEDGEMENT_TEXT,
  ValidationResultSchema,
  WorkflowDetailSchema,
  WorkflowExportSchema,
  WorkflowListSchema,
  WorkflowPreflightSchema,
  WorkflowRunCreatedSchema,
  WorkflowRunEventsSchema,
  WorkflowRunListSchema,
  WorkflowRunSnapshotSchema,
  WorkflowVersionSchema,
  type WorkflowDefinition,
} from '@score/contract'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import {
  agent,
  definition,
  edge,
  end,
  gate,
  incarnationOf,
  wfHarness,
  type Harness,
} from './wf-harness.ts'

let h: Harness
let app: FastifyInstance
let headers: { 'x-score-client': string; cookie: string }
let eventTypes: string[] = []

beforeEach(async () => {
  h = await wfHarness()
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake', SCORE_HOME: `${h.dir}/home` }),
    logger: false,
    db: h.db,
    ingest: h.ingest,
    port: h.port,
    clock: () => h.scheduler.now(),
    orchestrator: h.orch,
  })
  const paired = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'x-score-client': 'web' },
    payload: { token: app.pairing.createToken() },
  })
  headers = {
    'x-score-client': 'web',
    cookie: paired.headers['set-cookie']!.toString().split(';')[0]!,
  }
  eventTypes = []
  h.ingest.onCommitted((events) => {
    eventTypes.push(...events.map((e) => e.type))
  })
})
afterEach(async () => {
  await app.close()
  await h.close()
})

const get = (url: string) => app.inject({ method: 'GET', url, headers })
const post = (url: string, payload: object = {}, authed = true) =>
  app.inject({
    method: 'POST',
    url,
    headers: authed ? headers : { 'x-score-client': 'web' },
    payload,
  })
const def = (over: Partial<WorkflowDefinition> = {}): WorkflowDefinition => ({
  ...definition([agent('a'), end()], [edge('a', 'done')]),
  ...over,
})

test('definitions: create, list, version, conflict and delete', async () => {
  expect((await post('/api/workflows', { definition: def() }, false)).statusCode).toBe(401)
  const created = await post('/api/workflows', { definition: def() })
  expect(created.statusCode).toBe(201)
  const v1 = WorkflowVersionSchema.parse(created.json())
  expect(v1.version).toBe(1)
  expect(WorkflowListSchema.parse((await get('/api/workflows')).json()).items).toHaveLength(1)
  const next = await post(`/api/workflows/${v1.workflowId}/versions`, {
    baseVersion: 1,
    definition: def({ name: 'Renamed' }),
  })
  expect(next.statusCode).toBe(201)
  // Saving on top of a stale version is a conflict that names the latest.
  const stale = await post(`/api/workflows/${v1.workflowId}/versions`, {
    baseVersion: 1,
    definition: def(),
  })
  expect(stale.statusCode).toBe(409)
  expect(stale.json().error.details.latestVersion).toBe(2)
  const detail = WorkflowDetailSchema.parse((await get(`/api/workflows/${v1.workflowId}`)).json())
  expect(detail.versions.map((v) => v.version)).toEqual([1, 2])
  expect(detail.name).toBe('Renamed')
  expect(
    WorkflowVersionSchema.parse((await get(`/api/workflows/${v1.workflowId}/versions/1`)).json())
      .definition.name,
  ).toBe('Test workflow')
  expect(
    (await app.inject({ method: 'DELETE', url: `/api/workflows/${v1.workflowId}`, headers }))
      .statusCode,
  ).toBe(204)
  expect((await get(`/api/workflows/${v1.workflowId}`)).statusCode).toBe(404)
})

test('an invalid definition is a 422 with every issue, and validate reports without storing', async () => {
  const bad = def({ nodes: [agent('a', { onFailure: 'route' }), end()] })
  const saved = await post('/api/workflows', { definition: bad })
  expect(saved.statusCode).toBe(422)
  expect(saved.json().error.code).toBe('invalid_definition')
  const result = ValidationResultSchema.parse(
    (await post('/api/workflows/validate', { definition: bad }, false)).json(),
  )
  expect(result.ok).toBe(false)
  expect(result.issues.map((i) => i.code)).toContain('unrouted_failure')
  expect(WorkflowListSchema.parse((await get('/api/workflows')).json()).items).toHaveLength(0)
})

test('the library is bounded: the 201st definition is refused', async () => {
  for (let i = 0; i < 200; i++)
    h.db.sqlite
      .prepare(
        "INSERT INTO workflow_definitions (id, name, created_at, updated_at) VALUES (?, 'x', 'a', 'a')",
      )
      .run(`wf-fill${i}`)
  const refused = await post('/api/workflows', { definition: def() })
  expect(refused.statusCode).toBe(409)
  expect(refused.json().error.code).toBe('quota_exhausted')
})

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

// ------------------------------------------------------------------------------------------------------- export

test('export scrubs every free-text field, lists the complete diff, lets paths be removed and revalidates', async () => {
  const secret = 'sk-abcdefghijklmnopqrstuvwx'
  const withSecrets: WorkflowDefinition = {
    name: `Release ${secret}`,
    description: `uses ${secret}`,
    inputs: [{ name: 't', label: `Topic ${secret}`, required: false, maxChars: 20 }],
    nodes: [
      agent('a', { label: `A ${secret}`, instruction: `Use the key ${secret} to write` }),
      gate('g', { label: 'G', question: `Is ${secret} fine?`, onReject: 'stop_run' }),
      end(),
    ],
    edges: [edge('a', 'g'), edge('g', 'done')],
  }
  const v = WorkflowVersionSchema.parse(
    (await post('/api/workflows', { definition: withSecrets })).json(),
  )
  const exported = WorkflowExportSchema.parse(
    (await post(`/api/workflows/${v.workflowId}/versions/1/export`, {})).json(),
  )
  expect(JSON.stringify(exported.portable)).not.toContain(secret)
  expect(exported.changes.map((c) => c.path).sort()).toEqual(
    [
      'description',
      'inputs[0].label',
      'name',
      'nodes[0].instruction',
      'nodes[0].label',
      'nodes[1].question',
    ].sort(),
  )
  for (const change of exported.changes) {
    expect(change.before).toContain(secret)
    expect(change.after).not.toContain(secret)
  }
  expect(exported.validation.ok).toBe(true)
  // Agents travel as descriptors, never as internal ids.
  const exportedAgent = exported.portable.nodes[0]!
  expect('agent' in exportedAgent && exportedAgent.agent.name).toBeTruthy()
  expect('agentId' in exportedAgent).toBe(false)
  const removed = WorkflowExportSchema.parse(
    (
      await post(`/api/workflows/${v.workflowId}/versions/1/export`, {
        removePaths: ['nodes[0].instruction'],
      })
    ).json(),
  )
  const node0 = removed.portable.nodes[0]!
  expect('instruction' in node0 && node0.instruction).toBe('[removed]')
  expect(removed.changes.find((c) => c.path === 'nodes[0].instruction')!.after).toBe('[removed]')
})
