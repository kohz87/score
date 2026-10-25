import { RoomSchema } from '@score/contract'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { reconcileAgents } from '../../src/domain/agents.ts'
import { ensureTeamRoom, teamRoomId } from '../../src/domain/team-room.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { CliLocator } from '../../src/runtimes/coding/cli.ts'
import { CodingRuntime } from '../../src/runtimes/coding/service.ts'
import { SecurityPassword } from '../../src/auth/security-password.ts'
import { defaultRootPolicy } from '../../src/workspace/policy.ts'
import { FAKE_CLI } from './coding-fixtures.ts'

// Coding agents are team members like Hermes profiles: the team room's members follow every add and removal.
vi.setConfig({ testTimeout: 30_000 })

let dir: string
let workspace: string
let db: ScoreDb
let ingest: Ingest
let port: FakePort
let coding: CodingRuntime
let app: ReturnType<typeof buildApp>
let headers: { 'x-score-client': string; cookie: string }

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'score-codingteam-'))
  const home = join(dir, 'home')
  workspace = join(dir, 'ws')
  mkdirSync(home)
  mkdirSync(workspace)
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  ingest = createIngest(db)
  port = new FakePort(1, { db }, false)
  await port.start(ingest)
  coding = new CodingRuntime({
    db,
    ingest,
    locator: new CliLocator({ fakeCli: FAKE_CLI, cacheMs: 0 }),
    home,
    policy: defaultRootPolicy([home]),
  })
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake', SCORE_HOME: home }),
    logger: false,
    db,
    ingest,
    port,
    coding,
    security: new SecurityPassword(home),
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
  // Live, the directory has projected the Hermes profiles by the time anyone adds an agent.
  await reconcileAgents(ingest, await port.listAgentDetails())
  // The startup step: the room is made from the composite port's agents.
  const agents = await (
    await import('../../src/runtimes/coding/port.ts')
  )
    .withCodingAgents(port, coding)
    .listAgents()
  await ingest.submit({
    source: 'rooms',
    identity: 'team',
    apply: ({ sqlite, now }) =>
      ensureTeamRoom(
        sqlite,
        agents.map((a) => a.id),
        now,
      ),
  })
})
afterEach(async () => {
  await coding.close()
  await port.stop()
  await app.close()
  await ingest.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const request = (method: 'POST' | 'PATCH' | 'DELETE' | 'GET', url: string, payload?: object) =>
  app.inject({ method, url, headers, ...(payload ? { payload } : {}) })
const add = () =>
  request('POST', '/api/coding-agents', {
    id: 'coder',
    name: 'Coder',
    runtime: 'claude-code',
    workspace,
    style: { color: '#19C39A', shape: 'hexagon' },
  })
async function members(): Promise<string[]> {
  const id = teamRoomId(db.sqlite)!
  const json = (await request('GET', `/api/rooms/${id}`)).json() as { room?: unknown }
  return RoomSchema.parse(json.room ?? json).members
}

test('adding and removing a coding agent updates the team room members', async () => {
  expect(await members()).not.toContain('coder')
  expect((await add()).statusCode).toBe(201)
  expect(await members()).toContain('coder')
  expect(await members()).toContain('lead')
  expect((await request('DELETE', '/api/coding-agents/coder')).statusCode).toBe(204)
  expect(await members()).not.toContain('coder')
})

test('a coding agent can be the team room lead, be addressed, and gets unaddressed messages', async () => {
  expect((await add()).statusCode).toBe(201)
  const id = teamRoomId(db.sqlite)!
  const patched = await request('PATCH', `/api/rooms/${id}`, { leadAgentId: 'coder' })
  expect(patched.statusCode, patched.body).toBe(200)
  const sent = await request('POST', `/api/rooms/${id}/messages`, { text: '@coder hello there' })
  expect(sent.statusCode, sent.body).toBe(200)
  const count = () =>
    (
      db.sqlite
        .prepare("SELECT COUNT(*) AS n FROM message_runs WHERE agent_id = 'coder'")
        .get() as { n: number }
    ).n
  expect(count()).toBeGreaterThan(0)
  const before = count()
  const plain = await request('POST', `/api/rooms/${id}/messages`, { text: 'no name here' })
  expect(plain.statusCode, plain.body).toBe(200)
  expect(count()).toBeGreaterThan(before)
})

test('removing the coding agent that leads clears the lead and the member', async () => {
  expect((await add()).statusCode).toBe(201)
  const id = teamRoomId(db.sqlite)!
  expect((await request('PATCH', `/api/rooms/${id}`, { leadAgentId: 'coder' })).statusCode).toBe(
    200,
  )
  expect((await request('DELETE', '/api/coding-agents/coder')).statusCode).toBe(204)
  expect(db.sqlite.prepare('SELECT lead_agent_id AS lead FROM rooms WHERE id = ?').get(id)).toEqual(
    { lead: null },
  )
  const after = await members()
  expect(after).not.toContain('coder')
  expect(after).toContain('lead')
})

test('an agent still being set up joins the team room only once it is ready', async () => {
  const [template] = await port.listAgentDetails()
  const detail = { ...template!, id: 'newbie', name: 'Newbie' }
  db.sqlite
    .prepare(
      "INSERT INTO agent_lifecycle (agent_id, state, incarnation_id, operation_id, display_name) VALUES ('newbie', 'setting_up', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', NULL)",
    )
    .run()
  await reconcileAgents(ingest, [detail])
  expect(await members()).not.toContain('newbie')
  db.sqlite.prepare("UPDATE agent_lifecycle SET state = 'ready' WHERE agent_id = 'newbie'").run()
  await reconcileAgents(ingest, [{ ...detail, role: 'changed' }])
  expect(await members()).toContain('newbie')
})
