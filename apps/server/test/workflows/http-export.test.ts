import {
  WorkflowExportSchema,
  WorkflowVersionSchema,
  type WorkflowDefinition,
} from '@score/contract'
import { expect, test } from 'vitest'
import { agent, edge, end, gate } from './wf-harness.ts'
import { post, setupWorkflowHttp } from './http-helpers.ts'

setupWorkflowHttp()

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
