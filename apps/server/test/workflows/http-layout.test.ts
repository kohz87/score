import {
  ORCH_ACKNOWLEDGEMENT_TEXT,
  WorkflowDetailSchema,
  WorkflowExportSchema,
  WorkflowRunCreatedSchema,
  WorkflowRunSnapshotSchema,
  WorkflowVersionSchema,
} from '@score/contract'
import { expect, test } from 'vitest'
import { incarnationOf } from './wf-harness.ts'
import { def, get, h, post, setupWorkflowHttp } from './http-helpers.ts'

setupWorkflowHttp()

test('layout: saved with the version, a layout-only change is a new version, unknown ids are refused, export carries it, a run freezes it', async () => {
  const layout = { nodes: { a: { x: 48, y: 96 }, done: { x: 400, y: 96 } } }
  const flat = def()
  const drawn = def({ layout })
  const created = await post('/api/workflows', { definition: flat })
  const v1 = WorkflowVersionSchema.parse(created.json())
  expect(v1.definition.layout).toBeUndefined()
  // The only change is where the nodes are: it saves a new version with a different hash.
  const moved = WorkflowVersionSchema.parse(
    (
      await post(`/api/workflows/${v1.workflowId}/versions`, { baseVersion: 1, definition: drawn })
    ).json(),
  )
  expect(moved.version).toBe(2)
  expect(moved.hash).not.toBe(v1.hash)
  expect(moved.definition.layout).toEqual(layout)
  const reread = WorkflowVersionSchema.parse(
    (await get(`/api/workflows/${v1.workflowId}/versions/2`)).json(),
  )
  expect(reread.definition.layout).toEqual(layout)
  expect(reread.hash).toBe(moved.hash)
  // A position for something that is not a node cannot be saved.
  const ghost = await post(`/api/workflows/${v1.workflowId}/versions`, {
    baseVersion: 2,
    definition: def({ layout: { nodes: { ghost: { x: 0, y: 0 } } } }),
  })
  expect(ghost.statusCode).toBe(422)
  expect(ghost.json().error.details.result.issues[0].code).toBe('layout_unknown_node')
  // Export keeps the positions.
  const exported = WorkflowExportSchema.parse(
    (await post(`/api/workflows/${v1.workflowId}/versions/2/export`, {})).json(),
  )
  expect(exported.portable.layout).toEqual(layout)
  expect(exported.validation.ok).toBe(true)
  // A run freezes the version as drawn, and marks only that version as used.
  const body = {
    workflowId: v1.workflowId,
    version: 2,
    inputs: {},
    agentMap: [{ agentId: 'builder', incarnation: incarnationOf(h, 'builder') }],
    acknowledgement: { text: ORCH_ACKNOWLEDGEMENT_TEXT },
  }
  const started = await post('/api/workflow-runs', body)
  expect(started.statusCode).toBe(201)
  const { run } = WorkflowRunCreatedSchema.parse(started.json())
  const snapshot = WorkflowRunSnapshotSchema.parse(
    (await get(`/api/workflow-runs/${run.id}`)).json(),
  )
  expect(snapshot.run.definition.layout).toEqual(layout)
  const detail = WorkflowDetailSchema.parse((await get(`/api/workflows/${v1.workflowId}`)).json())
  expect(detail.versions.map((v) => [v.version, v.used])).toEqual([
    [1, false],
    [2, true],
  ])
})
