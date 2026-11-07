import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { FastifyInstance } from 'fastify'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, vi } from 'vitest'
import { buildApp, buildBridgeApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { insertRoom } from '../../src/domain/rooms.ts'
import type { HermesPort } from '../../src/hermes/index.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { KnowledgeAgentApi } from '../../src/knowledge/agent-api.ts'
import { KnowledgeVault } from '../../src/knowledge/vault.ts'
import { McpAccessStore } from '../../src/mcp/access.ts'

export let dir: string
export let db: ScoreDb
export let ingest: Ingest
export let vault: KnowledgeVault
export let access: McpAccessStore
export let bridge: FastifyInstance
export let browser: FastifyInstance
export let url: URL
export const comments: {
  taskId: string
  text?: string | undefined
  author?: string | undefined
}[] = []
// A barrier inside the Hermes call the comment tool awaits: lets a test hold tools open and count the ones running.
export const hermes = {
  hold: undefined as Promise<void> | undefined,
  active: 0,
  peak: 0,
  started: 0,
  waiters: [] as (() => void)[],
}
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

export type McpTestState = {
  now: number
  failTaskAction: boolean
}

export function setupMcpTest(state: McpTestState) {
  beforeEach(async () => {
    state.now = Date.parse(AT)
    comments.length = 0
    state.failTaskAction = false
    Object.assign(hermes, { hold: undefined, active: 0, peak: 0, started: 0, waiters: [] })
    dir = mkdtempSync(join(tmpdir(), 'score-mcp-'))
    db = openDatabase(join(dir, 'score.db'))
    migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
    ingest = createIngest(db, { clock: () => state.now })
    vault = new KnowledgeVault({
      vault: join(dir, 'vault'),
      db,
      watch: false,
      emit: () => undefined,
    })
    await vault.start()
    access = new McpAccessStore(db, () => state.now)
    db.tx((sqlite) => {
      insertRoom(
        sqlite,
        {
          id: 'r1',
          name: 'plans',
          kind: 'room',
          leadAgentId: 'lead',
          members: ['lead', 'builder'],
        },
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
      for (const t of [
        task('t1', 'builder'),
        task('t2', 'reviewer'),
        task('t3', 'lead', 'builder'),
      ])
        sqlite
          .prepare('INSERT INTO task_projections (id, detail) VALUES (?, ?)')
          .run(t.id, JSON.stringify(t))
    })
    const port = {
      taskAction: vi.fn(async (req: { taskId: string; text?: string; author?: string }) => {
        hermes.active++
        hermes.started++
        hermes.peak = Math.max(hermes.peak, hermes.active)
        for (const wake of hermes.waiters.splice(0)) wake()
        try {
          await hermes.hold
        } finally {
          hermes.active--
        }
        if (state.failTaskAction) throw new Error('hermes down')
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
        knowledge: new KnowledgeAgentApi(vault, db, () => state.now),
      },
      undefined,
      false,
      {
        db,
        access,
        ingest,
        port,
        knowledge: new KnowledgeAgentApi(vault, db, () => state.now),
        clock: () => state.now,
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
      clock: () => state.now,
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
}

export async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  )
  closers.push(() => client.close())
  return client
}
export const enable = (agent: string, writes = false) => {
  access.patch(agent, { enabled: true, writesEnabled: writes })
  return access.issueToken(agent)
}
export async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args })
  const text = (result.content as { text: string }[])[0]!.text
  return { error: result.isError === true, text, json: result.isError ? null : JSON.parse(text) }
}
export const post = (token: string | null, headers: Record<string, string> = {}) =>
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

export const TOKEN_IN_TEXT = () => `scm_${'Z'.repeat(43)}`
