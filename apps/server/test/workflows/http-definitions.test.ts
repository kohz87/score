import {
  ValidationResultSchema,
  WorkflowDetailSchema,
  WorkflowListSchema,
  WorkflowVersionSchema,
} from '@score/contract'
import { expect, test } from 'vitest'
import { agent, end } from './wf-harness.ts'
import { app, def, get, h, headers, post, setupWorkflowHttp } from './http-helpers.ts'

setupWorkflowHttp()

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

test('a recipe can be archived and unarchived; its runs stay', async () => {
  const v = WorkflowVersionSchema.parse(
    (await post('/api/workflows', { definition: def() })).json(),
  )
  const archived = await post(`/api/workflows/${v.workflowId}/archive`, {})
  expect(archived.statusCode).toBe(200)
  expect(archived.json().archivedAt).toEqual(expect.any(String))
  const list = WorkflowListSchema.parse((await get('/api/workflows')).json())
  expect(list.items.find((item) => item.id === v.workflowId)?.archivedAt).toEqual(
    expect.any(String),
  )
  const restored = await post(`/api/workflows/${v.workflowId}/unarchive`, {})
  expect(restored.json().archivedAt).toBeNull()
  expect((await post('/api/workflows/nope/archive', {})).statusCode).toBe(404)
})
