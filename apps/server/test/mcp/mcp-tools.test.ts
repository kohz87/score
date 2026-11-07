import { MCP_POSTS_PER_HOUR } from '@score/contract'
import { expect, test, vi } from 'vitest'
import {
  access,
  call,
  comments,
  connect,
  db,
  enable,
  ingest,
  post,
  setupMcpTest,
  vault,
  type McpTestState,
} from './mcp-helpers.ts'

let now: number
let failTaskAction = false
const state: McpTestState = {
  get now() {
    return now
  },
  set now(value) {
    now = value
  },
  get failTaskAction() {
    return failTaskAction
  },
  set failTaskAction(value) {
    failTaskAction = value
  },
}
setupMcpTest(state)

test('end to end with the SDK client: tools list, rooms and tasks are scoped to the token agent', async () => {
  const client = await connect(enable('builder'))
  const tools = (await client.listTools()).tools.map((tool) => tool.name).sort()
  expect(tools).toEqual(
    [
      'knowledge.read',
      'knowledge.search',
      'knowledge.write',
      'rooms.list',
      'rooms.post',
      'tasks.comment',
      'tasks.list',
    ].sort(),
  )
  // 3.7.8: Score remembers what it handed this agent's client on tools/list (and only on tools/list).
  expect(access.listed('builder')?.names).toEqual(tools)
  // A list handed under a key that has been rotated since doesn't count.
  access.recordListed('builder', ['old-key'], 'scm_' + 'x'.repeat(43))
  expect(access.listed('builder')?.names).toEqual(tools)
  access.recordListed('builder', ['stale'])
  const rooms = await call(client, 'rooms.list')
  expect(access.listed('builder')?.names).toEqual(['stale'])
  expect(rooms.json.rooms.map((room: { id: string }) => room.id)).toEqual(['r1'])
  const tasks = await call(client, 'tasks.list')
  expect(tasks.json.tasks.map((t: { id: string }) => t.id).sort()).toEqual(['t1', 't3'])
  // No tool takes an agent argument: an extra one is ignored, never honoured.
  const spoof = await call(client, 'tasks.list', { agentId: 'reviewer', assignee: 'reviewer' })
  expect(spoof.json.tasks.map((t: { id: string }) => t.id).sort()).toEqual(['t1', 't3'])
})

test('writes are refused while the writes switch is off, reads still work', async () => {
  const client = await connect(enable('builder', false))
  for (const [name, args] of [
    ['rooms.post', { roomId: 'r1', text: 'hi' }],
    ['tasks.comment', { taskId: 't1', text: 'hi' }],
    ['knowledge.write', { path: 'a.md', body: 'x', expectedEtag: null }],
  ] as const) {
    const result = await call(client, name, args)
    expect(result.error).toBe(true)
    expect(result.text).toContain('mcp_writes_off')
  }
  expect(comments).toEqual([])
  expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 })
  expect((await vault.tree()).notes.map((note) => note.path)).not.toContain('a.md')
  expect((await call(client, 'rooms.list')).error).toBe(false)
  expect((await call(client, 'knowledge.search', { query: 'x' })).error).toBe(false)
  // Turning the master switch off blocks reads on the next request.
  access.patch('builder', { enabled: false })
  expect((await post(access.issueToken('builder'))).status).toBe(403)
})

test('writes with the switch on: posts are agent-authored and marked via MCP, scoped by membership and ownership', async () => {
  const client = await connect(enable('builder', true))
  const posted = await call(client, 'rooms.post', {
    roomId: 'r1',
    text: 'status: token=abc123456789 done',
  })
  expect(posted.error).toBe(false)
  const row = db.sqlite
    .prepare('SELECT author_kind, author_agent_id, parts, "to" FROM messages')
    .get() as Record<string, string>
  expect(row.author_kind).toBe('agent')
  expect(row.author_agent_id).toBe('builder')
  expect(JSON.parse(row.to!)).toEqual([])
  expect(JSON.parse(row.parts!)).toEqual([expect.objectContaining({ kind: 'text', via: 'mcp' })])
  // Nobody was woken: no run was reserved.
  expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM message_runs').get()).toEqual({ n: 0 })
  expect((await call(client, 'rooms.post', { roomId: 'r2', text: 'x' })).error).toBe(true)
  expect((await call(client, 'tasks.comment', { taskId: 't2', text: 'x' })).error).toBe(true)
  expect((await call(client, 'tasks.comment', { taskId: 't1', text: 'looks good' })).error).toBe(
    false,
  )
  expect(comments).toEqual([
    { taskId: 't1', action: 'comment', text: '[via MCP] looks good', author: 'builder' },
  ])
  const written = await call(client, 'knowledge.write', {
    path: 'notes/a.md',
    body: '# A',
    expectedEtag: null,
  })
  expect(written.error).toBe(false)
  const read = await call(client, 'knowledge.read', { path: 'notes/a.md' })
  expect(read.json.body).toBe('# A')
  const hits = await call(client, 'knowledge.search', { query: 'A' })
  expect(hits.error).toBe(false)
})

test('posting is rate limited per agent per hour, and the window slides', async () => {
  const client = await connect(enable('builder', true))
  for (let i = 0; i < MCP_POSTS_PER_HOUR; i++)
    expect((await call(client, 'rooms.post', { roomId: 'r1', text: `n${i}` })).error).toBe(false)
  const limited = await call(client, 'rooms.post', { roomId: 'r1', text: 'one more' })
  expect(limited.error).toBe(true)
  expect(limited.text).toContain('rate_limited')
  // Comments share the budget.
  expect((await call(client, 'tasks.comment', { taskId: 't1', text: 'x' })).error).toBe(true)
  // Another agent has its own budget.
  const other = await connect(enable('lead', true))
  expect((await call(other, 'rooms.post', { roomId: 'r1', text: 'mine' })).error).toBe(false)
  now += 61 * 60 * 1000
  expect((await call(client, 'rooms.post', { roomId: 'r1', text: 'later' })).error).toBe(false)
})

test('fix-argon A4: MCP errors keep their details (retryAfterSeconds, the current etag) and nothing else', async () => {
  const client = await connect(enable('builder', true))
  const first = await call(client, 'knowledge.write', {
    path: 'e.md',
    body: 'v1',
    expectedEtag: null,
  })
  expect(first.error).toBe(false)
  const stale = await call(client, 'knowledge.write', {
    path: 'e.md',
    body: 'v2',
    expectedEtag: 'stale',
  })
  expect(stale.error).toBe(true)
  const conflict = JSON.parse(stale.text.slice(stale.text.indexOf('\n') + 1))
  expect(stale.text).toMatch(/^conflict: /)
  expect(typeof conflict.details.etag).toBe('string')
  expect(stale.text).not.toMatch(/\bat .*\.ts/)
  for (let i = 0; i < MCP_POSTS_PER_HOUR; i++)
    await call(client, 'rooms.post', { roomId: 'r1', text: `n${i}` })
  const limited = await call(client, 'rooms.post', { roomId: 'r1', text: 'one more' })
  expect(limited.text).toContain('rate_limited')
  expect(
    JSON.parse(limited.text.slice(limited.text.indexOf('\n') + 1)).details.retryAfterSeconds,
  ).toBeGreaterThan(0)
})

test('a post that fails after its slot was reserved gives the slot back', async () => {
  const client = await connect(enable('builder', true))
  const submit = vi.spyOn(ingest, 'submit').mockRejectedValueOnce(new Error('disk full'))
  expect((await call(client, 'rooms.post', { roomId: 'r1', text: 'x' })).error).toBe(true)
  expect(submit).toHaveBeenCalledTimes(1)
  expect(access.postsLastHour('builder')).toBe(0)
  failTaskAction = true
  expect((await call(client, 'tasks.comment', { taskId: 't1', text: 'x' })).error).toBe(true)
  expect(access.postsLastHour('builder')).toBe(0)
  failTaskAction = false
  expect((await call(client, 'rooms.post', { roomId: 'r1', text: 'ok' })).error).toBe(false)
  expect(access.postsLastHour('builder')).toBe(1)
})
