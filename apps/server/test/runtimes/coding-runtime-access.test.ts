import { expect, test, vi } from 'vitest'
import { McpAccessStore } from '../../src/mcp/access.ts'
import {
  addAgent,
  calls,
  db,
  finished,
  makeRoom,
  request,
  roomId,
  runs,
  say,
  setupCodingRuntime,
  style,
  workspace,
} from './coding-runtime-helpers.ts'

setupCodingRuntime()

test('an unused coding agent does not make known spend unknown; the trend stays Hermes-only (review: medium 8)', async () => {
  await request('GET', '/api/agents') // projects the Hermes agents
  const before = (await request('GET', '/api/reports?range=7d')).json()
  expect(before.totals.spendUsd).toBeGreaterThan(0)
  await addAgent()
  const after = (await request('GET', '/api/reports?range=7d')).json()
  expect(after.totals.spendUsd).toBe(before.totals.spendUsd)
  expect(after.trend).toEqual(before.trend)
  expect(after.byAgent.find((row: { agentId: string }) => row.agentId === 'coder')).toMatchObject({
    spendUsd: 0,
  })
})

test('a Codex agent needs the read acknowledgement (it can read every file the user can)', async () => {
  const refused = await request('POST', '/api/coding-agents', {
    id: 'cx-noack',
    name: 'Cx',
    runtime: 'codex',
    workspace,
    style,
  })
  expect(refused.statusCode).toBe(400)
  expect(refused.json().error.code).toBe('acknowledgement_required')
  await addAgent({ id: 'cx-ack', name: 'Cx', runtime: 'codex', acknowledgeReads: true })
})

test('fix-l: deleting a coding agent revokes its MCP token and switches', async () => {
  await addAgent()
  const access = new McpAccessStore(db)
  access.patch('coder', { enabled: true, writesEnabled: true })
  const token = access.issueToken('coder')
  expect(access.agentForToken(token)).toEqual({ agentId: 'coder' })
  expect((await request('DELETE', '/api/coding-agents/coder')).statusCode).toBe(204)
  expect(access.agentForToken(token)).toBeUndefined()
  expect(access.get('coder')).toMatchObject({ enabled: false, hasToken: false })
  expect(db.sqlite.prepare('SELECT 1 FROM mcp_access WHERE agent_id = ?').get('coder')).toBe(
    undefined,
  )
})

test('fix-l: a removed coding agent fails MCP auth even if a stale access row survives', async () => {
  await addAgent()
  const access = new McpAccessStore(db)
  const token = access.issueToken('coder')
  db.sqlite.prepare("UPDATE coding_agents SET removed_at = 'x' WHERE id = 'coder'").run()
  expect(access.agentForToken(token)).toBeUndefined()
})

test('fix-l: a permission downgrade applies to a turn already waiting in the queue', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:slow] first')
  await vi.waitFor(() => expect(runs()[0]?.status).toBe('running'), { timeout: 10_000 })
  const firstRoom = roomId
  await makeRoom()
  await say('@coder second')
  await vi.waitFor(() => expect(runs()).toHaveLength(2), { timeout: 10_000 })
  expect(runs()[1]!.status).toBe('queued')
  const lowered = await request('PATCH', '/api/coding-agents/coder', { permission: 'read-only' })
  expect(lowered.statusCode).toBe(200)
  const first = db.sqlite
    .prepare("SELECT message_id FROM message_runs WHERE room_id = ? AND agent_id = 'coder'")
    .get(firstRoom) as { message_id: string }
  await request('POST', `/api/rooms/${firstRoom}/messages/${first.message_id}/stop`)
  await finished(2)
  const second = calls().find((call) => call.prompt.includes('second'))!
  expect(second.args).toEqual(expect.arrayContaining(['--permission-mode', 'dontAsk']))
  expect(second.args).not.toContain('acceptEdits')
}, 30_000)

test('fix-l: a credential label clipped off a huge tool result never leaves its value in a Watch frame', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:bigsecret] go')
  await finished()
  const frames = JSON.stringify(
    db.sqlite.prepare('SELECT surface, payload, caption FROM watch_frames').all(),
  )
  expect(frames).toContain('terminal')
  expect(frames).not.toContain('v'.repeat(200))
  const stored = JSON.stringify([
    db.sqlite.prepare('SELECT * FROM tool_calls').all(),
    db.sqlite.prepare('SELECT data FROM events').all(),
  ])
  expect(stored).not.toContain('v'.repeat(200))
})

// ---------------------------------------------------------------------------------------------------- Antigravity (7.6)
