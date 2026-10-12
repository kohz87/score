import {
  MessageSchema,
  RoomSchema,
  RunSummarySchema,
  type CodingAgent,
  type Message,
} from '@score/contract'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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
import { McpAccessStore } from '../../src/mcp/access.ts'
import { CliLocator } from '../../src/runtimes/coding/cli.ts'
import { spawnCli } from '../../src/runtimes/coding/process.ts'
import { CodingRuntime, type CodingRuntimeDeps } from '../../src/runtimes/coding/service.ts'
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

const spawned: number[] = []
// Per-test changes to how the CLI is launched (e.g. signals that never arrive).
let spawnExtra: Partial<Parameters<typeof spawnCli>[0]> = {}
let launches = 0
async function boot(
  options: {
    version?: string
    maxTurnMs?: number
    graceMs?: number
    terminalRetryMs?: number
    killGroup?: CodingRuntimeDeps['killGroup']
    reapRetryMs?: number
    stopObserveMs?: number
    onStop?: (cause: string) => void
    ownsProcessRow?: (runId: string) => boolean
    ingestWrap?: (ingest: Ingest) => Pick<Ingest, 'submit'>
  } = {},
) {
  setEnv('SCORE_CODING_FAKE_LOG', log)
  setEnv('SCORE_CODING_FAKE_VERSION', options.version)
  coding = new CodingRuntime({
    db,
    ingest: options.ingestWrap ? options.ingestWrap(ingest) : ingest,
    locator: new CliLocator({ fakeCli: FAKE_CLI, cacheMs: 0 }),
    home,
    policy: defaultRootPolicy([home]),
    ...(options.maxTurnMs ? { maxTurnMs: options.maxTurnMs } : {}),
    ...(options.graceMs ? { graceMs: options.graceMs } : {}),
    terminalRetryMs: options.terminalRetryMs ?? 10,
    ...(options.killGroup ? { killGroup: options.killGroup } : {}),
    ...(options.reapRetryMs ? { reapRetryMs: options.reapRetryMs } : {}),
    ...(options.stopObserveMs ? { stopObserveMs: options.stopObserveMs } : {}),
    ...(options.onStop ? { onStop: options.onStop } : {}),
    ...(options.ownsProcessRow ? { ownsProcessRow: options.ownsProcessRow } : {}),
    // Counts launches and keeps the pids, so a test can prove nothing started or that a child is gone.
    spawn: (spawnOptions) => {
      launches++
      return spawnCli({
        ...spawnOptions,
        ...spawnExtra,
        onSpawn: (pid) => {
          spawned.push(pid)
          spawnOptions.onSpawn?.(pid)
        },
      })
    },
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
  spawnExtra = {}
  launches = 0
  spawned.length = 0
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
    ['antigravity', 'ready'],
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

test('allow-listed CLI notices are dropped, not stored, and do not cost the result', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:ignorable] go')
  await finished()
  expect(runs()[0]!.status).toBe('completed')
  expect(JSON.stringify(db.sqlite.prepare('SELECT data FROM events').all())).not.toContain(
    'rate_limit_event',
  )
})

test('FW #5: unknown or unparseable CLI records are dropped, not stored, and the answer is not used', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:unknown] go')
  await finished()
  expect(runs()[0]!.status).toBe('failed')
  expect(JSON.stringify(db.sqlite.prepare('SELECT data FROM events').all())).not.toContain(
    'rate_limit_event',
  )
})

test('FW #5: an explicit Claude success followed by a rejected error record is not a result', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:lateerror] go')
  await finished()
  expect(runs()[0]!.status).toBe('failed')
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
    await killRecordedGroup(
      { pid: process.pid, pgid: process.pid, startTime: '1', bootId: null },
      100,
    ),
  ).toBe('gone')
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
const agy = (over: Record<string, unknown> = {}) =>
  addAgent({
    id: 'agy1',
    name: 'Agy',
    runtime: 'antigravity',
    acknowledgeReads: true,
    permission: 'read-only',
    ...over,
  })

test('antigravity: levels are offered only once verified; create and patch refuse the rest', async () => {
  const defaults = (await request('GET', '/api/coding-agents/runtimes'))
    .json()
    .items.find((item: { runtime: string }) => item.runtime === 'antigravity')
  expect(defaults.unverifiedPermissions).toEqual([])
  setEnv('SCORE_CODING_VERIFIED_ANTIGRAVITY', '')
  const info = (await request('GET', '/api/coding-agents/runtimes'))
    .json()
    .items.find((item: { runtime: string }) => item.runtime === 'antigravity')
  expect(info.unverifiedPermissions).toEqual(['read-only', 'workspace-write', 'full'])
  expect(info.warning).toMatch(/browse the web, generate images/)
  const refused = await request('POST', '/api/coding-agents', {
    id: 'agy0',
    name: 'Agy',
    runtime: 'antigravity',
    acknowledgeReads: true,
    permission: 'read-only',
    workspace,
    style,
  })
  expect(refused.statusCode).toBe(422)
  expect(refused.json().error.code).toBe('permission_unverified')
  setEnv('SCORE_CODING_VERIFIED_ANTIGRAVITY', 'read-only,workspace-write')
  const after = (await request('GET', '/api/coding-agents/runtimes'))
    .json()
    .items.find((item: { runtime: string }) => item.runtime === 'antigravity')
  expect(after.unverifiedPermissions).toEqual(['full'])
  await agy()
  const patch = await request('PATCH', '/api/coding-agents/agy1', {
    permission: 'full',
    password: 'x',
  })
  expect(patch.statusCode).toBe(422)
  expect(patch.json().error.code).toBe('permission_unverified')
  // Inside the sandbox (below full access) no read acknowledgement is needed; at full access it is, like Codex.
  const sandboxed = await request('POST', '/api/coding-agents', {
    id: 'agy2',
    name: 'Agy',
    runtime: 'antigravity',
    permission: 'read-only',
    workspace,
    style,
  })
  expect(sandboxed.json().error?.code).not.toBe('acknowledgement_required')
  setEnv('SCORE_CODING_VERIFIED_ANTIGRAVITY', 'read-only,workspace-write,full')
  const fullNoAck = await request('POST', '/api/coding-agents', {
    id: 'agy3',
    name: 'Agy',
    runtime: 'antigravity',
    permission: 'full',
    password: 'x',
    workspace,
    style,
  })
  expect(fullNoAck.json().error.code).toBe('acknowledgement_required')
})

test('antigravity: a turn spawns by argv with the level flags, shows tool cards and Watch frames, tokens without cost', async () => {
  setEnv('SCORE_CODING_VERIFIED_ANTIGRAVITY', 'read-only,workspace-write,full')
  await agy({ permission: 'workspace-write' })
  await makeRoom()
  await say('@agy1 please update the notes')
  await finished()
  expect(runs()[0]).toMatchObject({
    runtime: 'antigravity',
    status: 'completed',
    cost_usd: null,
    cost_kind: 'unknown',
    input_tokens: 2400,
    output_tokens: 310,
    session_id: 'aaaaaaaa-3333-4333-8333-000000000003',
  })
  const [call] = calls()
  expect(call!.args[0]).toBe('-p')
  expect(call!.args).toEqual(
    expect.arrayContaining([
      '--output-format',
      'stream-json',
      '--mode',
      'accept-edits',
      '--sandbox',
    ]),
  )
  expect(call!.prompt).toContain('please update the notes')
  expect(call!.cwd).toBe(workspace)
  const [reply] = replies()
  expect(reply!.parts.filter((part) => part.kind === 'tool').length).toBe(4)
  expect(JSON.stringify(reply!.parts)).toContain('Updated notes.txt and checked the docs.')
  const frames = db.sqlite.prepare('SELECT surface, caption, payload FROM watch_frames').all() as {
    surface: string
    caption: string
    payload: string
  }[]
  expect(frames.map((frame) => frame.surface).sort()).toEqual(['browser', 'editor', 'terminal'])
  // The browser frame lost the query and fragment.
  expect(frames.find((f) => f.surface === 'browser')!.payload).not.toContain('token=abc')
  // The conversation continues in the same room.
  await say('@agy1 [fixture:handoff] again')
  await finished(2)
  expect(calls()[1]!.args).toEqual(
    expect.arrayContaining(['--conversation', 'aaaaaaaa-3333-4333-8333-000000000003']),
  )
})

test('antigravity: refused actions show as a card; SUCCESS without a response is no result, and the note says why (7.7a section 6)', async () => {
  setEnv('SCORE_CODING_VERIFIED_ANTIGRAVITY', 'read-only')
  await agy()
  await makeRoom()
  await say('@agy1 [fixture:denied] list the files')
  await finished()
  expect(runs()[0]!.status).toBe('failed')
  const text = JSON.stringify(replies()[0]!.parts)
  expect(text).toContain('Antigravity refused')
  expect(text).toContain('RunCommand')
  expect(calls()[0]!.args).toEqual(expect.arrayContaining(['--mode', 'plan', '--sandbox']))
})

test('antigravity: the version is read before every turn; a self-updated CLI pauses the agent until confirmed', async () => {
  setEnv('SCORE_CODING_VERIFIED_ANTIGRAVITY', 'read-only')
  await agy()
  await makeRoom()
  await say('@agy1 one')
  await finished()
  setEnv('SCORE_CODING_FAKE_VERSION', '1.4.0')
  await say('@agy1 two')
  await vi.waitFor(() => expect(JSON.stringify(replies())).toMatch(/untested version/), {
    timeout: 10_000,
  })
  expect(calls().length).toBe(1)
  const view = (await request('GET', '/api/coding-agents')).json().items[0]
  expect(view.cli).toMatchObject({ state: 'untested_version', version: '1.4.0', confirmed: false })
  const confirmed = await request('POST', '/api/coding-agents/agy1/confirm-version', {
    version: '1.4.0',
  })
  expect(confirmed.statusCode, confirmed.body).toBe(200)
  await say('@agy1 three')
  await vi.waitFor(() => expect(calls().length).toBe(2), { timeout: 10_000 })
})

test('antigravity: Stop ends the process group and the reply says it was stopped', async () => {
  setEnv('SCORE_CODING_VERIFIED_ANTIGRAVITY', 'read-only')
  await agy()
  await makeRoom()
  await say('@agy1 [fixture:slow] take your time')
  await vi.waitFor(() => expect(runs()[0]?.status).toBe('running'), { timeout: 10_000 })
  await vi.waitFor(() => expect(replies()[0]?.parts.length).toBeGreaterThan(0), { timeout: 10_000 })
  const stopped = await request('POST', `/api/rooms/${roomId}/messages/${replies()[0]!.id}/stop`)
  expect(stopped.statusCode, stopped.body).toBe(200)
  await finished()
  expect(runs()[0]!.status).toBe('cancelled')
  expect(JSON.stringify(replies()[0]!.parts)).toContain('This run was stopped.')
})

test('antigravity: secrets are redacted from the assembled reply, even when split across deltas, and from tool cards and frames', async () => {
  setEnv('SCORE_CODING_VERIFIED_ANTIGRAVITY', 'read-only')
  await agy()
  await makeRoom()
  await say('@agy1 [fixture:secret] go')
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
  expect(stored).toContain('[redacted]')
})

test('antigravity: a failed turn and a stale conversation falls back to a fresh one', async () => {
  setEnv('SCORE_CODING_VERIFIED_ANTIGRAVITY', 'read-only')
  await agy()
  await makeRoom()
  await say('@agy1 [fixture:error] go')
  await finished()
  expect(runs()[0]).toMatchObject({ status: 'failed', error: 'The model request failed' })
  await say('@agy1 [fixture:stale] one')
  await finished(2)
  await say('@agy1 [fixture:stale] two')
  await finished(3)
  expect(runs()[2]).toMatchObject({ status: 'completed' })
  // error (fresh), stale one (resumes, not found, fresh), stale two (same).
  expect(calls().map((call) => call.args.includes('--conversation'))).toEqual([
    false,
    true,
    false,
    true,
    false,
  ])
})

test('antigravity: the quota reading comes from /usage, is cached, and other CLIs have none', async () => {
  setEnv('SCORE_CODING_VERIFIED_ANTIGRAVITY', 'read-only')
  const response = await request('GET', '/api/coding-agents/runtimes/antigravity/usage')
  expect(response.statusCode, response.body).toBe(200)
  const usage = response.json()
  expect(usage.groups[0]).toMatchObject({
    name: 'Gemini Models',
    fiveHourRemainingPercent: 87,
    weeklyRemainingPercent: 75,
  })
  expect(usage.text).toContain('Gemini Models')
  expect(usage.runtime).toBe('antigravity')
  expect((await request('GET', '/api/coding-agents/runtimes/codex/usage')).statusCode).toBe(409)
  setEnv('SCORE_CODING_FAKE_VERSION', '9.9.9')
  // Cached for a minute, so the version change is not noticed yet.
  expect((await request('GET', '/api/coding-agents/runtimes/antigravity/usage')).statusCode).toBe(
    200,
  )
})

test('0052 widens the runtime list and keeps every coding agent row', () => {
  const migrations = fileURLToPath(new URL('../../migrations/', import.meta.url))
  const before = join(dir, 'before-0052')
  mkdirSync(before)
  for (const name of readdirSync(migrations))
    if (Number(name.slice(0, 4)) < 52) copyFileSync(join(migrations, name), join(before, name))
  const old = openDatabase(join(dir, 'old.db'))
  migrate(old, before)
  const at = '2026-10-10T10:00:00.000Z'
  old.sqlite
    .prepare(
      "INSERT INTO coding_agents (id, name, runtime, workspace, permission, color, shape, confirmed_version, created_at, removed_at) VALUES ('c1', 'C', 'codex', '/w', 'read-only', '#000000', 'hexagon', '0.1.0', ?, ?)",
    )
    .run(at, at)
  expect(() =>
    old.sqlite
      .prepare(
        "INSERT INTO coding_agents (id, name, runtime, workspace, permission, color, shape, created_at) VALUES ('a1', 'A', 'antigravity', '/w', 'read-only', '#000000', 'hexagon', ?)",
      )
      .run(at),
  ).toThrow()
  migrate(old, migrations)
  old.sqlite
    .prepare(
      "INSERT INTO coding_agents (id, name, runtime, workspace, permission, color, shape, created_at) VALUES ('a1', 'A', 'antigravity', '/w', 'read-only', '#000000', 'hexagon', ?)",
    )
    .run(at)
  expect(
    old.sqlite
      .prepare('SELECT id, runtime, confirmed_version, removed_at FROM coding_agents ORDER BY id')
      .all(),
  ).toEqual([
    { id: 'a1', runtime: 'antigravity', confirmed_version: null, removed_at: null },
    { id: 'c1', runtime: 'codex', confirmed_version: '0.1.0', removed_at: at },
  ])
  old.close()
})

// The fake CLI logs every start; a version probe has an empty prompt, a launched turn has its prompt.
const launchedTurns = (prompt: string) => {
  try {
    return calls().filter((call) => call.prompt === prompt)
  } catch {
    return []
  }
}
const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('S2-006: the admitted model reaches the CLI and the run row, even if the default changes while queued', async () => {
  await addAgent({ model: 'model-a' })
  await makeRoom()
  await coding.startRun({ agentId: 'coder', input: '[fixture:slow] hold', turnId: 't-first' })
  const second = await coding.startRun({
    agentId: 'coder',
    input: 'go',
    turnId: 't-second',
    model: 'model-b',
  })
  expect(
    (await request('PATCH', '/api/coding-agents/coder', { model: 'model-c' })).statusCode,
  ).toBe(200)
  const row = () =>
    db.sqlite.prepare('SELECT model, status FROM runs WHERE id = ?').get(second.runId) as {
      model: string
      status: string
    }
  expect(row()).toMatchObject({ model: 'model-b', status: 'queued' })
  await coding.stopRun({ agentId: 'coder', runId: runs()[0]!.id })
  await vi.waitFor(() => expect(row().status).toBe('completed'), { timeout: 20_000 })
  const argv = calls().map((call) => call.args)
  const flagged = argv.filter((args) => args.includes('--model'))
  // The first turn ran with the default at its time, the second with what was admitted.
  expect(flagged.map((args) => args[args.indexOf('--model') + 1])).toEqual(['model-a', 'model-b'])
  // (The CLI's own init event later reports the model it really used, so the row is checked while queued.)
})

test('S2-007: Stop while the CLI check is awaited never launches the turn', async () => {
  await addAgent()
  const realDetect = coding.locator.detect.bind(coding.locator)
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  let held = false
  vi.spyOn(coding.locator, 'detect').mockImplementation(async (driver, options) => {
    // The fresh read right before a launch is the one held.
    if (options?.fresh && !held) {
      held = true
      await gate
    }
    return realDetect(driver, options)
  })
  const { runId } = await coding.startRun({ agentId: 'coder', input: 'go', turnId: 't-stop-1' })
  await vi.waitFor(() => expect(held).toBe(true))
  await coding.stopRun({ agentId: 'coder', runId })
  release()
  await vi.waitFor(
    () =>
      expect(
        (db.sqlite.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string })
          .status,
      ).toBe('cancelled'),
    { timeout: 10_000 },
  )
  expect(launches).toBe(0)
  expect(launchedTurns('go')).toEqual([])
})

test('S2-007: Stop while the running observation is awaited never launches the turn', async () => {
  await addAgent()
  const realSubmit = ingest.submit.bind(ingest)
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  let held = false
  vi.spyOn(ingest, 'submit').mockImplementation(async (observation) => {
    if (observation.identity.includes(':running') && !held) {
      held = true
      await gate
    }
    return realSubmit(observation)
  })
  const { runId } = await coding.startRun({ agentId: 'coder', input: 'go', turnId: 't-stop-2' })
  await vi.waitFor(() => expect(held).toBe(true))
  await coding.stopRun({ agentId: 'coder', runId })
  release()
  await vi.waitFor(
    () =>
      expect(
        (db.sqlite.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string })
          .status,
      ).toBe('cancelled'),
    { timeout: 10_000 },
  )
  expect(launches).toBe(0)
  expect(launchedTurns('go')).toEqual([])
})

test('S2-008: a failed terminal save is retried without launching the CLI again', async () => {
  await addAgent()
  await makeRoom()
  const realSubmit = ingest.submit.bind(ingest)
  let rejected = 0
  vi.spyOn(ingest, 'submit').mockImplementation(async (observation) => {
    if (observation.identity.endsWith(':terminal') && rejected < 2) {
      rejected++
      throw new Error('database is busy')
    }
    return realSubmit(observation)
  })
  await say('@coder go')
  await finished()
  expect(rejected).toBe(2)
  expect(launches).toBe(1)
  expect(runs()[0]).toMatchObject({ status: 'completed' })
  expect(replies()[0]!.streaming).toBe(false)
})

const savedOutput = () =>
  (db.sqlite.prepare('SELECT output FROM runs').get() as { output: string }).output
const pendingRows = () =>
  db.sqlite.prepare('SELECT run_id FROM coding_pending_terminals').all().length
const recordRows = () => db.sqlite.prepare('SELECT run_id FROM coding_processes').all().length

test('S3-004: a result that cannot be saved is kept and saved once ingestion recovers, without relaunching', async () => {
  await addAgent()
  await makeRoom()
  const realSubmit = ingest.submit.bind(ingest)
  const errors: unknown[] = []
  ;(coding as unknown as { deps: { onError?: (e: unknown) => void } }).deps.onError = (e) =>
    errors.push(e)
  let failing = true
  let terminalTries = 0
  vi.spyOn(ingest, 'submit').mockImplementation(async (observation) => {
    // Every terminal write fails, normal or degraded.
    if (failing && observation.identity.includes(':terminal')) {
      terminalTries++
      throw new Error('database is busy')
    }
    return realSubmit(observation)
  })
  await say('@coder go')
  await vi.waitFor(() => expect(terminalTries).toBeGreaterThan(6), { timeout: 15_000 })
  // Past the retry budget: still not abandoned, not a silent success, record and process evidence kept.
  expect(pendingRows()).toBe(1)
  expect(recordRows()).toBe(1)
  expect(runs()[0]!.status).not.toBe('completed')
  expect(errors.length).toBeGreaterThan(0)
  failing = false
  await finished()
  expect(runs()[0]).toMatchObject({ status: 'completed' })
  expect(launches).toBe(1)
  expect(replies()[0]!.streaming).toBe(false)
  expect(savedOutput()).toBeTruthy()
  expect(JSON.stringify(replies()[0]!.parts)).toContain(savedOutput())
  expect(pendingRows()).toBe(0)
  expect(recordRows()).toBe(0)
})

test('review #7: a pending terminal record never holds unredacted free text on disk', async () => {
  await addAgent()
  await makeRoom()
  const realSubmit = ingest.submit.bind(ingest)
  let terminalTries = 0
  vi.spyOn(ingest, 'submit').mockImplementation(async (observation) => {
    if (observation.identity.includes(':terminal')) {
      terminalTries++
      throw new Error('database is busy')
    }
    return realSubmit(observation)
  })
  await say('@coder [fixture:secret] go')
  await vi.waitFor(() => expect(terminalTries).toBeGreaterThan(0), { timeout: 15_000 })
  const stored = JSON.stringify(db.sqlite.prepare('SELECT * FROM coding_pending_terminals').all())
  expect(stored).toContain('The key is')
  expect(stored).not.toContain('sk-abcdefghijklmnopqrstuvwx')
  expect(stored).toContain('[redacted]')
})

test('S3-004: a success still pending when Score restarts is interrupted, never promoted (review #13)', async () => {
  await addAgent()
  await makeRoom()
  const realSubmit = ingest.submit.bind(ingest)
  let terminalTries = 0
  vi.spyOn(ingest, 'submit').mockImplementation(async (observation) => {
    if (observation.identity.includes(':terminal')) {
      terminalTries++
      throw new Error('database is busy')
    }
    return realSubmit(observation)
  })
  await say('@coder go')
  await vi.waitFor(() => expect(terminalTries).toBeGreaterThan(6), { timeout: 15_000 })
  expect(pendingRows()).toBe(1)
  await coding.close()
  vi.restoreAllMocks()
  await boot()
  await coding.recover()
  await ingest.flushListeners()
  await ingest.drain()
  // Review 2026-10-12 #13: a pending success is a candidate only; after a restart it is interrupted, never promoted.
  expect(runs()[0]).toMatchObject({ status: 'interrupted' })
  expect(
    db.sqlite.prepare("SELECT 1 FROM message_runs WHERE from_agent_id = 'coder'").all(),
  ).toEqual([])
  expect(launches).toBe(1)
  expect(replies()[0]!.streaming).toBe(false)
  expect(pendingRows()).toBe(0)
  expect(recordRows()).toBe(0)
})

test('S2-004: when recording the process fails, the child is killed and the run ends visibly', async () => {
  await addAgent()
  await makeRoom()
  // A real database failure: the process record can't be inserted.
  db.sqlite.exec(
    "CREATE TRIGGER no_records BEFORE INSERT ON coding_processes BEGIN SELECT RAISE(ABORT, 'database is busy'); END",
  )
  await say('@coder [fixture:slow] go')
  await finished()
  expect(runs()[0]).toMatchObject({ status: 'failed' })
  expect(runs()[0]!.error).toMatch(/Could not prepare the run/)
  expect(spawned).toHaveLength(1)
  await vi.waitFor(() => expect(pidAlive(spawned[0]!)).toBe(false), { timeout: 10_000 })
  expect(replies()[0]!.streaming).toBe(false)
})

// ---- Fix batch W: the runtime claims a process ended only when it can prove it. ----
const rebootWith = async (options: Parameters<typeof boot>[0]) => {
  await coding.close()
  await app.close()
  await boot(options)
}
/** A run that was mid-flight when Score crashed, with the process record it left behind. */
function seedCrashedRun(
  runId: string,
  record?: { pid: number; pgid?: number; start?: string | null },
) {
  const now = new Date().toISOString()
  db.sqlite
    .prepare(
      `INSERT INTO runs (id, profile, origin, score_turn_id, status, model, started_at, updated_at, runtime)
       VALUES (?, 'coder', 'score', ?, 'running', NULL, ?, ?, 'claude-code')`,
    )
    .run(runId, `turn-${runId}`, now, now)
  if (record)
    db.sqlite
      .prepare(
        `INSERT INTO coding_processes (run_id, pid, pgid, start_time, boot_id, created_at) VALUES (?, ?, ?, ?, 'b', ?)`,
      )
      .run(runId, record.pid, record.pgid ?? record.pid, record.start ?? null, now)
}
const processRows = () =>
  db.sqlite.prepare('SELECT run_id, unresolved FROM coding_processes').all() as {
    run_id: string
    unresolved: number
  }[]
const runRow = (id: string) =>
  db.sqlite.prepare('SELECT status, error, terminal_source FROM runs WHERE id = ?').get(id) as {
    status: string
    error: string | null
    terminal_source: string | null
  }

test('W2: recovery keeps the record of a group it could not prove gone, fences the agent, and retries until it is', async () => {
  let outcome: 'alive' | 'unobservable' | 'gone' = 'alive'
  const asked: number[] = []
  await rebootWith({
    reapRetryMs: 20,
    killGroup: async (record) => {
      asked.push(record.pid)
      return outcome
    },
  })
  await addAgent()
  await makeRoom()
  seedCrashedRun('cr_dead', { pid: 4_000_001, start: '5' })
  expect(await coding.recover()).toBe(1)
  // The run ends with a plain note, but the record stays and is marked unresolved.
  expect(runRow('cr_dead')).toMatchObject({ status: 'interrupted', terminal_source: 'unconfirmed' })
  expect(runRow('cr_dead').error).toMatch(/Some of its tools may still be running/)
  expect(processRows()).toEqual([{ run_id: 'cr_dead', unresolved: 1 }])
  // The agent takes no new turn while that record remains, with a clear message.
  const refused = await coding
    .startRun({ agentId: 'coder', input: 'go', turnId: 't-fenced' })
    .catch((error: unknown) => error)
  expect(refused).toMatchObject({ status: 422, code: 'agent_still_stopping' })
  expect(launches).toBe(0)
  // Background retries keep asking; unobservable is no better than alive.
  outcome = 'unobservable'
  await vi.waitFor(() => expect(asked.length).toBeGreaterThanOrEqual(3), { timeout: 5000 })
  expect(processRows()).toHaveLength(1)
  // Once the group is proven gone the record goes and the agent is free again.
  outcome = 'gone'
  await vi.waitFor(() => expect(processRows()).toEqual([]), { timeout: 5000 })
  const { runId } = await coding.startRun({ agentId: 'coder', input: 'go', turnId: 't-free' })
  await vi.waitFor(() => expect(runRow(runId).status).toBe('completed'), { timeout: 15_000 })
})

test('W2: recovery deletes the record only on proof (a gone group)', async () => {
  await rebootWith({ killGroup: async () => 'gone' })
  await addAgent()
  seedCrashedRun('cr_gone', { pid: 4_000_002, start: '5' })
  await coding.recover()
  expect(processRows()).toEqual([])
  expect(runRow('cr_gone').terminal_source).toBeNull()
})

test('W3: a turn whose tools survive every signal still ends, but unconfirmed, with the record kept and the agent fenced', async () => {
  // Group signals never arrive: the tool the CLI left behind stays up past the reaper's deadline.
  spawnExtra = {
    signalGroup: () => 'unavailable',
    signalPid: () => 'unavailable',
    reapSlackMs: 100,
  }
  let gone = false
  await rebootWith({
    graceMs: 50,
    reapRetryMs: 20,
    killGroup: async (record) => {
      if (!gone) return 'alive'
      try {
        process.kill(-record.pgid, 'SIGKILL')
      } catch {
        // already gone
      }
      return 'gone'
    },
  })
  try {
    await addAgent()
    await makeRoom()
    await say('@coder [fixture:leftover] go')
    await finished()
    const row = runs()[0]!
    // The CLI finished cleanly, but "completed" is not evidence while a tool it started may still be running
    // (review 2026-10-12 #2): no ended proof, no success and no reply.
    expect(row.status).toBe('failed')
    expect(runRow(row.id).terminal_source).toBe('unconfirmed')
    expect(
      db.sqlite.prepare("SELECT 1 FROM message_runs WHERE from_agent_id = 'coder'").all(),
    ).toEqual([])
    expect(runRow(row.id).error).toMatch(/Some of its tools may still be running/)
    expect(processRows()).toEqual([{ run_id: row.id, unresolved: 1 }])
    expect(pidAlive(-spawned[0]!)).toBe(true)
    // No new turn, with a clear message in Chat.
    const refused = await coding
      .startRun({ agentId: 'coder', input: 'go', turnId: 't-next' })
      .catch((error: unknown) => error)
    expect(refused).toMatchObject({ status: 422, code: 'agent_still_stopping' })
    // Re-reaping in the background ends it and releases the agent.
    gone = true
    await vi.waitFor(() => expect(processRows()).toEqual([]), { timeout: 5000 })
    expect(pidAlive(-spawned[0]!)).toBe(false)
    spawnExtra = {}
    await coding.startRun({ agentId: 'coder', input: 'go', turnId: 't-after' })
    await finished(2)
  } finally {
    try {
      process.kill(-spawned[0]!, 'SIGKILL')
    } catch {
      // gone
    }
  }
})

test('X4: Stop on a running turn is `stopped` only once the group is proven gone, `unconfirmed` while a survivor lives', async () => {
  // Group signals never arrive, so the turn's process keeps running after Stop.
  spawnExtra = {
    signalGroup: () => 'unavailable',
    signalPid: () => 'unavailable',
    reapSlackMs: 100,
  }
  // The turn gives up on an undeliverable SIGKILL and the service re-reaps; its answer is the test's own observation
  // of the survivor (never a real kill), so load cannot make the first answer a proof.
  await rebootWith({
    graceMs: 50,
    stopObserveMs: 700,
    reapRetryMs: 20,
    killGroup: async (record) => (pidAlive(-record.pgid) ? 'alive' : 'gone'),
  })
  try {
    await addAgent()
    await makeRoom()
    await say('@coder [fixture:slow] hold')
    await vi.waitFor(() => expect(spawned.length).toBe(1), { timeout: 15_000 })
    const runId = runs()[0]!.id
    // The survivor is still alive when Stop's observation window ends.
    expect(await coding.stopRun({ agentId: 'coder', runId })).toBe('unconfirmed')
    expect(pidAlive(-spawned[0]!)).toBe(true)
    // The next turn is held back until the group is really gone.
    // Now it dies (our own child): the same question is answered with proof.
    setTimeout(() => process.kill(-spawned[0]!, 'SIGKILL'), 150)
    expect(await coding.stopRun({ agentId: 'coder', runId })).toBe('stopped')
    expect(pidAlive(-spawned[0]!)).toBe(false)
  } finally {
    try {
      process.kill(-spawned[0]!, 'SIGKILL')
    } catch {
      // gone
    }
  }
}, 60_000)

test('X4: Stop on a turn that has not started anything is stopped at once and nothing launches', async () => {
  await addAgent()
  await makeRoom()
  await coding.startRun({ agentId: 'coder', input: '[fixture:slow] hold', turnId: 't-x4-first' })
  const second = await coding.startRun({ agentId: 'coder', input: 'go', turnId: 't-x4-second' })
  expect(await coding.stopRun({ agentId: 'coder', runId: second.runId })).toBe('stopped')
  await coding.stopRun({ agentId: 'coder', runId: runs()[0]!.id })
  await vi.waitFor(() => expect(runRow(second.runId).status).toBe('cancelled'), {
    timeout: 20_000,
  })
  expect(launchedTurns('go')).toEqual([])
})

test('X2: unobservable records are marked releasable; Release deletes them, never signals, and leaves an audit row', async () => {
  let outcome: 'alive' | 'unobservable' = 'unobservable'
  await rebootWith({ reapRetryMs: 20, killGroup: async () => outcome })
  await addAgent()
  await makeRoom()
  const signalled: unknown[] = []
  const realKill = process.kill
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
    if (sig !== 0 && sig !== undefined) signalled.push([pid, sig])
    return realKill(pid, sig as NodeJS.Signals)
  }) as typeof process.kill)
  seedCrashedRun('cr_unclear', { pid: 4_000_011, start: '5' })
  await coding.recover()
  const held = async () =>
    ((await request('GET', '/api/coding-agents')).json() as { items: CodingAgent[] }).items[0]!
      .heldGroups
  expect(await held()).toEqual([{ runId: 'cr_unclear', pgid: 4_000_011, canRelease: true }])
  // Nothing to release while the cause is not "can't tell whose": a group that is merely still alive.
  outcome = 'alive'
  await vi.waitFor(async () => expect((await held())[0]!.canRelease).toBe(false), { timeout: 5000 })
  expect((await request('POST', '/api/coding-agents/coder/release', {})).statusCode).toBe(409)
  outcome = 'unobservable'
  await vi.waitFor(async () => expect((await held())[0]!.canRelease).toBe(true), { timeout: 5000 })
  // Release needs a paired browser.
  const anonymous = await app.inject({
    method: 'POST',
    url: '/api/coding-agents/coder/release',
    headers: { 'x-score-client': 'web' },
    payload: {},
  })
  expect(anonymous.statusCode).toBe(401)
  const released = await request('POST', '/api/coding-agents/coder/release', {})
  expect(released.statusCode, released.body).toBe(200)
  expect((released.json() as CodingAgent).heldGroups).toEqual([])
  expect(processRows()).toEqual([])
  expect(signalled).toEqual([])
  const audit = db.sqlite.prepare('SELECT * FROM coding_releases').all() as {
    agent_id: string
    run_id: string
    pgid: number
    released_by: string
    released_at: string
  }[]
  expect(audit).toHaveLength(1)
  expect(audit[0]).toMatchObject({ agent_id: 'coder', run_id: 'cr_unclear', pgid: 4_000_011 })
  expect(audit[0]!.released_by).toMatch(/^[0-9a-f]{16}/)
  expect(Date.parse(audit[0]!.released_at)).not.toBeNaN()
  // A release is not termination evidence: the run stays unconfirmed. The agent takes turns again.
  expect(runRow('cr_unclear').terminal_source).toBe('unconfirmed')
  const { runId } = await coding.startRun({
    agentId: 'coder',
    input: 'go',
    turnId: 't-after-release',
  })
  await vi.waitFor(() => expect(runRow(runId).status).toBe('completed'), { timeout: 15_000 })
  // Nothing left to release.
  expect((await request('POST', '/api/coding-agents/coder/release', {})).statusCode).toBe(409)
  expect((await request('POST', '/api/coding-agents/nobody/release', {})).statusCode).toBe(404)
})

test('W3: the process record goes with the terminal result and never before it', async () => {
  await addAgent()
  await makeRoom()
  const realSubmit = ingest.submit.bind(ingest)
  const recordWhenSaved: boolean[] = []
  // Every attempt to save the result fails, like a crash between reaping and the write.
  vi.spyOn(ingest, 'submit').mockImplementation(async (observation) => {
    if (observation.identity.includes(':terminal')) {
      recordWhenSaved.push(processRows().length === 1)
      throw new Error('database is busy')
    }
    return realSubmit(observation)
  })
  await say('@coder go')
  await vi.waitFor(() => expect(recordWhenSaved.length).toBeGreaterThanOrEqual(2), {
    timeout: 15_000,
  })
  // The group was reaped, yet the record is still there: the result was not saved, so the work is not "released".
  expect(processRows()).toHaveLength(1)
  expect(recordWhenSaved.every(Boolean)).toBe(true)
  vi.restoreAllMocks()
})

test('W3: a saved result releases the record in the same step', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder go')
  await finished()
  expect(runs()[0]).toMatchObject({ status: 'completed' })
  expect(processRows()).toEqual([])
  expect(runRow(runs()[0]!.id).terminal_source).toBeNull()
})

test('W3: when recording the process fails the error waits for the proven end of the group', async () => {
  const { SpawnRecordError } = await import('../../src/runtimes/coding/process.ts')
  const { scanGroup, processStart: startOf } = await import('../../src/runtimes/coding/proc.ts')
  let pid = 0
  const boom = new Error('cannot record')
  let thrown: unknown
  try {
    spawnCli({
      file: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: workspace,
      env: { PATH: process.env.PATH ?? '' },
      stdin: '',
      parser: { parse: () => [], stats: { unknown: 0, malformed: 0 } },
      onEvent: async () => undefined,
      onSpawn: (spawnedPid) => {
        pid = spawnedPid
        throw boom
      },
    })
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(SpawnRecordError)
  expect((thrown as InstanceType<typeof SpawnRecordError>).original).toBe(boom)
  // The caller can wait for the proof; once it settles the whole group is gone.
  expect(await (thrown as InstanceType<typeof SpawnRecordError>).terminated).toBe(true)
  expect(pidAlive(pid) && startOf(pid) !== null && scanGroup(pid).members.length > 0).toBe(false)
})

test('W4: Stop on a run this process no longer holds says what really happened', async () => {
  await addAgent()
  await makeRoom()
  let outcome: 'alive' | 'gone' = 'alive'
  await rebootWith({ stopObserveMs: 100, reapRetryMs: 20, killGroup: async () => outcome })
  const stop = (runId: string) => coding.stopRun({ agentId: 'coder', runId })
  // A queued run never launched: cancelled, with proof.
  const now = new Date().toISOString()
  db.sqlite
    .prepare(
      `INSERT INTO runs (id, profile, origin, score_turn_id, status, started_at, updated_at, runtime)
       VALUES ('cr_queued', 'coder', 'score', 'turn-q', 'queued', ?, ?, 'claude-code')`,
    )
    .run(now, now)
  expect(await stop('cr_queued')).toBe('stopped')
  expect(runRow('cr_queued').status).toBe('cancelled')
  // Already ended, nothing recorded: nothing to stop.
  expect(await stop('cr_queued')).toBe('not_running')
  expect(await stop('cr_unknown')).toBe('not_running')
  // Running but this process has no record of it and no process row: can't be sure.
  seedCrashedRun('cr_orphan')
  expect(await stop('cr_orphan')).toBe('unconfirmed')
  // A process row that can't be proven gone: unconfirmed, and the kill keeps going.
  seedCrashedRun('cr_alive', { pid: 4_000_003, start: '5' })
  expect(await stop('cr_alive')).toBe('unconfirmed')
  expect(processRows().map((row) => row.run_id)).toContain('cr_alive')
  // Proven gone: stopped, and the record is released.
  outcome = 'gone'
  await vi.waitFor(() => expect(processRows().map((row) => row.run_id)).not.toContain('cr_alive'), {
    timeout: 5000,
  })
  seedCrashedRun('cr_dead', { pid: 4_000_004, start: '5' })
  expect(await stop('cr_dead')).toBe('stopped')
  expect(processRows().map((row) => row.run_id)).not.toContain('cr_dead')
  // A run held in memory is simply told to stop.
  const live = await coding.startRun({
    agentId: 'coder',
    input: '[fixture:slow] hold',
    turnId: 't-live',
  })
  expect(await stop(live.runId)).toBe('stopped')
  await vi.waitFor(() => expect(runRow(live.runId).status).toBe('cancelled'), { timeout: 15_000 })
})

test('W5: the resume fallback runs only for the CLI’s own refusal, with nothing observed, and shares the deadline', async () => {
  await addAgent()
  await makeRoom()
  // A generic "not found" is a failure, not permission to run the turn again.
  await say('@coder [fixture:basic] one')
  await finished(1)
  await say('@coder [fixture:notfound] two')
  await finished(2)
  expect(runs()[1]).toMatchObject({ status: 'failed' })
  expect(runs()[1]!.error).toMatch(/File not found/)
  expect(calls().filter((call) => call.prompt.includes('two'))).toHaveLength(1)
  // The CLI refused the session but had already produced output: it ran, so it is not run again.
  await say('@coder [fixture:observed] three')
  await finished(3)
  expect(runs()[2]).toMatchObject({ status: 'failed' })
  expect(calls().filter((call) => call.prompt.includes('three'))).toHaveLength(1)
})

test('W5: a refused resume that nothing ran behind starts fresh once, within the first turn’s deadline', async () => {
  await rebootWith({ maxTurnMs: 6000, graceMs: 100 })
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:basic] one')
  await finished(1)
  // The resumed launch refuses after 3 s; the fresh one needs 4 s but only ~3 s of the 6 are left.
  await say('@coder [fixture:slowstale] two')
  await finished(2)
  expect(
    calls()
      .filter((call) => call.prompt.includes('two'))
      .map((call) => call.args.includes('--resume')),
  ).toEqual([true, false])
  expect(runs()[1]).toMatchObject({ status: 'failed' })
  expect(processRows()).toEqual([])
})

// ---- 7.7a part 3: the acceptance matrix holds on the fallback backend too -----------------------------------------------

test('fallback: a clean exit with text but no explicit success is no result (the exit-zero fallback is gone)', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:nosuccess] go')
  await finished()
  expect(runs()[0]).toMatchObject({ status: 'failed' })
  expect(runs()[0]!.error).toContain('without a result Score can use')
})

test('fallback: an event that cannot be saved makes the result not used, however the CLI ended', async () => {
  let failed = false
  await rebootWith({
    ingestWrap: (real) => ({
      submit: (observation) => {
        // The first saved event of the run fails once.
        if (!failed && /^coding:cr_[^:]+:0$/.test(observation.identity)) {
          failed = true
          return Promise.reject(new Error('database is locked'))
        }
        return real.submit(observation)
      },
    }),
  })
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:basic] go')
  await finished()
  expect(failed).toBe(true)
  expect(runs()[0]).toMatchObject({ status: 'failed' })
  expect(runs()[0]!.error).toMatch(/complete record/)
})

test('fallback: hand-offs read only the final validated Codex message', async () => {
  await addAgent({ id: 'cx', name: 'Cx', runtime: 'codex', acknowledgeReads: true })
  await makeRoom()
  await say('@cx [fixture:commentary] go')
  await finished()
  expect(runs()[0]).toMatchObject({ status: 'completed' })
  expect(
    db.sqlite.prepare("SELECT agent_id FROM message_runs WHERE from_agent_id = 'cx'").all(),
  ).toEqual([])
  await say('@cx [fixture:malformed] go')
  await finished(2)
  expect(runs()[1]).toMatchObject({ status: 'failed' })
})

test('a turn the journal says may already have run is refused and never spawned (7.7a code review #4)', async () => {
  await addAgent()
  db.sqlite
    .prepare(
      `INSERT INTO coding_launches (launch_id, run_id, turn_id, generation, phase, revoked, may_have_executed, waiver,
         journal_n, unsendable, updated_at) VALUES ('l-seen', 'r-seen', 'turn-seen', 1, 'releasing', 0, 1, 0, 1, 1, '2026-10-12T00:00:00.000Z')`,
    )
    .run()
  await expect(
    coding.startRun({ agentId: 'coder', input: 'go', turnId: 'turn-seen' }),
  ).rejects.toMatchObject({ status: 409, code: 'turn_witnessed' })
  expect(() => readFileSync(log, 'utf8')).toThrow()
})

// ---- FZ1 (re-review 2026-10-12 #5, #9, #12, #17): the process-group fallback end to end -----------------------------------

test('#12: a labelled secret in a tool name never reaches the tool card, the run row or its tool list', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:toolsecret] go')
  await finished()
  const stored = JSON.stringify([
    db.sqlite.prepare('SELECT * FROM tool_calls').all(),
    db.sqlite.prepare('SELECT tools_used FROM runs').all(),
    db.sqlite.prepare('SELECT data FROM events').all(),
  ])
  expect(stored).not.toContain('review-sentinel')
})

test('#9: a success record with no terminating newline is no success: the run fails and says the record is incomplete', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:partial] go')
  await finished()
  expect(runs()[0]!.status).toBe('failed')
  expect(runs()[0]!.error).toContain('complete record')
  expect(JSON.stringify(replies()[0]!.parts)).not.toContain('Done.')
})

test('#5: a long secret value on stderr never reaches the failure notice or any stored text', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:stderrleak] go')
  await finished()
  expect(runs()[0]!.status).toBe('failed')
  const stored = JSON.stringify([
    runs(),
    replies().map((reply) => reply.parts),
    db.sqlite.prepare('SELECT data FROM events').all(),
  ])
  expect(stored).not.toMatch(/v{20}/)
})

test('#17: Stop, the wall-clock limit and shutdown each hand their cause to the stop hook', async () => {
  const causes: string[] = []
  await coding.close()
  await app.close()
  await boot({ onStop: (cause) => causes.push(cause) })
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:slow] take your time')
  await vi.waitFor(() => expect(replies()[0]?.parts.length).toBeGreaterThan(0), { timeout: 10_000 })
  const reply = replies()[0]!
  await request('POST', `/api/rooms/${roomId}/messages/${reply.id}/stop`)
  await finished()
  expect(causes).toEqual(['user'])
})

test('#17: the wall-clock limit reaches the stop hook as `deadline`', async () => {
  const causes: string[] = []
  await coding.close()
  await app.close()
  await boot({ maxTurnMs: 300, graceMs: 100, onStop: (cause) => causes.push(cause) })
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:slow] forever')
  await finished()
  expect(causes).toEqual(['deadline'])
})

test('#17: a failing stop hook is reported and the stop goes on', async () => {
  const errors: unknown[] = []
  await coding.close()
  await app.close()
  await boot({
    maxTurnMs: 300,
    graceMs: 100,
    onStop: () => {
      throw new Error('journal down')
    },
  })
  ;(coding as unknown as { deps: { onError?: (e: unknown) => void } }).deps.onError = (e) =>
    errors.push(e)
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:slow] forever')
  await finished()
  expect(runs()[0]!.status).toBe('failed')
  expect(errors.length).toBeGreaterThan(0)
})

test('#6: a process row the installation does not own is never signalled, in recovery or by the reaper, and is not ours', async () => {
  const asked: string[] = []
  await rebootWith({
    reapRetryMs: 20,
    ownsProcessRow: (runId) => runId !== 'cr_inherited',
    killGroup: async (record) => {
      asked.push(`${record.pid}`)
      return 'gone'
    },
  })
  await addAgent()
  seedCrashedRun('cr_inherited', { pid: 4_000_011, start: '5' })
  seedCrashedRun('cr_ours', { pid: 4_000_012, start: '5' })
  await coding.recover()
  await new Promise((r) => setTimeout(r, 150))
  expect(asked).toEqual(['4000012'])
  // Left as it was: not signalled, not deleted, not marked unresolved.
  expect(processRows()).toEqual([{ run_id: 'cr_inherited', unresolved: 0 }])
  // The reaper path (a Stop for that run) doesn't signal it either.
  await coding.stopRun({ agentId: 'coder', runId: 'cr_inherited' })
  expect(asked).toEqual(['4000012'])
})
