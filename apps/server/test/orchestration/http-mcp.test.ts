import { OrchestrationCreatedSchema } from '@score/contract'
import { expect, test } from 'vitest'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import {
  boot,
  bridgeUrl,
  capability,
  createBody,
  detail,
  h,
  mcp,
  post,
  tool,
} from './http-helpers.ts'
import { attemptOf } from './harness.ts'

test('MCP: the orch tools need the access switch and the lead capability, not the writes switch; other agents cannot use it', async () => {
  await boot({
    script: byTurn({
      1: async (t) => {
        capability.value = t.capability
      },
    }),
  })
  const id = OrchestrationCreatedSchema.parse(
    (await post('/api/orchestrations', createBody({ gatePolicy: 'none' }))).json(),
  ).orchestration.id
  await h.until(() => capability.value !== '')
  // The lead's turn is running (virtual time stands still).
  expect(attemptOf(h, id, 'lead')[0]!.state).toBe('running')
  h.access.patch('lead', { enabled: true, writesEnabled: false })
  h.access.patch('builder', { enabled: true, writesEnabled: true })
  const leadClient = await mcp(h.access.issueToken('lead'))
  const names = (await leadClient.listTools()).tools.map((t) => t.name)
  expect(names).toEqual(
    expect.arrayContaining([
      'orch.plan',
      'orch.assign',
      'orch.cancel',
      'orch.ask',
      'orch.requestApproval',
      'orch.note',
      'orch.finish',
      'orch.receipt',
      'orch.check',
      'orch.vote',
    ]),
  )

  const noted = await tool(leadClient, 'orch.note', {
    capability: capability.value,
    commandId: 'n1',
    text: 'hello from MCP',
  })
  expect(noted.error).toBe(false)
  expect(noted.json).toMatchObject({ status: 'ok', tool: 'orch.note', commandId: 'n1' })
  const assigned = await tool(leadClient, 'orch.assign', {
    capability: capability.value,
    commandId: 'a1',
    agent: 'builder',
    instruction: 'do it',
  })
  expect(assigned.json.result.stepId).toBe('s1')
  const refused = await tool(leadClient, 'orch.assign', {
    capability: capability.value,
    commandId: 'a2',
    agent: 'nobody',
    instruction: 'do it',
  })
  expect(refused.error).toBe(true)
  expect(refused.json.code).toBe('agent_not_allowed')
  // Bad shapes are rejected before they reach the executor.
  expect(
    (
      await tool(leadClient, 'orch.assign', {
        capability: 'orc_x',
        commandId: 'a3',
        agent: 'builder',
        instruction: 'x',
      })
    ).error,
  ).toBe(true)
  // Another agent, even with MCP access and writes, cannot use the lead's capability.
  const builderClient = await mcp(h.access.issueToken('builder'))
  const spoof = await tool(builderClient, 'orch.note', {
    capability: capability.value,
    commandId: 'n2',
    text: 'spoof',
  })
  expect(spoof.error).toBe(true)
  expect(spoof.text).toContain('unauthorized')
  // The writes switch does not open the run's room either: rooms.post into an owned room is refused.
  const roomPost = await tool(builderClient, 'rooms.post', {
    roomId: detail(id).roomId,
    text: 'hi',
  })
  expect(roomPost.error).toBe(true)
  expect(roomPost.text).toContain('orchestration_owned')
  // With MCP access off the tools are off, whatever the capability says.
  h.access.patch('lead', { enabled: false })
  const off = await fetch(bridgeUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${h.access.issueToken('lead')}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  expect(off.status).toBe(403)
  expect(detail(id).stepsList.map((s) => s.id)).toEqual(['s1'])
  // The note landed in the run's room, attributed to the lead and tagged via MCP.
  const note = h.rows<{ parts: string; author_agent_id: string }>(
    "SELECT parts, author_agent_id FROM messages WHERE id LIKE 'orc-note:%'",
  )[0]!
  expect(note.author_agent_id).toBe('lead')
  expect(JSON.parse(note.parts)).toEqual([
    expect.objectContaining({ text: 'hello from MCP', via: 'mcp' }),
  ])
})
