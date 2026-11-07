import { WorkflowListSchema } from '@score/contract'
import { expect, test } from 'vitest'
import { agent, edge, end } from './wf-harness.ts'
import { app, def, get, headers, setupWorkflowHttp } from './http-helpers.ts'

setupWorkflowHttp()

// Codex review: keyed large saves and keyed deletes replay instead of failing after committing
test('a large keyed save and a keyed delete commit once and replay their stored answer', async () => {
  const big = def({
    nodes: [
      agent('a', { instruction: 'x'.repeat(32 * 1024) }),
      agent('b', { instruction: 'y'.repeat(32 * 1024) }),
      end(),
    ],
    edges: [edge('a', 'b'), edge('b', 'done')],
  })
  const keyed = (method: 'POST' | 'DELETE', url: string, key: string, payload?: object) =>
    app.inject({
      method,
      url,
      headers: { ...headers, 'idempotency-key': key },
      ...(payload ? { payload } : {}),
    })
  const first = await keyed('POST', '/api/workflows', 'save-1', { definition: big })
  expect(first.statusCode).toBe(201)
  const again = await keyed('POST', '/api/workflows', 'save-1', { definition: big })
  expect(again.statusCode).toBe(201)
  expect(again.json()).toEqual(first.json())
  expect(WorkflowListSchema.parse((await get('/api/workflows')).json()).items).toHaveLength(1)
  const id = first.json().workflowId as string
  const del = await keyed('DELETE', `/api/workflows/${id}`, 'del-1')
  expect(del.statusCode).toBe(204)
  expect((await keyed('DELETE', `/api/workflows/${id}`, 'del-1')).statusCode).toBe(204)
})
