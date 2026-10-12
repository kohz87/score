import { MessageSchema, RoomSchema, type CodingAgent, type Message } from '@score/contract'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { SecurityPassword } from '../../src/auth/security-password.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { CodingJournal } from '../../src/domain/orchestration/coding-journal.ts'
import { codingProjection } from '../../src/domain/orchestration/coding-checkpoint.ts'
import { foldCodingLaunches } from '../../src/domain/orchestration/coding-records.ts'
import { ExecutionJournal } from '../../src/domain/orchestration/journal.ts'
import { messageFromRow } from '../../src/domain/rooms.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { CliLocator } from '../../src/runtimes/coding/cli.ts'
import { processStart } from '../../src/runtimes/coding/proc.ts'
import { spawnCli } from '../../src/runtimes/coding/process.ts'
import { CodingRuntime, type CodingRuntimeDeps } from '../../src/runtimes/coding/service.ts'
import { UnitBackend, type UnitBackendDeps } from '../../src/runtimes/coding/unit-backend.ts'
import { defaultRootPolicy } from '../../src/workspace/policy.ts'
import { FakeSystemd } from '../helpers/fake-systemd.ts'
import { FAKE_CLI } from './coding-fixtures.ts'

// 7.7a part 3: the real CodingRuntime on the unit backend, with the real supervisor and Score socket and a fake
// systemd boundary (test/helpers/fake-systemd.ts). Nothing here starts a real unit.

vi.setConfig({ testTimeout: 40_000 })

const INSTALLATION = 'abcdef0123456789'
let dir: string
let home: string
let workspace: string
let log: string
let namespace: string
let runtimeDir: string
let db: ScoreDb
let ingest: Ingest
let port: FakePort
let fake: FakeSystemd
let journal: ExecutionJournal
let coding: CodingRuntime
let backend: UnitBackend
let app: ReturnType<typeof buildApp>
let headers: { 'x-score-client': string; cookie: string }
let roomId: string
let processLaunches = 0
const secrets = new Map<string, string | undefined>()
const errors: unknown[] = []

function setEnv(name: string, value: string | undefined) {
  if (!secrets.has(name)) secrets.set(name, process.env[name])
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

interface BootOptions {
  maxTurnMs?: number
  graceMs?: number
  stopObserveMs?: number
  reapRetryMs?: number
  unit?: Partial<UnitBackendDeps>
  blocked?: () => string | null
  ingestWrap?: (ingest: Ingest) => Pick<Ingest, 'submit'>
  noUnit?: boolean
  onOrphans?: (names: string[]) => void
}

function makeBackend(options: BootOptions = {}): UnitBackend {
  return new UnitBackend({
    db,
    journal: new CodingJournal(journal),
    installationId: INSTALLATION,
    namespaceDir: namespace,
    runtimeDir,
    home,
    run: fake.run,
    population: fake.population,
    proc: {
      start: processStart,
      cgroup: (_pid, claimed) => claimed,
      boot: () => fake.boot,
    },
    manager: async () => ({ pid: fake.managerPid, start: '1000' }),
    notifySocket: join(runtimeDir, 'notify'),
    notifyBin: null,
    specOverrides: { tickMs: 50, pollMs: 20 },
    pollMs: 20,
    readyTimeoutMs: 10_000,
    proofTimeoutMs: 15_000,
    graceMs: options.graceMs ?? 300,
    onError: (error) => errors.push(error),
    ...(options.blocked ? { blocked: options.blocked } : {}),
    ...options.unit,
  })
}

async function boot(options: BootOptions = {}) {
  setEnv('SCORE_CODING_FAKE_LOG', log)
  backend = makeBackend(options)
  await backend.start()
  const deps: CodingRuntimeDeps = {
    db,
    ingest: options.ingestWrap ? options.ingestWrap(ingest) : ingest,
    locator: new CliLocator({ fakeCli: FAKE_CLI, cacheMs: 0 }),
    home,
    policy: defaultRootPolicy([home]),
    ...(options.maxTurnMs ? { maxTurnMs: options.maxTurnMs } : {}),
    graceMs: options.graceMs ?? 300,
    terminalRetryMs: 10,
    ...(options.stopObserveMs ? { stopObserveMs: options.stopObserveMs } : {}),
    ...(options.reapRetryMs ? { reapRetryMs: options.reapRetryMs } : {}),
    ...(options.noUnit ? {} : { unit: backend }),
    ...(options.onOrphans ? { onOrphans: options.onOrphans } : {}),
    onError: (error) => errors.push(error),
    spawn: (spawnOptions) => {
      processLaunches++
      return spawnCli(spawnOptions)
    },
  }
  coding = new CodingRuntime(deps)
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
  dir = mkdtempSync(join(tmpdir(), 'score-cu-'))
  home = join(dir, 'home')
  workspace = join(dir, 'ws')
  log = join(dir, 'fake-cli.log')
  namespace = join(dir, 'journal', INSTALLATION)
  runtimeDir = join(dir, 'rt')
  mkdirSync(home)
  mkdirSync(workspace)
  mkdirSync(runtimeDir, { mode: 0o700 })
  mkdirSync(namespace, { recursive: true })
  mkdirSync(join(namespace, 'launches'))
  errors.length = 0
  processLaunches = 0
  fake = new FakeSystemd()
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  journal = new ExecutionJournal(namespace, INSTALLATION)
  ingest = createIngest(db)
  port = new FakePort(1, { db }, false)
  await port.start(ingest)
  await boot()
})
afterEach(async () => {
  await coding.close()
  await fake.cleanup()
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
interface RunRow {
  id: string
  status: string
  error: string | null
  output: string | null
  terminal_source: string | null
  profile: string
}
const runs = () =>
  db.sqlite
    .prepare("SELECT * FROM runs WHERE runtime != 'hermes' ORDER BY started_at, rowid")
    .all() as unknown as RunRow[]
async function finished(count = 1) {
  await vi.waitFor(
    () => {
      const rows = runs()
      expect(rows.length).toBeGreaterThanOrEqual(count)
      expect(rows.slice(0, count).every((row) => !['queued', 'running'].includes(row.status))).toBe(
        true,
      )
    },
    { timeout: 20_000, interval: 50 },
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
const cliCalls = () =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { runtime: string; args: string[]; env: string[] })
    : []
interface LaunchRow {
  launch_id: string
  run_id: string
  phase: string
  revoked: number
  may_have_executed: number
  unit: string | null
  invocation_id: string | null
  cgroup: string | null
  backend: string | null
  agent_id: string | null
  runtime: string | null
  receipt_dir: string | null
  stop_cause: string | null
  eligibility: string | null
  held: number
  proof: string | null
  disposition: string | null
}
const launches = () =>
  db.sqlite
    .prepare('SELECT * FROM coding_launches ORDER BY updated_at, launch_id')
    .all() as unknown as LaunchRow[]
const journalKinds = (launchId: string) =>
  journal
    .readOwn()
    .entries.filter((e) => 'launchId' in e && e.launchId === launchId)
    .map((e) => e.kind)
const textOf = (message: Message | undefined) => JSON.stringify(message?.parts ?? [])

// ---- the normal turn -------------------------------------------------------------------------------------------------

test('a Chat turn runs as a supervised unit end to end: journal phases, receipts outside the home, collection', async () => {
  expect(backend.status.kind).toBe('unit')
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:basic] write hello')
  await finished()
  expect(runs()[0]!.error, JSON.stringify(errors.map(String))).toBeNull()
  expect(runs()[0]).toMatchObject({ status: 'completed' })
  expect(textOf(replies()[0])).toContain('Created hello.txt and changed it.')
  // The unit backend launched it: no process-group spawn.
  expect(processLaunches).toBe(0)
  expect(cliCalls()).toHaveLength(1)
  const [launch] = launches()
  expect(launch).toMatchObject({
    backend: 'unit',
    agent_id: 'coder',
    runtime: 'claude-code',
    phase: 'settled',
    may_have_executed: 1,
    revoked: 0,
    held: 0,
    eligibility: 'eligible',
    disposition: 'committed',
  })
  // The exact unit name is stored, in the lead's shape, and the journal's records carry the whole story.
  expect(launch!.unit).toMatch(/^score-abcdef01-c-[0-9a-f]{32}\.service$/)
  expect(launch!.invocation_id).toMatch(/^[0-9a-f]{32}$/)
  expect(journalKinds(launch!.launch_id)).toEqual([
    'launch-requested',
    'armed',
    'releasing',
    'released-seen',
    'ended',
    'settled',
  ])
  // Receipts live beside the journal, outside the home; the spec (with its token) is gone.
  expect(launch!.receipt_dir!.startsWith(namespace)).toBe(true)
  expect(launch!.receipt_dir!.startsWith(home)).toBe(false)
  expect(readdirSync(launch!.receipt_dir!).sort()).toEqual(['ended.json', 'released.json'])
  expect(existsSync(join(runtimeDir, 'score', 'abcdef01', 'launches', launch!.launch_id))).toBe(false)
  // Collected: the unit is gone from the manager.
  expect(fake.units.size).toBe(0)
  expect(errors).toEqual([])
})

test('the CLI environment is built by the supervisor from the spec: Score’s own variables never reach it', async () => {
  setEnv('SCORE_SECRET_SENTINEL', 'x')
  setEnv('ANTHROPIC_API_KEY', 'sk-test')
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:basic] go')
  await finished()
  const env = cliCalls()[0]!.env
  expect(env).not.toContain('SCORE_SECRET_SENTINEL')
  expect(env).not.toContain('ANTHROPIC_API_KEY')
  expect(env).toContain('PATH')
})

// ---- backend selection and the card -----------------------------------------------------------------------------------

test('a failed capability check keeps the process-group backend; Check again follows the host', async () => {
  fake.hooks.lingerOff = true
  const recheck = await request('POST', '/api/coding-agents/backend/check', {})
  expect(recheck.statusCode, recheck.body).toBe(200)
  expect(recheck.json()).toMatchObject({ kind: 'process-group' })
  expect(recheck.json().checks.find((c: { name: string }) => c.name === 'linger')).toMatchObject({
    ok: false,
  })
  expect(recheck.json().note).toContain('tools a coding CLI started may keep running')
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:basic] go')
  await finished()
  expect(runs()[0]!.status).toBe('completed')
  expect(processLaunches).toBe(1)
  expect(launches()).toEqual([])
  fake.hooks.lingerOff = false
  const again = await request('POST', '/api/coding-agents/backend/check', {})
  expect(again.json()).toMatchObject({ kind: 'unit', note: 'Runs as a supervised system service.' })
  const read = await request('GET', '/api/coding-agents/backend')
  expect(read.json().kind).toBe('unit')
})

test('without a unit backend the card says so (fake mode and old hosts)', async () => {
  await coding.close()
  await app.close()
  await boot({ noUnit: true })
  const read = await request('GET', '/api/coding-agents/backend')
  expect(read.json()).toMatchObject({ kind: 'process-group', checks: [] })
})

// ---- the ordering point ----------------------------------------------------------------------------------------------

test('Stop before the release revokes the launch: the CLI never runs and the journal says never ran', async () => {
  await addAgent()
  await makeRoom()
  fake.hooks.afterStart = () => {
    // The person presses Stop while the supervisor is still starting up.
    void coding.stopRun({ agentId: 'coder', runId: runs()[0]!.id })
  }
  await say('@coder [fixture:basic] go')
  await finished()
  expect(runs()[0]!.status).toBe('cancelled')
  expect(cliCalls()).toHaveLength(0)
  const [launch] = launches()
  expect(launch).toMatchObject({ revoked: 1, may_have_executed: 0, phase: 'settled', held: 0 })
  const kinds = journalKinds(launch!.launch_id)
  expect(kinds).toContain('revoked')
  expect(kinds).not.toContain('releasing')
  // No `released` receipt: the supervisor never started anything.
  expect(existsSync(join(launch!.receipt_dir!, 'released.json'))).toBe(false)
})

test('the run’s authorisation is re-evaluated inside the release critical section', async () => {
  await addAgent()
  await makeRoom()
  fake.hooks.afterStart = () => {
    // Another launch of this agent that cannot be proven ended: the agent is held, so this one must not be released.
    db.sqlite
      .prepare(
        `INSERT INTO coding_launches (launch_id, run_id, turn_id, generation, phase, revoked, may_have_executed,
           unit, backend, agent_id, held, journal_n, unsendable, updated_at)
         VALUES ('other', 'other-run', 't', 0, 'releasing', 0, 1, 'score-abcdef01-c-other.service', 'unit', 'coder', 1, 1, 1, ?)`,
      )
      .run(new Date().toISOString())
  }
  await say('@coder [fixture:basic] go')
  await finished()
  const mine = launches().find((l) => l.launch_id !== 'other')!
  expect(mine).toMatchObject({ revoked: 1, may_have_executed: 0 })
  expect(journalKinds(mine.launch_id)).not.toContain('releasing')
  expect(cliCalls()).toHaveLength(0)
})

test('an identity mismatch between the supervisor and systemd revokes the launch and stops the unit', async () => {
  await addAgent()
  await makeRoom()
  fake.hooks.mainPid = process.pid + 1
  await say('@coder [fixture:basic] go')
  await finished()
  expect(runs()[0]!.status).toBe('failed')
  expect(runs()[0]!.error).toContain('identity')
  expect(cliCalls()).toHaveLength(0)
  const [launch] = launches()
  expect(launch).toMatchObject({ revoked: 1, may_have_executed: 0, phase: 'settled' })
  expect(fake.units.size).toBe(0)
})

test('systemd refusing to start the unit fails the turn without a CLI run and records a revoked launch', async () => {
  await addAgent()
  await makeRoom()
  fake.hooks.startFails = 'Failed to start transient service unit'
  await say('@coder [fixture:basic] go')
  await finished()
  expect(runs()[0]!.status).toBe('failed')
  expect(runs()[0]!.error).toContain('refused to start')
  expect(cliCalls()).toHaveLength(0)
  expect(launches()[0]).toMatchObject({ revoked: 1, may_have_executed: 0, phase: 'settled' })
})

// ---- Stop, deadline, socket loss ---------------------------------------------------------------------------------------

test('Stop during a run goes through the protocol; the run is cancelled with ended proof and settled', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:slow] take your time')
  await vi.waitFor(() => expect(runs()[0]?.status).toBe('running'), { timeout: 15_000 })
  await vi.waitFor(() => expect(replies()[0]?.parts.length).toBeGreaterThan(0), { timeout: 15_000 })
  const outcome = await coding.stopRun({ agentId: 'coder', runId: runs()[0]!.id })
  expect(outcome).toBe('stopped')
  await finished()
  expect(runs()[0]!.status).toBe('cancelled')
  expect(textOf(replies()[0])).toContain('This run was stopped.')
  const [launch] = launches()
  expect(launch).toMatchObject({ phase: 'settled', stop_cause: 'user', held: 0 })
  expect(journalKinds(launch!.launch_id)).toContain('releasing')
})

test('the wall-clock deadline is enforced by the supervisor and says how long it was', async () => {
  await coding.close()
  await app.close()
  await boot({ maxTurnMs: 1500 })
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:slow] take your time')
  await finished()
  expect(runs()[0]!.status).toBe('failed')
  expect(runs()[0]!.error).toMatch(/Stopped after/)
  expect(launches()[0]).toMatchObject({ stop_cause: 'deadline', phase: 'settled' })
})

test('socket loss stops the CLI tree, proves the unit ended, and the result is not used', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:slow] take your time')
  await vi.waitFor(() => expect(runs()[0]?.status).toBe('running'), { timeout: 15_000 })
  await vi.waitFor(() => expect(cliCalls()).toHaveLength(1), { timeout: 15_000 })
  const sockets = (backend.socket as unknown as { sockets: Set<{ destroy(): void }> }).sockets
  for (const socket of sockets) socket.destroy()
  await finished()
  expect(runs()[0]!.status).toBe('failed')
  expect(runs()[0]!.error).toMatch(/complete record/)
  const [launch] = launches()
  expect(launch).toMatchObject({ phase: 'settled', held: 0 })
  expect(launch!.proof).toBeTruthy()
})

test('an ingest failure stops the run and makes the result ineligible (the swallowed-error path is gone)', async () => {
  await coding.close()
  await app.close()
  let count = 0
  await boot({
    ingestWrap: (real) => ({
      submit: (observation) => {
        // The second event of the run cannot be saved.
        if (observation.identity.startsWith('coding:') && /:1$/.test(observation.identity) && count++ === 0)
          return Promise.reject(new Error('database is locked'))
        return real.submit(observation)
      },
    }),
  })
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:basic] go')
  await finished()
  expect(runs()[0]!.status).toBe('failed')
  expect(runs()[0]!.error).toMatch(/complete record/)
  expect(launches()[0]).toMatchObject({ phase: 'settled' })
})

// ---- acceptance matrix and hand-offs -----------------------------------------------------------------------------------

test('Claude Code without an explicit success is no result, even with text and a clean exit', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:nosuccess] go')
  await finished()
  expect(runs()[0]!.status).toBe('failed')
  expect(runs()[0]!.error).toContain('without a result Score can use')
  expect(launches()[0]).toMatchObject({ phase: 'settled' })
  expect(launches()[0]!.eligibility).toContain('explicit success')
})

test('Codex: hand-offs read only the final validated agent_message, never earlier commentary', async () => {
  await addAgent({ id: 'cx', name: 'Cx', runtime: 'codex', acknowledgeReads: true })
  await makeRoom()
  await say('@cx [fixture:commentary] go')
  await finished()
  expect(runs()[0]!.status).toBe('completed')
  const handoffs = db.sqlite
    .prepare("SELECT agent_id FROM message_runs WHERE from_agent_id = 'cx'")
    .all()
  expect(handoffs).toEqual([])
  // The visible reply is still the whole conversation; only the authority is narrower.
  expect(textOf(replies()[0])).toContain('Done. Nothing else is needed.')
})

test('Codex: a malformed agent_message invalidates the turn: no result, no hand-off', async () => {
  await addAgent({ id: 'cx', name: 'Cx', runtime: 'codex', acknowledgeReads: true })
  await makeRoom()
  await say('@cx [fixture:malformed] go')
  await finished()
  expect(runs()[0]!.status).toBe('failed')
  expect(
    db.sqlite.prepare("SELECT agent_id FROM message_runs WHERE from_agent_id = 'cx'").all(),
  ).toEqual([])
})

test('Antigravity: SUCCESS with a response completes on the unit backend', async () => {
  setEnv('SCORE_CODING_VERIFIED_ANTIGRAVITY', 'read-only')
  await addAgent({
    id: 'agy1',
    name: 'Agy',
    runtime: 'antigravity',
    permission: 'read-only',
    acknowledgeReads: true,
  })
  await makeRoom()
  await say('@agy1 [fixture:basic] go')
  await finished()
  expect(runs()[0]!.status).toBe('completed')
  expect(launches()[0]).toMatchObject({ phase: 'settled', runtime: 'antigravity' })
})

test('the eligible reply still hands off to another agent', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:handoff] build it')
  await finished()
  const handoff = db.sqlite
    .prepare("SELECT agent_id, from_agent_id, hop FROM message_runs WHERE from_agent_id = 'coder'")
    .all()
  expect(handoff).toEqual([{ agent_id: 'reviewer', from_agent_id: 'coder', hop: 1 }])
})

test('a refused resume starts one fresh launch; the first is settled as retried', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:stale] one')
  await finished()
  await say('@coder [fixture:stale] two')
  await finished(2)
  expect(runs()[1]).toMatchObject({ status: 'completed' })
  const all = launches()
  expect(all).toHaveLength(3)
  expect(all.every((l) => l.phase === 'settled')).toBe(true)
  expect(all.map((l) => l.disposition)).toContain('retried')
})

// ---- launch rate and pause -------------------------------------------------------------------------------------------

test('Score keeps its own launch backoff: too many units in a minute are refused with a sentence', async () => {
  await coding.close()
  await app.close()
  await boot({ unit: { launchesPerMinute: 1 } })
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:basic] one')
  await finished()
  await say('@coder [fixture:basic] two')
  await finished(2)
  expect(runs()[0]!.status).toBe('completed')
  expect(runs()[1]!.status).toBe('failed')
  expect(runs()[1]!.error).toContain('too quickly')
})

test('a fence pauses supervised launching with a sentence the person can act on', async () => {
  await coding.close()
  await app.close()
  await boot({ blocked: () => 'Score is waiting for you to review the coding journal.' })
  await addAgent()
  await makeRoom()
  const response = await request('POST', `/api/rooms/${roomId}/messages`, {
    text: '@coder [fixture:basic] go',
  })
  expect(response.statusCode).toBe(200)
  await vi.waitFor(() => expect(JSON.stringify(replies())).toMatch(/review the coding journal/), {
    timeout: 10_000,
  })
  expect(cliCalls()).toHaveLength(0)
})

// Helpers used by the recovery tests below.
export { codingProjection, foldCodingLaunches, MessageSchema }
