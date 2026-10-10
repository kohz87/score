import {
  MessageSchema,
  RoomSchema,
  RunSummarySchema,
  type CodingAgent,
  type Message,
} from '@score/contract'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { messageFromRow } from '../../src/domain/rooms.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { CliLocator } from '../../src/runtimes/coding/cli.ts'
import { CodingRuntime } from '../../src/runtimes/coding/service.ts'
import { SecurityPassword } from '../../src/auth/security-password.ts'
import { defaultRootPolicy } from '../../src/workspace/policy.ts'
import { FAKE_CLI } from './coding-fixtures.ts'

// Every test here spawns real child processes (a version probe per agent and per turn, then the CLI itself). Alone that
// is ~1-2 s, but in the full parallel run on 4 cores node start-up alone takes seconds, and the two-agent Reports test
// (six spawns) overran the 5 s default: the work is real, so the budget says so (same as the other process-spawning tests).
vi.setConfig({ testTimeout: 30_000 })

let dir: string
let home: string
let workspace: string
let log: string
let db: ScoreDb
let ingest: Ingest
let port: FakePort
let coding: CodingRuntime
let app: ReturnType<typeof buildApp>
let headers: { 'x-score-client': string; cookie: string }
let roomId: string
const secrets = new Map<string, string | undefined>()

function setEnv(name: string, value: string | undefined) {
  if (!secrets.has(name)) secrets.set(name, process.env[name])
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

async function boot(options: { version?: string; maxTurnMs?: number; graceMs?: number } = {}) {
  setEnv('SCORE_CODING_FAKE_LOG', log)
  setEnv('SCORE_CODING_FAKE_VERSION', options.version)
  coding = new CodingRuntime({
    db,
    ingest,
    locator: new CliLocator({ fakeCli: FAKE_CLI, cacheMs: 0 }),
    home,
    policy: defaultRootPolicy([home]),
    ...(options.maxTurnMs ? { maxTurnMs: options.maxTurnMs } : {}),
    ...(options.graceMs ? { graceMs: options.graceMs } : {}),
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
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'score-coding-'))
  home = join(dir, 'home')
  workspace = join(dir, 'ws')
  log = join(dir, 'fake-cli.log')
  mkdirSync(home)
  mkdirSync(workspace)
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  ingest = createIngest(db)
  port = new FakePort(1, { db }, false)
  await port.start(ingest)
  await boot()
})
afterEach(async () => {
  await coding.close()
  await port.stop()
  await app.close()
  await ingest.close()
  db.close()
  for (const [name, value] of secrets) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  secrets.clear()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const request = (method: 'POST' | 'PATCH' | 'DELETE' | 'GET', url: string, payload?: object) =>
  app.inject({ method, url, headers, ...(payload ? { payload } : {}) })
const style = { color: '#19C39A', shape: 'hexagon' }
async function addAgent(over: Record<string, unknown> = {}): Promise<CodingAgent> {
  const response = await request('POST', '/api/coding-agents', {
    id: 'coder',
    name: 'Coder',
    runtime: 'claude-code',
    workspace,
    style,
    ...over,
  })
  expect(response.statusCode, response.body).toBe(201)
  return response.json()
}
let roomCount = 0
async function makeRoom(): Promise<string> {
  const created = await request('POST', '/api/rooms', {
    name: `code${++roomCount}`,
    leadAgentId: 'lead',
  })
  roomId = RoomSchema.parse(created.json()).id
  return roomId
}
async function say(text: string) {
  const response = await request('POST', `/api/rooms/${roomId}/messages`, { text })
  expect(response.statusCode, response.body).toBe(200)
  return response
}
const runs = () =>
  db.sqlite
    .prepare("SELECT * FROM runs WHERE runtime != 'hermes' ORDER BY started_at, rowid")
    .all() as {
    id: string
    status: string
    runtime: string
    cost_usd: number | null
    cost_kind: string | null
    input_tokens: number | null
    output_tokens: number | null
    session_id: string | null
    error: string | null
    profile: string
  }[]
async function finished(count = 1) {
  await vi.waitFor(
    () => {
      const rows = runs()
      expect(rows.length).toBeGreaterThanOrEqual(count)
      expect(rows.slice(0, count).every((row) => !['queued', 'running'].includes(row.status))).toBe(
        true,
      )
    },
    { timeout: 15_000, interval: 50 },
  )
  await ingest.flushListeners()
  await ingest.drain()
}
const replies = (): Message[] =>
  db.sqlite
    .prepare(
      "SELECT * FROM messages WHERE room_id = ? AND author_kind = 'agent' ORDER BY created_at, id",
    )
    .all(roomId)
    .map(messageFromRow)
const calls = () =>
  readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as {
          runtime: string
          args: string[]
          cwd: string
          prompt: string
          env: string[]
        },
    )

test('Add agent lists the CLIs and creates a coding agent that shows up as a team member', async () => {
  const runtimes = (await request('GET', '/api/coding-agents/runtimes')).json().items
  expect(
    runtimes.map((item: { runtime: string; state: string }) => [item.runtime, item.state]),
  ).toEqual([
    ['claude-code', 'ready'],
    ['codex', 'ready'],
    ['opencode', 'not_supported'],
  ])
  expect(runtimes[0].quota).toMatch(/Claude plan quota/)
  const agent = await addAgent()
  expect(agent).toMatchObject({
    id: 'coder',
    permission: 'workspace-write',
    cli: { state: 'ready', version: '2.1.295', confirmed: false },
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

test('refuses duplicates, a missing CLI, OpenCode, full access without the password, bad folders', async () => {
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
  expect(opencode.statusCode).toBe(422)
  expect(opencode.json().error.code).toBe('cli_not_installed')
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

test('an @mention runs Claude Code in the workspace: reply, tool cards, run, usage, frames, session', async () => {
  await addAgent()
  await makeRoom()
  setEnv('OPENAI_API_KEY', 'sk-abcdefghijklmnop')
  setEnv('SCORE_SECRET_THING', 'x')
  await say('@coder please add a greeting')
  await finished()
  const [run] = runs()
  expect(run).toMatchObject({
    profile: 'coder',
    runtime: 'claude-code',
    status: 'completed',
    cost_usd: 0.0123,
    cost_kind: 'estimated',
    input_tokens: 1350,
    output_tokens: 340,
    session_id: '11111111-1111-4111-8111-111111111111',
  })
  const [reply] = replies()
  expect(reply!.streaming).toBe(false)
  const kinds = reply!.parts.map((part) => part.kind)
  expect(kinds.filter((kind) => kind === 'tool')).toHaveLength(3)
  expect(kinds).toContain('thinking')
  const text = reply!.parts
    .filter((part) => part.kind === 'text')
    .map((part) => (part as { text: string }).text)
    .join('')
  expect(text).toContain('Looking at the project.')
  expect(text).toContain('Created hello.txt and changed it.')
  // The summary of the run, as every other surface reads it.
  const summary = RunSummarySchema.parse(
    JSON.parse(
      JSON.stringify(
        db.sqlite
          .prepare("SELECT data FROM events WHERE type = 'run.updated' ORDER BY seq DESC LIMIT 1")
          .get()
          ? JSON.parse(
              String(
                (
                  db.sqlite
                    .prepare(
                      "SELECT data FROM events WHERE type = 'run.updated' ORDER BY seq DESC LIMIT 1",
                    )
                    .get() as { data: string }
                ).data,
              ),
            )
          : {},
      ),
    ),
  )
  expect(summary).toMatchObject({
    runtime: 'claude-code',
    costKind: 'estimated',
    status: 'completed',
  })
  // Frames from the parsed events: a terminal frame for the command and editor frames for the file edits.
  const frames = db.sqlite
    .prepare("SELECT surface, caption FROM watch_frames WHERE agent_id = 'coder' ORDER BY seq")
    .all() as { surface: string; caption: string }[]
  expect(frames.map((frame) => frame.surface)).toEqual(['terminal', 'editor', 'editor'])
  expect(frames[0]!.caption).toBe('Ran ls -la')
  // The CLI session is kept for the next turn.
  expect(db.sqlite.prepare('SELECT session_id FROM coding_sessions').all()).toEqual([
    { session_id: '11111111-1111-4111-8111-111111111111' },
  ])
  // What the process was given.
  const [call] = calls()
  expect(call!.cwd).toBe(workspace)
  expect(call!.args).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits']))
  expect(call!.args.join(' ')).not.toContain('please add a greeting')
  expect(call!.prompt).toContain('please add a greeting')
  expect(call!.env).not.toContain('OPENAI_API_KEY')
  expect(call!.env).not.toContain('SCORE_SECRET_THING')
  expect(call!.env).not.toContain('SCORE_HOME')
  expect(call!.env).toContain('PATH')
  // Deny rules for Score's, Hermes's and SSH folders reach the CLI through its settings file.
  const settingsPath = call!.args[call!.args.indexOf('--settings') + 1]!
  expect(JSON.parse(readFileSync(settingsPath, 'utf8')).permissions.deny).toContain(
    `Read(/${home}/**)`,
  )
})

test('the next turn in the same room resumes the CLI session; another room does not', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder first')
  await finished(1)
  await say('@coder second')
  await finished(2)
  const [first, second] = calls()
  expect(first!.args).not.toContain('--resume')
  expect(second!.args).toEqual(
    expect.arrayContaining(['--resume', '11111111-1111-4111-8111-111111111111']),
  )
})

test('Codex: tokens without cost are shown as unknown, never zero; sandbox flags follow the permission', async () => {
  await addAgent({
    id: 'cx',
    name: 'Cx',
    runtime: 'codex',
    acknowledgeReads: true,
    permission: 'read-only',
  })
  await makeRoom()
  await say('@cx look around')
  await finished()
  const [run] = runs()
  expect(run).toMatchObject({
    runtime: 'codex',
    status: 'completed',
    cost_usd: null,
    cost_kind: 'unknown',
    input_tokens: 2400,
    output_tokens: 150,
  })
  const [call] = calls()
  expect(call!.args).toEqual(expect.arrayContaining(['-s', 'read-only', '-C', workspace]))
  const [reply] = replies()
  expect(reply!.parts.filter((part) => part.kind === 'tool').length).toBe(4)
  expect(
    reply!.parts.some((part) => part.kind === 'text' && part.text.includes('Updated notes.txt')),
  ).toBe(true)
})

test('hand-offs: a coding agent can @mention a Hermes agent and be mentioned by one', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:handoff] build it')
  await finished()
  const handoff = db.sqlite
    .prepare("SELECT agent_id, from_agent_id, hop FROM message_runs WHERE from_agent_id = 'coder'")
    .all()
  expect(handoff).toEqual([{ agent_id: 'reviewer', from_agent_id: 'coder', hop: 1 }])
  // And the other way: a person's message to a Hermes agent mentioning the coder reaches the coder.
  await say('@lead [fixture:handoff] hello @coder')
  await vi.waitFor(() => expect(runs().length).toBe(2), { timeout: 15_000 })
})

test('Stop ends the process and the reply says it was stopped', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:slow] take your time')
  await vi.waitFor(() => expect(runs()[0]?.status).toBe('running'), { timeout: 10_000 })
  await vi.waitFor(() => expect(replies()[0]?.parts.length).toBeGreaterThan(0), { timeout: 10_000 })
  const reply = replies()[0]!
  const stopped = await request('POST', `/api/rooms/${roomId}/messages/${reply.id}/stop`)
  expect(stopped.statusCode, stopped.body).toBe(200)
  await finished()
  expect(runs()[0]!.status).toBe('cancelled')
  const final = replies()[0]!
  expect(final.streaming).toBe(false)
  expect(JSON.stringify(final.parts)).toContain('This run was stopped.')
})

test('a turn that outlives the wall-clock limit is stopped and recorded as failed', async () => {
  await coding.close()
  await app.close()
  await boot({ maxTurnMs: 300, graceMs: 100 })
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:slow] forever')
  await finished()
  expect(runs()[0]).toMatchObject({ status: 'failed' })
  expect(runs()[0]!.error).toMatch(/Stopped after/)
})

test('a failed CLI turn explains itself in the room and keeps the usage it reported', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:error] go')
  await finished()
  expect(runs()[0]).toMatchObject({ status: 'failed', error: 'The model request failed' })
  expect(JSON.stringify(replies()[0]!.parts)).toContain('This run failed: The model request failed')
})

test('output is redacted before it is stored: reply text, tool previews, frames', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:secret] go')
  await finished()
  const stored = JSON.stringify([
    replies().map((reply) => reply.parts),
    db.sqlite.prepare('SELECT * FROM tool_calls').all(),
    db.sqlite.prepare('SELECT * FROM watch_frames').all(),
    db.sqlite.prepare('SELECT data FROM events').all(),
    db.sqlite.prepare('SELECT output, error FROM runs').all(),
  ])
  expect(stored).not.toContain('sk-abcdefghijklmnopqrstuvwx')
  expect(stored).not.toContain('abcdefghijklmnop123456')
  expect(stored).not.toContain('ghp_abcdefghijklmnop1234')
  expect(stored).toContain('[redacted]')
})

test('unknown CLI events are dropped, not stored', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:unknown] go')
  await finished()
  expect(runs()[0]!.status).toBe('completed')
  expect(JSON.stringify(db.sqlite.prepare('SELECT data FROM events').all())).not.toContain(
    'rate_limit_event',
  )
})

test('an untested CLI version runs only after the person confirms that version', async () => {
  await coding.close()
  await app.close()
  await boot({ version: '9.9.9' })
  const agent = await addAgent()
  expect(agent.cli).toMatchObject({ state: 'untested_version', version: '9.9.9', confirmed: false })
  await makeRoom()
  await say('@coder go')
  await vi.waitFor(() => expect(replies()[0]?.parts).toBeDefined(), { timeout: 10_000 })
  await vi.waitFor(
    () => expect(JSON.stringify(replies()[0]!.parts)).toContain('untested version'),
    { timeout: 10_000 },
  )
  expect(runs()).toHaveLength(0)
  // The wrong version can't be confirmed.
  expect(
    (await request('POST', '/api/coding-agents/coder/confirm-version', { version: '1.0.0' }))
      .statusCode,
  ).toBe(409)
  const confirmed = await request('POST', '/api/coding-agents/coder/confirm-version', {
    version: '9.9.9',
  })
  expect(confirmed.json().cli.confirmed).toBe(true)
  await say('@coder go again')
  await finished()
  expect(runs()[0]!.status).toBe('completed')
})

test('the intent is durable before anything spawns', async () => {
  await addAgent()
  await makeRoom()
  const real = coding.locator.command.bind(coding.locator)
  let seen: unknown
  vi.spyOn(coding.locator, 'command').mockImplementation((driver) => {
    seen = db.sqlite
      .prepare("SELECT kind, state FROM command_intents WHERE kind = 'start_coding_run'")
      .get()
    return real(driver)
  })
  await say('@coder go')
  await finished()
  expect(seen).toEqual({ kind: 'start_coding_run', state: 'accepted' })
})

test('Kanban tasks stay Hermes-only: assigning a task to a coding agent is refused', async () => {
  await addAgent()
  const response = await request('POST', '/api/tasks', { title: 'Do it', assignee: 'coder' })
  expect(response.statusCode).toBe(422)
  expect(response.json().error.code).toBe('unsupported')
})

test('Reports: Claude Code spend is estimated, Codex without a cost is unknown and left out of the total', async () => {
  await addAgent()
  await addAgent({ id: 'cx', name: 'Cx', runtime: 'codex', acknowledgeReads: true })
  await makeRoom()
  await say('@coder one')
  await finished(1)
  await say('@cx two')
  await finished(2)
  const report = (await request('GET', '/api/reports?range=7d')).json()
  const byAgent = Object.fromEntries(
    report.byAgent.map((row: { agentId: string }) => [row.agentId, row]),
  )
  expect(byAgent.coder).toMatchObject({
    spendUsd: 0.01,
    spendBasis: 'estimated',
    runtime: 'claude-code',
    runs: 1,
  })
  expect(byAgent.cx).toMatchObject({
    spendUsd: null,
    spendBasis: 'unknown',
    runtime: 'codex',
    runs: 1,
  })
  expect(report.totals.spendEstimated).toBe(true)
  expect(report.totals.spendExcluded).toEqual(['cx'])
})

test('Now and Flow see the coding agent’s runs with their runtime', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder go')
  await finished()
  const now = (await request('GET', '/api/now')).json()
  expect(JSON.stringify(now)).toContain('"coder"')
  expect(JSON.stringify(now)).toContain('"runtime":"claude-code"')
  const briefId = (db.sqlite.prepare('SELECT id FROM briefs').get() as { id: string }).id
  const flow = (await request('GET', `/api/briefs/${briefId}/flow`)).json()
  const node = flow.nodes.find((item: { agentId: string | null }) => item.agentId === 'coder')
  expect(node).toBeDefined()
  const detail = (await request('GET', `/api/flow/nodes/${encodeURIComponent(node.id)}`)).json()
  expect(detail.run).toMatchObject({ runtime: 'claude-code', costKind: 'estimated' })
})

test('removing an agent hides it; a running turn must be stopped first', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:slow] hold')
  await vi.waitFor(() => expect(runs()[0]?.status).toBe('running'), { timeout: 10_000 })
  expect((await request('DELETE', '/api/coding-agents/coder')).statusCode).toBe(409)
  await coding.close()
  await finished()
  expect((await request('DELETE', '/api/coding-agents/coder')).statusCode).toBe(204)
  expect(
    ((await request('GET', '/api/agents')).json().items as { id: string }[]).some(
      (item) => item.id === 'coder',
    ),
  ).toBe(false)
  expect(MessageSchema.safeParse(replies()[0]).success).toBe(true)
  const report = (await request('GET', '/api/reports?range=7d')).json()
  expect(report.byAgent.some((row: { agentId: string }) => row.agentId === 'coder')).toBe(false)
})

test('only the exact tested version runs unasked, and a queued turn is checked again right before it spawns (review: high 4)', async () => {
  await coding.close()
  await app.close()
  await boot({ version: '2.1.1' })
  expect((await addAgent()).cli).toMatchObject({ state: 'untested_version', version: '2.1.1' })
  await coding.close()
  await app.close()
  // The CLI is the tested one when the first turn starts and is upgraded while the second waits its turn.
  await boot({ version: '2.1.295' })
  await makeRoom()
  await say('@coder [fixture:slow] first')
  await vi.waitFor(() => expect(runs()[0]?.status).toBe('running'), { timeout: 10_000 })
  const firstRoom = roomId
  // Another room: the same agent runs one turn at a time, so this one waits in the runtime's queue.
  await makeRoom()
  await say('@coder second')
  await vi.waitFor(() => expect(runs()).toHaveLength(2), { timeout: 10_000 })
  expect(runs()[1]!.status).toBe('queued')
  setEnv('SCORE_CODING_FAKE_VERSION', '2.1.296')
  const first = db.sqlite
    .prepare("SELECT message_id FROM message_runs WHERE room_id = ? AND agent_id = 'coder'")
    .get(firstRoom) as { message_id: string }
  await request('POST', `/api/rooms/${firstRoom}/messages/${first.message_id}/stop`)
  await finished(2)
  expect(runs()[1]).toMatchObject({ status: 'failed' })
  expect(runs()[1]!.error).toMatch(/untested version/)
  // Only the first turn was ever spawned.
  expect(calls().filter((call) => call.prompt.includes('second'))).toHaveLength(0)
}, 30_000)

test('a real server crash leaves the CLI child running; the next start stops its group before admitting turns (review: high 2)', async () => {
  const { spawn } = await import('node:child_process')
  const { isSameProcess } = await import('../../src/runtimes/coding/proc.ts')
  const crashDir = join(dir, 'crash')
  mkdirSync(crashDir)
  const script = fileURLToPath(new URL('./crash-server.ts', import.meta.url))
  const server = spawn(
    process.execPath,
    ['--import', 'tsx', script, crashDir, workspace, FAKE_CLI],
    {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: { ...process.env, SCORE_CODING_FAKE_LOG: log },
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  )
  let childPid = 0
  try {
    childPid = await new Promise<number>((resolve, reject) => {
      let out = ''
      server.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString()
        const match = /READY (\d+)/.exec(out)
        if (match) resolve(Number(match[1]))
      })
      server.on('exit', () => reject(new Error(`server exited early: ${out}`)))
    })
    expect(isSameProcess(childPid, null)).toBe(true)
    server.removeAllListeners('exit')
    server.kill('SIGKILL')
    await new Promise((resolve) => server.on('exit', resolve))
    // The crash: the server is gone, its child is not.
    expect(isSameProcess(childPid, null)).toBe(true)
    const crashDb = openDatabase(join(crashDir, 'score.db'))
    migrate(crashDb, fileURLToPath(new URL('../../migrations/', import.meta.url)))
    const crashIngest = createIngest(crashDb)
    const restarted = new CodingRuntime({
      db: crashDb,
      ingest: crashIngest,
      locator: new CliLocator({ fakeCli: FAKE_CLI }),
      home: join(crashDir, 'home'),
      policy: defaultRootPolicy([join(crashDir, 'home')]),
    })
    expect(
      crashDb.sqlite.prepare('SELECT pid, pgid, start_time FROM coding_processes').get() as {
        pid: number
        pgid: number
        start_time: string
      },
    ).toMatchObject({ pid: childPid, pgid: childPid, start_time: expect.stringMatching(/^\d+$/) })
    expect(await restarted.recover()).toBe(1)
    // Stopped before the run was released, and the record is gone.
    expect(isSameProcess(childPid, null)).toBe(false)
    expect(crashDb.sqlite.prepare('SELECT 1 FROM coding_processes').get()).toBeUndefined()
    expect(crashDb.sqlite.prepare('SELECT status FROM runs').get()).toEqual({
      status: 'interrupted',
    })
    await crashIngest.close()
    crashDb.close()
  } finally {
    server.kill('SIGKILL')
    if (childPid && isSameProcess(childPid, null)) process.kill(-childPid, 'SIGKILL')
  }
}, 60_000)

test('recovery never signals a reused pid: a different start time is left alone (review: high 2)', async () => {
  const { killRecordedGroup } = await import('../../src/runtimes/coding/proc.ts')
  // This test process is alive, but not "the" recorded process.
  expect(
    await killRecordedGroup({ pid: process.pid, pgid: process.pid, startTime: '1' }, 100),
  ).toBe(false)
})

test('shutdown closes admission: nothing is admitted or spawned after close() (review: medium 5)', async () => {
  await addAgent()
  // Racing: the turn is mid-admission when the runtime closes.
  const racing = coding.startRun({ agentId: 'coder', input: 'go', turnId: 'turn-race' })
  const closing = coding.close()
  await racing.catch(() => undefined)
  await closing
  await ingest.drain()
  const rows = runs()
  expect(rows.every((row) => !['queued', 'running'].includes(row.status))).toBe(true)
  expect(() => readFileSync(log, 'utf8')).toThrow()
  // And afterwards.
  await expect(
    coding.startRun({ agentId: 'coder', input: 'go', turnId: 'turn-late' }),
  ).rejects.toMatchObject({ status: 503 })
})

test('a failure while preparing a turn fails the run and the reply instead of leaving it queued (review: medium 6)', async () => {
  await addAgent()
  await makeRoom()
  // The per-agent settings folder cannot be made: a file sits where it must go.
  writeFileSync(join(home, 'coding'), 'in the way')
  await say('@coder go')
  await finished()
  expect(runs()[0]).toMatchObject({ status: 'failed' })
  expect(runs()[0]!.error).toMatch(/Could not prepare/)
  expect(JSON.stringify(replies()[0]!.parts)).toContain('This run failed')
  // The agent is free again (removal is not blocked by a stuck turn).
  expect((await request('DELETE', '/api/coding-agents/coder')).statusCode).toBe(204)
})

test('a failed resume that already emitted events falls back to a fresh session without losing its events (review: medium 7)', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:stale] one')
  await finished(1)
  await say('@coder [fixture:stale] two')
  await finished(2)
  expect(runs()[1]).toMatchObject({
    status: 'completed',
    session_id: '88888888-8888-4888-8888-888888888888',
  })
  expect(db.sqlite.prepare('SELECT session_id FROM coding_sessions').all()).toEqual([
    { session_id: '88888888-8888-4888-8888-888888888888' },
  ])
  expect(JSON.stringify(replies()[1]!.parts)).toContain('Fresh start answer.')
  expect(calls().map((call) => call.args.includes('--resume'))).toEqual([false, true, false])
})

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
