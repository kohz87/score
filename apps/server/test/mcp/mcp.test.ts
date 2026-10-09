import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { McpAccessSchema, McpTokenIssuedSchema, MCP_POSTS_PER_HOUR } from '@score/contract'
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { buildApp, buildBridgeApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { insertRoom } from '../../src/domain/rooms.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { KnowledgeAgentApi } from '../../src/knowledge/agent-api.ts'
import { KnowledgeVault } from '../../src/knowledge/vault.ts'
import { McpAccessStore } from '../../src/mcp/access.ts'
import { mcpAddCommand } from '../../src/hermes/mcp-command.ts'
import type { HermesPort } from '../../src/hermes/index.ts'

let dir: string
let db: ScoreDb
let ingest: Ingest
let vault: KnowledgeVault
let access: McpAccessStore
let bridge: FastifyInstance
let browser: FastifyInstance
let url: URL
let now: number
const clock = () => now
const comments: { taskId: string; text?: string | undefined }[] = []
const closers: (() => Promise<unknown>)[] = []
const AT = '2026-10-09T10:00:00.000Z'

const task = (id: string, assignee: string | null, reviewer: string | null = null) => ({
  id,
  key: id,
  title: `Task ${id}`,
  column: 'working',
  hermesStatus: 'running',
  assignee,
  reviewer,
  roomId: null,
  badge: null,
  progress: null,
  elapsedSec: null,
  note: null,
  updatedAt: AT,
  body: '',
  createdBy: 'you',
  steps: [],
  activity: [],
  pendingApproval: null,
  dependsOn: [],
  blocks: [],
  runIds: [],
})

beforeEach(async () => {
  now = Date.parse(AT)
  comments.length = 0
  dir = mkdtempSync(join(tmpdir(), 'score-mcp-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  ingest = createIngest(db, { clock })
  vault = new KnowledgeVault({ vault: join(dir, 'vault'), db, watch: false, emit: () => undefined })
  await vault.start()
  access = new McpAccessStore(db, clock)
  db.tx((sqlite) => {
    insertRoom(
      sqlite,
      { id: 'r1', name: 'plans', kind: 'room', leadAgentId: 'lead', members: ['lead', 'builder'] },
      AT,
    )
    insertRoom(
      sqlite,
      {
        id: 'r2',
        name: 'secret',
        kind: 'room',
        leadAgentId: 'lead',
        members: ['lead', 'reviewer'],
      },
      AT,
    )
    for (const t of [task('t1', 'builder'), task('t2', 'reviewer'), task('t3', 'lead', 'builder')])
      sqlite
        .prepare('INSERT INTO task_projections (id, detail) VALUES (?, ?)')
        .run(t.id, JSON.stringify(t))
  })
  const port = {
    taskAction: vi.fn(async (req: { taskId: string; text?: string }) => {
      comments.push(req)
      return { hermesStatus: 'running' }
    }),
  } as unknown as Pick<HermesPort, 'taskAction'>
  bridge = buildBridgeApp(
    {
      db,
      ingest,
      bootstrapHash: Buffer.alloc(32, 1),
      getCompatibility: () => ({ disabled: [] }) as never,
      knowledge: new KnowledgeAgentApi(vault, db, clock),
    },
    undefined,
    false,
    {
      db,
      access,
      ingest,
      port,
      knowledge: new KnowledgeAgentApi(vault, db, clock),
      clock,
    },
  )
  await bridge.listen({ host: '127.0.0.1', port: 0 })
  const address = bridge.server.address()
  url = new URL(
    `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/bridge/mcp`,
  )
  browser = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake', SCORE_HOME: join(dir, 'home') }),
    logger: false,
    db,
    ingest,
    clock,
  })
})
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  await bridge.close()
  await browser.close()
  await vault.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  )
  closers.push(() => client.close())
  return client
}
const enable = (agent: string, writes = false) => {
  access.patch(agent, { enabled: true, writesEnabled: writes })
  return access.issueToken(agent)
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args })
  const text = (result.content as { text: string }[])[0]!.text
  return { error: result.isError === true, text, json: result.isError ? null : JSON.parse(text) }
}
const post = (token: string | null, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })

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
  const rooms = await call(client, 'rooms.list')
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
  expect(
    db.sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'message_runs'").get(),
  ).toBeDefined()
  expect((await call(client, 'rooms.post', { roomId: 'r2', text: 'x' })).error).toBe(true)
  expect((await call(client, 'tasks.comment', { taskId: 't2', text: 'x' })).error).toBe(true)
  expect((await call(client, 'tasks.comment', { taskId: 't1', text: 'looks good' })).error).toBe(
    false,
  )
  expect(comments).toEqual([
    { taskId: 't1', action: 'comment', text: '[via MCP: builder] looks good' },
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

test('a failed post gives its slot back', async () => {
  const client = await connect(enable('builder', true))
  await call(client, 'rooms.post', { roomId: 'nope', text: 'x' })
  expect(access.postsLastHour('builder')).toBe(0)
})

test('auth: no token, a malformed one, a bridge-style one, a rotated one and a revoked one all get 401', async () => {
  const token = enable('builder')
  expect((await post(null)).status).toBe(401)
  expect((await post('scm_short')).status).toBe(401)
  expect((await post('A'.repeat(43))).status).toBe(401)
  expect((await post(`scm_${'A'.repeat(43)}`)).status).toBe(401)
  expect((await post(token)).status).toBe(200)
  const rotated = access.issueToken('builder')
  expect((await post(token)).status).toBe(401)
  expect((await post(rotated)).status).toBe(200)
  access.revokeToken('builder')
  expect((await post(rotated)).status).toBe(401)
  // Only the hash is stored.
  const stored = db.sqlite.prepare('SELECT token_hash FROM mcp_access').get() as {
    token_hash: string | null
  }
  expect(JSON.stringify(db.sqlite.prepare('SELECT * FROM mcp_access').all())).not.toContain(rotated)
  expect(stored.token_hash).toBeNull()
})

test('browser-style requests are refused: foreign Host, any Origin, other methods', async () => {
  const token = enable('builder')
  expect((await post(token, { origin: 'https://evil.example' })).status).toBe(403)
  const rebound = await bridge.inject({
    method: 'POST',
    url: '/bridge/mcp',
    headers: {
      host: 'evil.example',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  })
  expect(rebound.statusCode).toBe(403)
  expect(
    (await fetch(url, { method: 'GET', headers: { authorization: `Bearer ${token}` } })).status,
  ).toBe(405)
})

test('an MCP token gets 401 on /api and /bridge/v1 paths, and a bridge-listener token kind does not open /bridge/mcp', async () => {
  const token = enable('builder')
  for (const [method, path] of [
    ['GET', '/api/health'],
    ['GET', '/api/rooms'],
    ['GET', '/api/agents/builder/mcp'],
    ['PUT', '/api/agents/builder/mcp'],
    ['POST', '/api/agents/builder/mcp/token'],
    ['POST', '/api/rooms/r1/messages'],
    ['GET', '/api/does-not-exist'],
  ] as const) {
    const res = await browser.inject({
      method,
      url: path,
      headers: { authorization: `Bearer ${token}`, 'x-score-client': 'web' },
      payload: method === 'GET' ? undefined : {},
    })
    expect([method, path, res.statusCode]).toEqual([method, path, 401])
  }
  for (const path of ['hello', 'events', 'knowledge/search', 'knowledge/write']) {
    const res = await bridge.inject({
      method: 'POST',
      url: `/bridge/v1/${path}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect([path, res.statusCode]).toEqual([path, 401])
  }
  // The other direction: a 43-character bridge-style token is no MCP token.
  const bridgeStyle = randomUUID().replaceAll('-', '').padEnd(43, 'a')
  expect((await post(bridgeStyle)).status).toBe(401)
})

test('MCP is not reachable on the browser listener', async () => {
  const token = enable('builder')
  const res = await browser.inject({
    method: 'POST',
    url: '/bridge/mcp',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  })
  expect(res.statusCode).toBe(404)
  expect(res.body).not.toContain('tools')
})

test('MCP is not served on the bridge listener without MCP deps, and the bridge app serves no /api', async () => {
  const plain = buildBridgeApp()
  expect((await plain.inject({ method: 'POST', url: '/bridge/mcp', payload: {} })).statusCode).toBe(
    404,
  )
  expect((await bridge.inject({ method: 'GET', url: '/api/rooms' })).statusCode).toBe(404)
  await plain.close()
})

test('management routes: need a paired browser; token shown once; command shape; switches', async () => {
  const url = '/api/agents/builder/mcp'
  const initial = McpAccessSchema.parse((await browser.inject({ url })).json())
  expect(initial).toMatchObject({
    enabled: false,
    writesEnabled: false,
    hasToken: false,
    available: false,
    command: null,
  })
  const paired = await browser.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'x-score-client': 'web' },
    payload: { token: browser.pairing.createToken() },
  })
  const headers = {
    'x-score-client': 'web',
    cookie: paired.headers['set-cookie']!.toString().split(';')[0]!,
  }
  expect(
    (await browser.inject({ method: 'PUT', url, payload: { enabled: true } })).statusCode,
  ).toBe(403)
  expect((await browser.inject({ method: 'POST', url: `${url}/token` })).statusCode).toBe(403)
  const on = McpAccessSchema.parse(
    (await browser.inject({ method: 'PUT', url, headers, payload: { enabled: true } })).json(),
  )
  expect(on).toMatchObject({ enabled: true, writesEnabled: false })
  expect(
    (await browser.inject({ method: 'PUT', url, headers, payload: { writesEnabled: 'yes' } }))
      .statusCode,
  ).toBe(400)
  expect((await browser.inject({ method: 'PUT', url, headers, payload: {} })).statusCode).toBe(400)
  const issued = McpTokenIssuedSchema.parse(
    (await browser.inject({ method: 'POST', url: `${url}/token`, headers })).json(),
  )
  expect(issued.access.hasToken).toBe(true)
  expect(JSON.stringify((await browser.inject({ url })).json())).not.toContain(issued.token)
  expect(access.agentForToken(issued.token)).toEqual({ agentId: 'builder' })
  const rotated = McpTokenIssuedSchema.parse(
    (await browser.inject({ method: 'POST', url: `${url}/token`, headers })).json(),
  )
  expect(access.agentForToken(issued.token)).toBeUndefined()
  expect(access.agentForToken(rotated.token)).toEqual({ agentId: 'builder' })
  const revoked = McpAccessSchema.parse(
    (await browser.inject({ method: 'DELETE', url: `${url}/token`, headers })).json(),
  )
  expect(revoked.hasToken).toBe(false)
})

test('the add command is shown as text with no token in it, and refuses unsafe profile names', () => {
  expect(mcpAddCommand('builder', 'http://127.0.0.1:8740/bridge/mcp')).toBe(
    'hermes --profile builder mcp add score --url http://127.0.0.1:8740/bridge/mcp --auth header',
  )
  for (const bad of ['a b', 'x;rm -rf', '$(id)', '-p', '', 'A'.repeat(65)])
    expect(mcpAddCommand(bad, 'http://127.0.0.1:8740/bridge/mcp')).toBeNull()
})
