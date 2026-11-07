import { AgentSummarySchema } from '@score/contract'
import { mkdirSync } from 'node:fs'
import fsPromises from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { SecurityPassword } from '../../src/auth/security-password.ts'
import { readAgent, reconcileAgents, updateProjectedAgent } from '../../src/domain/agents.ts'
import {
  addAgent,
  coding,
  db,
  dir,
  home,
  ingest,
  request,
  setupCodingRuntime,
  style,
  workspace,
} from './coding-runtime-helpers.ts'

setupCodingRuntime()

test('Add agent lists the CLIs and creates a coding agent that shows up as a team member', async () => {
  const runtimes = (await request('GET', '/api/coding-agents/runtimes')).json().items
  expect(
    runtimes.map((item: { runtime: string; state: string }) => [item.runtime, item.state]),
  ).toEqual([
    ['claude-code', 'ready'],
    ['codex', 'ready'],
    ['antigravity', 'ready'],
  ])
  expect(runtimes[0].quota).toMatch(/Claude plan quota/)
  const agent = await addAgent()
  expect(agent).toMatchObject({
    id: 'coder',
    permission: 'workspace-write',
    cli: { state: 'ready', version: '2.1.295', problem: null },
  })
  const team = (await request('GET', '/api/agents')).json().items as {
    id: string
    runtime?: string
    runtimeNote?: string
  }[]
  const coder = team.find((item) => item.id === 'coder')!
  expect(coder.runtime).toBe('claude-code')
  expect(coder.runtimeNote).toMatch(/Claude Code · Uses your Claude plan quota/)
  expect(team.find((item) => item.id === 'lead')!.runtime).toBeUndefined()
})

test('PLAN 10.2: a coding agent has any of the 20 shapes, set at creation and by the style route', async () => {
  const forged = { rev: 'forged', activities: ['idle'], name: null, credits: null, floor: 0 }
  const created = await addAgent({
    style: { color: '#19C39A', shape: 'cylinder', look: 'ring', pack: forged },
  })
  expect(created.style).toEqual({ color: '#19C39A', shape: 'cylinder' })
  const patched = await request('PATCH', '/api/agents/coder/style', {
    shape: 'gem',
    color: '#102030',
  })
  expect(patched.statusCode, patched.body).toBe(200)
  const expected = { color: '#102030', shape: 'gem' }
  expect(patched.json().style).toEqual(expected)
  // Every view of the agent agrees, and the style lives in the agent's own row only.
  const listed = (await request('GET', '/api/coding-agents')).json().items[0]
  expect(listed.style).toEqual(expected)
  const team = (await request('GET', '/api/agents')).json().items as {
    id: string
    style: unknown
  }[]
  expect(team.find((item) => item.id === 'coder')!.style).toEqual(expected)
  expect(db.sqlite.prepare('SELECT color, shape FROM coding_agents').all()).toEqual([
    { color: '#102030', shape: 'gem' },
  ])
  expect(db.sqlite.prepare('SELECT * FROM agent_styles').all()).toEqual([])
  const events = db.sqlite
    .prepare("SELECT data FROM events WHERE type = 'agent.updated' ORDER BY seq")
    .all()
    .map((row) => JSON.parse(String(row.data)))
    .filter((data) => data.id === 'coder')
  expect(events.at(-1).style).toEqual(expected)
  expect(
    (await request('PATCH', '/api/agents/coder/style', { shape: 'dodecagon' })).statusCode,
  ).toBe(400)
})
test('PLAN 10.2: a refresh that read the agent before a style save cannot write the old style back', async () => {
  await addAgent()
  // The list a slow refresh fetched before the person changed anything.
  const stale = await coding.details()
  await request('PATCH', '/api/agents/coder/style', { shape: 'gem' })
  const saved = (await request('GET', '/api/agents'))
    .json()
    .items.find((item: { id: string }) => item.id === 'coder').style
  expect(saved).toMatchObject({ shape: 'gem' })
  const eventsBefore = db.sqlite
    .prepare("SELECT count(*) AS n FROM events WHERE type = 'agent.updated'")
    .get()
  await reconcileAgents(ingest, stale)
  expect(
    (await request('GET', '/api/agents'))
      .json()
      .items.find((item: { id: string }) => item.id === 'coder').style,
  ).toEqual(saved)
  expect(
    db.sqlite.prepare("SELECT count(*) AS n FROM events WHERE type = 'agent.updated'").get(),
  ).toEqual(eventsBefore)
  // The same for the fake adapter's own updates, which also pass through the projection.
  updateProjectedAgent(db.sqlite, AgentSummarySchema.parse(stale[0]))
  expect(readAgent(db.sqlite, 'coder')!.style).toEqual(saved)
})
test('refuses duplicates, a missing CLI, an unknown runtime, full access without the password, bad folders', async () => {
  await addAgent()
  expect(
    (
      await request('POST', '/api/coding-agents', {
        id: 'coder',
        name: 'X',
        runtime: 'codex',
        acknowledgeReads: true,
        workspace,
        style,
      })
    ).statusCode,
  ).toBe(409)
  expect(
    (
      await request('POST', '/api/coding-agents', {
        id: 'lead',
        name: 'X',
        runtime: 'codex',
        acknowledgeReads: true,
        workspace,
        style,
      })
    ).statusCode,
  ).toBe(409)
  const opencode = await request('POST', '/api/coding-agents', {
    id: 'oc',
    name: 'OC',
    runtime: 'opencode',
    workspace,
    style,
  })
  expect(opencode.statusCode).toBe(400)
  const full = await request('POST', '/api/coding-agents', {
    id: 'bold',
    name: 'Bold',
    runtime: 'codex',
    acknowledgeReads: true,
    workspace,
    style,
    permission: 'full',
  })
  expect(full.statusCode).toBe(409)
  expect(full.json().error.code).toBe('password_not_set')
  const home2 = await request('POST', '/api/coding-agents', {
    id: 'bad',
    name: 'Bad',
    runtime: 'codex',
    acknowledgeReads: true,
    workspace: '/',
    style,
  })
  expect(home2.statusCode).toBe(422)
  expect(
    (
      await request('POST', '/api/coding-agents', {
        id: 'bad',
        name: 'Bad',
        runtime: 'codex',
        acknowledgeReads: true,
        workspace: join(home, 'x'),
        style,
      })
    ).statusCode,
  ).toBe(422)
})

test('full access needs the security password, and lowering it never does', async () => {
  await new SecurityPassword(home).set('correct horse battery', undefined)
  const wrong = await request('POST', '/api/coding-agents', {
    id: 'bold',
    name: 'Bold',
    runtime: 'codex',
    acknowledgeReads: true,
    workspace,
    style,
    permission: 'full',
    password: 'nope nope nope',
  })
  expect(wrong.statusCode).toBe(403)
  const ok = await request('POST', '/api/coding-agents', {
    id: 'bold',
    name: 'Bold',
    runtime: 'codex',
    acknowledgeReads: true,
    workspace,
    style,
    permission: 'full',
    password: 'correct horse battery',
  })
  expect(ok.statusCode).toBe(201)
  expect(ok.json().permission).toBe('full')
  const lower = await request('PATCH', '/api/coding-agents/bold', { permission: 'read-only' })
  expect(lower.json().permission).toBe('read-only')
  const raise = await request('PATCH', '/api/coding-agents/bold', { permission: 'full' })
  expect(raise.statusCode).toBe(403)
})

test('8.6: the quota floor defaults to 10, is set at creation and by PATCH, and stays within 0–50', async () => {
  const created = await addAgent()
  expect(created.quotaFloorPercent).toBe(10)
  const patched = await request('PATCH', '/api/coding-agents/coder', { quotaFloorPercent: 25 })
  expect(patched.statusCode, patched.body).toBe(200)
  expect(patched.json().quotaFloorPercent).toBe(25)
  const off = await request('PATCH', '/api/coding-agents/coder', { quotaFloorPercent: 0 })
  expect(off.json().quotaFloorPercent).toBe(0)
  expect(
    (await request('PATCH', '/api/coding-agents/coder', { quotaFloorPercent: 51 })).statusCode,
  ).toBe(400)
  expect(
    (await request('PATCH', '/api/coding-agents/coder', { quotaFloorPercent: 1.5 })).statusCode,
  ).toBe(400)
  const listed = await request('GET', '/api/coding-agents')
  expect(listed.json().items[0].quotaFloorPercent).toBe(0)
  const second = await request('POST', '/api/coding-agents', {
    id: 'coder2',
    name: 'Coder two',
    runtime: 'claude-code',
    workspace,
    style,
    quotaFloorPercent: 30,
  })
  expect(second.json().quotaFloorPercent).toBe(30)
})

test('audit5 S5-001: a stale PATCH cannot turn a fresh downgrade back into full without a password', async () => {
  await new SecurityPassword(home).set('correct horse battery', undefined)
  const created = await request('POST', '/api/coding-agents', {
    id: 'bold',
    name: 'Bold',
    runtime: 'codex',
    acknowledgeReads: true,
    workspace,
    style,
    permission: 'full',
    password: 'correct horse battery',
  })
  expect(created.statusCode).toBe(201)
  const other = join(dir, 'other-ws')
  mkdirSync(other)
  // Hold the stale request while it validates its new workspace (it already read permission = full: no password needed).
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  let held!: () => void
  const heldSeen = new Promise<void>((resolve) => (held = resolve))
  const realStat = fsPromises.stat.bind(fsPromises)
  vi.spyOn(fsPromises, 'stat').mockImplementation((async (target: string, ...rest: never[]) => {
    if (String(target) === other) {
      held()
      await gate
    }
    return realStat(target, ...rest)
  }) as typeof fsPromises.stat)
  const stale = request('PATCH', '/api/coding-agents/bold', {
    permission: 'full',
    workspace: other,
  })
  await heldSeen
  const lowered = await request('PATCH', '/api/coding-agents/bold', { permission: 'read-only' })
  expect(lowered.json().permission).toBe('read-only')
  release()
  const result = await stale
  expect(result.statusCode, result.body).toBe(409)
  expect(result.json().error.code).toBe('conflict')
  const row = db.sqlite
    .prepare('SELECT permission, workspace FROM coding_agents WHERE id = ?')
    .get('bold') as { permission: string; workspace: string }
  expect(row.permission).toBe('read-only')
  expect(row.workspace).not.toBe(other)
  // Freshly authorised (password verified for this request), the escalation is allowed.
  const raised = await request('PATCH', '/api/coding-agents/bold', {
    permission: 'full',
    password: 'correct horse battery',
  })
  expect(raised.json().permission).toBe('full')
})
