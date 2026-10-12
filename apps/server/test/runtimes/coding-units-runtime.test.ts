import { RoomSchema, type CodingAgent, type Message } from '@score/contract'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { spawn } from 'node:child_process'
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
import { ExecutionJournal } from '../../src/domain/orchestration/journal.ts'
import { messageFromRow } from '../../src/domain/rooms.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { CliLocator } from '../../src/runtimes/coding/cli.ts'
import { bootId, processStart } from '../../src/runtimes/coding/proc.ts'
import { spawnCli } from '../../src/runtimes/coding/process.ts'
import { CodingRuntime, type CodingRuntimeDeps } from '../../src/runtimes/coding/service.ts'
import { RunSession } from '../../src/runtimes/coding/coding-socket.ts'
import { writeReceipt } from '../../src/runtimes/coding/supervisor.mjs'
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
      start: (pid) => fake.procStart(pid) ?? processStart(pid),
      cgroup: (_pid, claimed) => claimed,
      boot: () => fake.boot,
    },
    manager: async () => ({ pid: fake.managerPid, start: '1000' }),
    signalSupervisor: fake.signal,
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
    // The installation journal also witnesses the process-group fallback (review 2026-10-12 #6).
    journal: new CodingJournal(journal),
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
const journalKinds = (launchId: string) => {
  const read = journal.readOwn()
  if (!read.ok) throw new Error(read.reason)
  return read.entries.filter((e) => 'launchId' in e && e.launchId === launchId).map((e) => e.kind)
}
const journalOf = (runId: string) => {
  const read = journal.readOwn()
  if (!read.ok) throw new Error(read.reason)
  return read.entries.filter((e) => 'runId' in e && e.runId === runId) as unknown as {
    kind: string
    mayHaveExecuted: boolean
    cgroup?: string
  }[]
}
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
  expect(readdirSync(launch!.receipt_dir!).sort()).toEqual([
    'ended.json',
    'identity.json',
    'released.json',
  ])
  expect(existsSync(join(runtimeDir, 'score', 'abcdef01', 'launches', launch!.launch_id))).toBe(
    false,
  )
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
  // No unit launch; the fallback launch is projected into the database with its routing (re-review #6) and checkpoint.
  expect(launches().filter((l) => l.backend === 'unit')).toEqual([])
  expect(launches()).toHaveLength(1)
  expect(launches()[0]).toMatchObject({
    backend: 'process-group',
    agent_id: 'coder',
    runtime: 'claude-code',
    phase: 'settled',
    may_have_executed: 1,
  })
  const entries = journal.readOwn()
  if (!entries.ok) throw new Error(entries.reason)
  expect(db.sqlite.prepare('SELECT seq FROM coding_journal_checkpoint WHERE id = 1').get()).toEqual(
    { seq: Math.max(...entries.entries.map((e) => e.n)) },
  )
  // Review 2026-10-12 #6: the fallback launch is witnessed in the journal outside the home, with its process identity.
  const witnessed = journalOf(runs()[0]!.id)
  expect(witnessed.map((e) => e.kind)).toEqual([
    'launch-requested',
    'armed',
    'releasing',
    'released-seen',
    'ended',
    'settled',
  ])
  expect(witnessed[2]).toMatchObject({ mayHaveExecuted: true })
  expect(witnessed[3]!.cgroup).toMatch(/^process-group:\{"pid":\d+,/)
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
        if (
          observation.identity.startsWith('coding:') &&
          /:1$/.test(observation.identity) &&
          count++ === 0
        )
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

test('settled follows the terminal commit: a result that cannot be saved yet is delivered later, and only then settled', async () => {
  await coding.close()
  await app.close()
  let failures = 0
  await boot({
    ingestWrap: (real) => ({
      submit: (observation) => {
        // The first six attempts at the terminal result fail (more than the foreground budget of five).
        if (observation.identity.endsWith(':terminal') && failures++ < 6)
          return Promise.reject(new Error('database is locked'))
        return real.submit(observation)
      },
    }),
  })
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:basic] go')
  // The run has ended (proof obtained) but its result is still waiting: the launch is `ended`, not `settled`.
  await vi.waitFor(() => expect(launches()[0]?.phase).toBe('ended'), { timeout: 15_000 })
  expect(runs()[0]!.status).toBe('running')
  expect(db.sqlite.prepare('SELECT run_id FROM coding_pending_terminals').all()).toHaveLength(1)
  await vi.waitFor(() => expect(launches()[0]?.phase).toBe('settled'), { timeout: 15_000 })
  expect(runs()[0]!.status).toBe('completed')
  expect(db.sqlite.prepare('SELECT run_id FROM coding_pending_terminals').all()).toEqual([])
})

test('review #6: a fallback group whose database record was lost is stopped from its journal identity', async () => {
  await boot({ noUnit: true })
  await addAgent()
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
    detached: true,
    stdio: 'ignore',
  })
  try {
    const pid = child.pid!
    const identity = { launchId: 'fb-1', runId: 'cr_lost', turnId: 't-lost', generation: 0 }
    const cj = new CodingJournal(journal)
    expect(cj.requestLaunch(identity).ok).toBe(true)
    cj.arm('fb-1', { disposition: 'process-group' })
    cj.release('fb-1', () => true)
    cj.releasedSeen('fb-1', {
      cgroup: `process-group:${JSON.stringify({ pid, start: processStart(pid), boot: bootId() })}`,
    })
    // No coding_processes row exists (a restored older database).
    expect(db.sqlite.prepare('SELECT 1 FROM coding_processes').all()).toEqual([])
    await coding.recover()
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 10_000 })
    expect(journalKinds('fb-1').slice(-2)).toEqual(['ended', 'settled'])
  } finally {
    try {
      process.kill(-child.pid!, 'SIGKILL')
    } catch {
      // gone
    }
  }
})

// ---- recovery: journal <-> database <-> units <-> receipts -------------------------------------------------------------

let seeded = 0
function seedRun(runId: string, status = 'running') {
  const now = new Date().toISOString()
  db.sqlite
    .prepare(
      `INSERT INTO runs (id, profile, origin, score_turn_id, status, model, started_at, updated_at, runtime)
       VALUES (?, 'coder', 'score', ?, ?, NULL, ?, ?, 'claude-code')`,
    )
    .run(runId, `turn-${runId}`, status, now, now)
}
type Upto = 'requested' | 'armed' | 'releasing' | 'released-seen'
function seedLaunch(
  upto: Upto,
  over: {
    withUnit?: boolean
    receipts?: string[]
    /** Replaces a receipt's content (default: a valid body for this launch). */
    bodies?: Record<string, string>
    manager?: string | null
    runStatus?: string
    cgroup?: string
    /** Skip the identity file (a launch whose supervisor identity Score never recorded). */
    noIdentity?: boolean
  } = {},
) {
  const n = ++seeded
  const launchId = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const runId = `cr_seed${n}`
  seedRun(runId, over.runStatus)
  const unit = `score-abcdef01-c-${launchId.replaceAll('-', '')}.service`
  const receiptDir = join(namespace, 'launches', launchId)
  mkdirSync(receiptDir, { recursive: true })
  const manager = over.manager === undefined ? `${fake.boot}|${fake.managerPid}:1000` : over.manager
  const project = codingProjection(db, undefined, (sqlite) => {
    sqlite
      .prepare(
        "UPDATE coding_launches SET backend = 'unit', agent_id = 'coder', runtime = 'claude-code', receipt_dir = ?, manager = ? WHERE launch_id = ?",
      )
      .run(receiptDir, manager, launchId)
  })
  const cj = new CodingJournal(journal)
  expect(
    cj.requestLaunch({ launchId, runId, turnId: `turn-${runId}`, generation: 0 }, project, { unit })
      .ok,
  ).toBe(true)
  const live = over.withUnit ? fake.addUnit(unit) : undefined
  if (upto !== 'requested') {
    expect(
      cj.arm(
        launchId,
        {
          unit,
          invocationId: live?.invocationId ?? 'f'.repeat(32),
          cgroup: over.cgroup ?? `/fake/${unit}`,
        },
        project,
      ).ok,
    ).toBe(true)
  }
  if (upto !== 'requested' && !over.noIdentity) {
    // The identity file Score writes beside the journal at verification (re-review #5/#6): the supervisor to signal,
    // the boot and the manager. A seeded launch without a live unit gets a supervisor that no longer exists.
    const cgroup = over.cgroup ?? `/fake/${unit}`
    const managerText = manager ?? `${fake.boot}|${fake.managerPid}:1000`
    const pid = live?.pid ?? 2_000_000 + n
    writeReceipt(receiptDir, 'identity.json', {
      launch: launchId,
      generation: 0,
      at: Date.now(),
      unit,
      invocationId: live?.invocationId ?? 'f'.repeat(32),
      cgroup,
      boot: over.manager === null ? null : managerText.split('|')[0],
      manager:
        over.manager === null
          ? null
          : {
              pid: Number(managerText.split('|')[1]!.split(':')[0]),
              start: managerText.split(':')[1]!,
            },
      supervisor: { pid, start: live?.start ?? String(100_000 + pid) },
    })
  }
  if (upto === 'releasing' || upto === 'released-seen')
    expect(cj.release(launchId, () => true, project).ok).toBe(true)
  if (upto === 'released-seen') expect(cj.releasedSeen(launchId, {}, project).ok).toBe(true)
  for (const name of over.receipts ?? []) {
    const valid = JSON.stringify({
      launch: launchId,
      generation: 0,
      at: Date.now(),
      ...(name === 'ended.json'
        ? { code: 0, signal: null, stopCause: null, survivorsKilled: false }
        : { supervisorPid: 1 }),
    })
    writeFileSync(join(receiptDir, name), over.bodies?.[name] ?? valid)
  }
  return { launchId, runId, unit, live }
}
const launchRow = (id: string) => launches().find((l) => l.launch_id === id)!
const runRow = (id: string) => runs().find((r) => r.id === id)!

test('recovery: a launch that never reached releasing is revoked by the journal alone; the run is interrupted', async () => {
  await addAgent()
  const seed = seedLaunch('requested')
  expect(await coding.recover()).toBe(1)
  expect(runRow(seed.runId)).toMatchObject({ status: 'interrupted' })
  expect(launchRow(seed.launchId)).toMatchObject({
    revoked: 1,
    may_have_executed: 0,
    phase: 'settled',
    held: 0,
  })
  expect(journalKinds(seed.launchId)).toEqual(['launch-requested', 'revoked', 'ended', 'settled'])
})

test('recovery: an armed launch with a live unit is revoked and its supervisor stopped through its pinned identity', async () => {
  await addAgent()
  const seed = seedLaunch('armed', { withUnit: true })
  await coding.recover()
  expect(fake.units.has(seed.unit)).toBe(false)
  expect(launchRow(seed.launchId)).toMatchObject({
    revoked: 1,
    may_have_executed: 0,
    phase: 'settled',
  })
  // The stop went to the recorded supervisor (pid + start), never to the unit by name (re-review #5).
  expect(fake.signals.filter((s) => s.delivered)).toEqual([
    { pid: seed.live!.pid, start: seed.live!.start, signal: 'SIGINT', delivered: true },
  ])
  expect(fake.calls.filter((c) => c.includes('stop'))).toEqual([])
})

test('recovery: a released launch with a live unit is stopped, proven ended and settled; released-seen needs the receipt', async () => {
  await addAgent()
  const seen = seedLaunch('releasing', { withUnit: true, receipts: ['released.json'] })
  const unseen = seedLaunch('releasing', { withUnit: true })
  await coding.recover()
  expect(runRow(seen.runId)).toMatchObject({ status: 'interrupted' })
  expect(launchRow(seen.launchId)).toMatchObject({
    phase: 'settled',
    may_have_executed: 1,
    held: 0,
  })
  expect(journalKinds(seen.launchId)).toEqual([
    'launch-requested',
    'armed',
    'releasing',
    'released-seen',
    'ended',
    'settled',
  ])
  expect(journalKinds(unseen.launchId)).toEqual([
    'launch-requested',
    'armed',
    'releasing',
    'ended',
    'settled',
  ])
  expect(fake.units.size).toBe(0)
})

test('recovery: a run whose result was saved but whose launch was never settled is settled now', async () => {
  await addAgent()
  const seed = seedLaunch('releasing', { runStatus: 'completed' })
  await coding.recover()
  expect(runRow(seed.runId).status).toBe('completed')
  expect(launchRow(seed.launchId)).toMatchObject({ phase: 'settled' })
})

test('recovery: a database that lost the launch row (an older backup) is rebuilt from the journal', async () => {
  await addAgent()
  const seed = seedLaunch('releasing')
  db.sqlite.prepare('DELETE FROM coding_launches WHERE launch_id = ?').run(seed.launchId)
  await coding.recover()
  expect(launchRow(seed.launchId)).toMatchObject({
    backend: 'unit',
    phase: 'settled',
    may_have_executed: 1,
  })
})

test('recovery: may have executed and not provable is unconfirmed, holds the agent, and a later proof releases it', async () => {
  await coding.close()
  await app.close()
  await boot({ unit: { recoverProofMs: 300 }, reapRetryMs: 30 })
  await addAgent()
  fake.hooks.ignoreStop = true
  const seed = seedLaunch('releasing', { withUnit: true })
  await coding.recover()
  expect(runRow(seed.runId)).toMatchObject({
    status: 'interrupted',
    terminal_source: 'unconfirmed',
  })
  expect(runRow(seed.runId).error).toMatch(/Some of its tools may still be running/)
  expect(launchRow(seed.launchId)).toMatchObject({ held: 1, phase: 'releasing' })
  const refused = await coding
    .startRun({ agentId: 'coder', input: 'go', turnId: 't-held' })
    .catch((error: unknown) => error)
  expect(refused).toMatchObject({ status: 422, code: 'agent_still_stopping' })
  const view = (await request('GET', '/api/coding-agents')).json().items[0]
  expect(view.heldGroups).toEqual([
    { runId: seed.runId, pgid: 0, canRelease: false, unit: seed.unit },
  ])
  // The unit finally obeys: the background loop proves it ended and the agent is free again.
  fake.hooks.ignoreStop = false
  await vi.waitFor(
    () => expect(launchRow(seed.launchId)).toMatchObject({ phase: 'settled', held: 0 }),
    {
      timeout: 15_000,
    },
  )
  expect((await request('GET', '/api/coding-agents')).json().items[0].heldGroups).toEqual([])
})

test('recovery: systemd that cannot be read holds every open launch and the person may release them', async () => {
  await coding.close()
  await app.close()
  await boot({ unit: { recoverProofMs: 200 }, reapRetryMs: 30 })
  await addAgent()
  const seed = seedLaunch('releasing', { withUnit: true })
  fake.hooks.showFails = true
  await coding.recover()
  expect(runRow(seed.runId)).toMatchObject({
    status: 'interrupted',
    terminal_source: 'unconfirmed',
  })
  await vi.waitFor(
    async () => {
      const held = (await request('GET', '/api/coding-agents')).json().items[0].heldGroups
      expect(held).toEqual([{ runId: seed.runId, pgid: 0, canRelease: true, unit: seed.unit }])
    },
    { timeout: 15_000 },
  )
  fake.hooks.showFails = false
  const signalsBefore = fake.signals.length
  const released = await request('POST', '/api/coding-agents/coder/release', {})
  expect(released.statusCode, released.body).toBe(200)
  const row = launchRow(seed.launchId)
  expect(row.held).toBe(0)
  expect(row.proof).toBe('waiver')
  expect(db.sqlite.prepare('SELECT agent_id, run_id FROM coding_releases').all()).toEqual([
    { agent_id: 'coder', run_id: seed.runId },
  ])
  // Nothing was signalled by the release itself, and the journal says the launch is settled as waived.
  expect(fake.signals.length).toBe(signalsBefore)
  expect(row.disposition).toBe('waived')
  expect(journalKinds(seed.launchId).at(-1)).toBe('waived') // Release is a waiver record, phase settled
})

test('recovery: after a manager cold restart the receipts and the recorded cgroup decide, never missing metadata', async () => {
  await coding.close()
  await app.close()
  await boot({ unit: { population: () => 'unknown', recoverProofMs: 200 }, reapRetryMs: 5_000 })
  await addAgent()
  // The unit is gone and the cgroup cannot be read: the supervisor's own `ended` receipt (written only once the
  // payload was empty) is the witness.
  const old = `${fake.boot}|1111:5`
  const witnessed = seedLaunch('releasing', {
    manager: old,
    receipts: ['released.json', 'ended.json'],
  })
  const unwitnessed = seedLaunch('releasing', { manager: old, receipts: ['released.json'] })
  // The same manager with the unit missing and the cgroup unreadable is NOT enough: missing metadata proves nothing.
  const sameManager = seedLaunch('releasing', { receipts: ['released.json', 'ended.json'] })
  await coding.recover()
  expect(launchRow(witnessed.launchId)).toMatchObject({
    phase: 'settled',
    proof: 'receipt',
    held: 0,
  })
  expect(launchRow(unwitnessed.launchId)).toMatchObject({ phase: 'releasing', held: 1 })
  expect(runRow(unwitnessed.runId).terminal_source).toBe('unconfirmed')
  expect(launchRow(sameManager.launchId)).toMatchObject({ phase: 'releasing', held: 1 })
})

test('recovery: a changed boot means everything ended', async () => {
  await coding.close()
  await app.close()
  await boot({ unit: { population: () => 'unknown' } })
  await addAgent()
  const seed = seedLaunch('releasing', { manager: 'boot-OLD|99:5' })
  await coding.recover()
  expect(launchRow(seed.launchId)).toMatchObject({ phase: 'settled', proof: 'boot-change' })
})

test('recovery: a unit with this installation’s prefix and no journal launch is an orphan: never adopted, admission paused', async () => {
  const orphans: string[][] = []
  await coding.close()
  await app.close()
  await boot({ onOrphans: (names) => orphans.push(names) })
  await addAgent()
  const stray = fake.addUnit('score-abcdef01-c-deadbeefdeadbeefdeadbeefdeadbeef.service')
  await coding.recover()
  expect(orphans).toEqual([[stray.name]])
  // Not stopped, not adopted.
  expect(fake.units.has(stray.name)).toBe(true)
  expect(fake.calls.some((c) => c.includes('stop') && c.includes(stray.name))).toBe(false)
  const refused = await coding
    .startRun({ agentId: 'coder', input: 'go', turnId: 't-orphan' })
    .catch((error: unknown) => error)
  expect(refused).toMatchObject({ status: 422, code: 'coding_paused' })
  expect(backend.orphaned).toEqual([stray.name])
  // The person removes the stray service and presses Check again: admission resumes.
  fake.forget(stray.name)
  await request('POST', '/api/coding-agents/backend/check', {})
  expect(backend.orphaned).toEqual([])
  expect(backend.block()).toBeNull()
})

test('recovery: both backends are reconciled after an upgrade (a recorded process group and a unit launch)', async () => {
  await coding.close()
  await app.close()
  const asked: number[] = []
  await rebootWithKill(async (record) => {
    asked.push(record.pid)
    return 'gone' as const
  })
  await addAgent()
  seedRun('cr_oldstyle')
  db.sqlite
    .prepare(
      `INSERT INTO coding_processes (run_id, pid, pgid, start_time, boot_id, created_at) VALUES ('cr_oldstyle', 4000001, 4000001, '5', 'b', ?)`,
    )
    .run(new Date().toISOString())
  const seed = seedLaunch('releasing', { withUnit: true })
  expect(await coding.recover()).toBe(2)
  expect(asked).toEqual([4000001])
  expect(runRow('cr_oldstyle').status).toBe('interrupted')
  expect(runRow(seed.runId).status).toBe('interrupted')
  expect(launchRow(seed.launchId).phase).toBe('settled')
  expect(db.sqlite.prepare('SELECT run_id FROM coding_processes').all()).toEqual([])
})

async function rebootWithKill(killGroup: CodingRuntimeDeps['killGroup']) {
  backend = makeBackend()
  await backend.start()
  coding = new CodingRuntime({
    db,
    ingest,
    locator: new CliLocator({ fakeCli: FAKE_CLI, cacheMs: 0 }),
    home,
    policy: defaultRootPolicy([home]),
    unit: backend,
    killGroup,
    terminalRetryMs: 10,
    onError: (error) => errors.push(error),
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

test('Stop on a supervised run this process no longer holds stops the unit by name and ends the run', async () => {
  await addAgent()
  const seed = seedLaunch('releasing', { withUnit: true, receipts: ['released.json'] })
  const outcome = await coding.stopRun({ agentId: 'coder', runId: seed.runId })
  expect(outcome).toBe('stopped')
  expect(fake.units.size).toBe(0)
  expect(runRow(seed.runId).status).toBe('cancelled')
  expect(launchRow(seed.launchId)).toMatchObject({ phase: 'settled', held: 0 })
})

test('the user can stop a run whose unit ignores the stop: the answer is unconfirmed and the loop goes on', async () => {
  await coding.close()
  await app.close()
  await boot({ stopObserveMs: 300, reapRetryMs: 30, unit: { proofTimeoutMs: 200 } })
  await addAgent()
  fake.hooks.ignoreStop = true
  const seed = seedLaunch('releasing', { withUnit: true })
  const outcome = await coding.stopRun({ agentId: 'coder', runId: seed.runId })
  expect(outcome).toBe('unconfirmed')
  await vi.waitFor(() => expect(launchRow(seed.launchId).held).toBeGreaterThan(0), {
    timeout: 5000,
  })
  fake.hooks.ignoreStop = false
  await vi.waitFor(() => expect(launchRow(seed.launchId).phase).toBe('settled'), {
    timeout: 15_000,
  })
  expect(runRow(seed.runId).status).toBe('cancelled')
})

// ---- review fixes FX4 (#5, #9, #14) ----------------------------------------------------------------------------------

test('#9: recovery never stops a unit it did not verify: an unarmed launch has no recorded invocation to match', async () => {
  await addAgent()
  // A launch that never armed, while a unit with its name is running: Score cannot tell whose invocation that is.
  const seed = seedLaunch('requested', { withUnit: true })
  await coding.recover()
  expect(fake.calls.some((c) => c.includes('stop') && c.includes(seed.unit))).toBe(false)
  expect(fake.units.get(seed.unit)?.active).toBe('active')
  // Unresolved, not guessed: the launch is held and the person may release it.
  expect(launchRow(seed.launchId).held).toBeGreaterThan(0)
  expect(launchRow(seed.launchId).phase).not.toBe('settled')
})

test('#9: an unarmed launch whose unit is gone is still proven to have never started', async () => {
  await addAgent()
  const seed = seedLaunch('requested')
  expect(await coding.recover()).toBe(1)
  expect(launchRow(seed.launchId)).toMatchObject({ phase: 'settled', held: 0 })
})

test('#14: the stop cause is saved before the stop frame is sent', async () => {
  const seen: (string | null)[] = []
  const original = RunSession.prototype.stop
  vi.spyOn(RunSession.prototype, 'stop').mockImplementation(function (
    this: RunSession,
    cause: string,
  ) {
    seen.push(launches()[0]?.stop_cause ?? null)
    return original.call(this, cause)
  })
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:slow] take your time')
  await vi.waitFor(() => expect(replies()[0]?.parts.length).toBeGreaterThan(0), { timeout: 15_000 })
  await coding.stopRun({ agentId: 'coder', runId: runs()[0]!.id })
  await finished()
  expect(seen).toEqual(['user'])
})

test('#14: a stop on a launch Score no longer holds saves its cause before the unit is stopped', async () => {
  await addAgent()
  const seed = seedLaunch('releasing', { withUnit: true, receipts: ['released.json'] })
  const live = seed.live!
  const handler = live.stopHandler
  const seen: (string | null)[] = []
  live.stopHandler = () => {
    seen.push(launchRow(seed.launchId).stop_cause)
    handler?.()
  }
  await coding.stopRun({ agentId: 'coder', runId: seed.runId })
  expect(seen).toEqual(['user'])
})

test('#5: a fence raised while the unit starts stops the release: the CLI never runs', async () => {
  let fenced = false
  await coding.close()
  await app.close()
  await boot({ blocked: () => (fenced ? 'Score is waiting for you to review the journal.' : null) })
  await addAgent()
  await makeRoom()
  fake.hooks.afterStart = () => {
    fenced = true
  }
  await say('@coder [fixture:basic] go')
  await finished()
  expect(cliCalls()).toHaveLength(0)
  const [launch] = launches()
  expect(launch).toMatchObject({ revoked: 1, may_have_executed: 0 })
  expect(journalKinds(launch!.launch_id)).not.toContain('releasing')
})

test('#5: a disabled backend (forced fallback) still reconciles units and enforces the barriers', async () => {
  await coding.close()
  await app.close()
  fake.calls.length = 0
  await boot({ unit: { disabled: 'The fallback is forced.' } })
  expect(backend.status.kind).toBe('process-group')
  expect(backend.status.note).toContain('The fallback is forced.')
  expect(backend.usable()).toBe(false)
  await addAgent()
  const stray = fake.addUnit('score-abcdef01-c-deadbeefdeadbeefdeadbeefdeadbeef.service')
  await coding.recover()
  // The orphan inventory ran although nothing is supervised, and the barrier answers.
  expect(backend.orphaned).toEqual([stray.name])
  expect(backend.block()).toMatch(/isn’t accounted for/)
  // A disabled backend runs no capability probe and starts nothing.
  expect(fake.calls.some((c) => c[0]!.endsWith('systemd-run'))).toBe(false)
})

test('#5: an unresolved installation reconciles nothing and keeps the barrier up', async () => {
  await coding.close()
  await app.close()
  await boot({
    unit: { disabled: 'This installation isn’t resolved yet.', unresolved: true },
    blocked: () => 'The installation isn’t resolved.',
  })
  const stray = fake.addUnit('score-00000000-c-deadbeefdeadbeefdeadbeefdeadbeef.service')
  expect(await backend.recover()).toEqual({ launches: [], orphans: [], unreadable: null })
  expect(backend.block()).toBe('The installation isn’t resolved.')
  expect(fake.calls.some((c) => c.includes('stop') && c.includes(stray.name))).toBe(false)
})

test('#8 reader: an empty, truncated, foreign or wrong-kind receipt is never proof', async () => {
  await coding.close()
  await app.close()
  await boot({ unit: { population: () => 'unknown', recoverProofMs: 200 }, reapRetryMs: 5_000 })
  await addAgent()
  const old = `${fake.boot}|1111:5`
  const mk = (ended: string) =>
    seedLaunch('releasing', {
      manager: old,
      receipts: ['released.json', 'ended.json'],
      bodies: { 'ended.json': ended },
    })
  const good = mk(
    JSON.stringify({ launch: 'x', generation: 0, at: 1, code: 0, signal: null, stopCause: null }),
  )
  // `good` names the wrong launch: rebuild it properly below; the invalid ones must all stay held.
  const empty = mk('')
  const truncated = mk('{"launch":"')
  const array = mk('[]')
  const wrongKind = mk(JSON.stringify({ launch: 'x', generation: 0, at: 1, supervisorPid: 1 }))
  await coding.recover()
  for (const seed of [good, empty, truncated, array, wrongKind])
    expect(launchRow(seed.launchId)).toMatchObject({ phase: 'releasing', held: 1 })
})

test('#8 reader: an empty released receipt does not record released-seen', async () => {
  await addAgent()
  const seed = seedLaunch('releasing', {
    withUnit: true,
    bodies: { 'released.json': '' },
    receipts: ['released.json'],
  })
  await coding.recover()
  expect(launchRow(seed.launchId).phase).toBe('settled')
  expect(journalKinds(seed.launchId)).not.toContain('released-seen')
})

test('#8 reader: an unreadable manager identity is uncertain, not a changed incarnation', async () => {
  await coding.close()
  await app.close()
  await boot({
    unit: { population: () => 'unknown', recoverProofMs: 200, manager: async () => null },
    reapRetryMs: 5_000,
  })
  await addAgent()
  const seed = seedLaunch('releasing', {
    manager: `${fake.boot}|1111:5`,
    receipts: ['released.json', 'ended.json'],
  })
  await coding.recover()
  expect(launchRow(seed.launchId)).toMatchObject({ phase: 'releasing', held: 1 })
})

// The service must consult the barrier whichever backend launches: `service.ts` calls `unit.block()` only when
// `unit.usable()` (an FX2 file). This documents the gap; when service.ts calls block() unconditionally, delete `.fails`.
test('#5: the fallback launch is refused while a barrier is up (needs the service.ts change)', async () => {
  await coding.close()
  await app.close()
  await boot({
    unit: { disabled: 'The fallback is forced.' },
    blocked: () => 'Score is waiting for you to review the coding journal.',
  })
  await addAgent()
  const refused = await coding
    .startRun({ agentId: 'coder', input: 'go', turnId: 't-barrier' })
    .catch((error: unknown) => error)
  expect(refused).toMatchObject({ status: 422, code: 'coding_paused' })
})

// ---- second review round (FY1) ---------------------------------------------------------------------------------------

/** Everything Score stored about the runs, as one searchable string. */
function storedText(): string {
  const parts: string[] = []
  for (const table of ['runs', 'messages', 'coding_launches'])
    parts.push(JSON.stringify(db.sqlite.prepare(`SELECT * FROM ${table}`).all()))
  return parts.join('\n')
}

test('#3 (re-review): the eligibility note is redacted before it reaches SQLite', async () => {
  setEnv('SCORE_CODING_VERIFIED_ANTIGRAVITY', 'read-only')
  await addAgent({
    id: 'agy1',
    name: 'Agy',
    runtime: 'antigravity',
    permission: 'read-only',
    acknowledgeReads: true,
  })
  await makeRoom()
  await say('@agy1 [fixture:deniedsecret] go')
  await finished()
  expect(launches()[0]!.eligibility).toBeTruthy()
  expect(launches()[0]!.eligibility).not.toContain('review-sentinel')
  expect(storedText()).not.toContain('review-sentinel')
})

test('#4 (re-review): a long secret value on stderr never reaches the failure notice, the run or the launch row', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:stderrleak] go')
  await finished()
  expect(runs()[0]!.status).toBe('failed')
  expect(runs()[0]!.error).toContain('ended without a result Score can use')
  expect(storedText()).not.toMatch(/v{20}/)
})

test('#3 (re-review): a record that cannot be validated after turn.completed still makes the result unusable', async () => {
  await addAgent({ id: 'cx', name: 'Cx', runtime: 'codex', acknowledgeReads: true })
  await makeRoom()
  await say('@cx [fixture:lateloss] go')
  await finished()
  expect(runs()[0]!.status).toBe('failed')
  expect(runs()[0]!.error).toContain('without a result Score can use')
  expect(launches()[0]!.eligibility).toContain('could not validate')
})

test('#5 (re-review): a barrier raised after admission stops the fallback release: no releasing record, no CLI', async () => {
  let fenced = false
  await coding.close()
  await app.close()
  await boot({
    unit: { disabled: 'The fallback is forced.' },
    blocked: () => (fenced ? 'Score is waiting for you to review the coding journal.' : null),
    ingestWrap: (real) => ({
      submit: (observation) => {
        // The turn is admitted and goes `running`; the fence rises while it waits to be released.
        if (observation.identity.endsWith(':running')) fenced = true
        return real.submit(observation)
      },
    }),
  })
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:basic] go')
  await finished()
  expect(processLaunches).toBe(0)
  expect(cliCalls()).toHaveLength(0)
  const kinds = (journal.readOwn() as { entries: { kind: string }[] }).entries.map((e) => e.kind)
  expect(kinds).not.toContain('releasing')
  expect(runs()[0]!.status).toBe('failed')
})

test('#5 (re-review): recovery signals only the recorded supervisor; a foreign invocation under the same name is never stopped', async () => {
  await addAgent()
  // The recorded supervisor is gone; another invocation now occupies the unit name.
  const seed = seedLaunch('releasing', { receipts: ['released.json'] })
  const foreign = fake.addUnit(seed.unit)
  await coding.recover()
  expect(foreign.running).toBe(true)
  expect(fake.units.has(seed.unit)).toBe(true)
  expect(fake.calls.filter((c) => c.includes('stop'))).toEqual([])
  expect(fake.signals.every((s) => !s.delivered)).toBe(true)
  // Not proven ended (the name belongs to a different invocation): the agent stays held.
  expect(launchRow(seed.launchId)).toMatchObject({ held: expect.any(Number), phase: 'releasing' })
  expect(launchRow(seed.launchId).held).toBeGreaterThan(0)
})

test('#5 (re-review): a launch whose supervisor identity was never recorded is never stopped; it stays uncertain and releasable', async () => {
  await addAgent()
  const seed = seedLaunch('releasing', { withUnit: true, noIdentity: true })
  await coding.recover()
  expect(seed.live!.running).toBe(true)
  expect(fake.signals).toEqual([])
  expect(fake.calls.filter((c) => c.includes('stop'))).toEqual([])
  await vi.waitFor(() => expect(launchRow(seed.launchId).held).toBe(2), { timeout: 15_000 })
  expect(seed.live!.running).toBe(true)
})

test('#6 (re-review): the proof checks the recorded cgroup; a control group that disagrees proves nothing', async () => {
  await addAgent()
  const seed = seedLaunch('releasing', { withUnit: true, receipts: ['released.json'] })
  // systemd now names an empty, different control group for the unit while the recorded one is populated.
  seed.live!.controlGroup = '/fake/somewhere-else'
  seed.live!.active = 'inactive'
  const proof = await backend.proveEnded(seed.launchId, { timeoutMs: 200 })
  expect(proof.proven).toBe(false)
  expect(proof.detail).toMatch(/control group differs/)
})

test('#6 (re-review): the boot and the manager are kept beside the journal; a restored database that lost them still decides by the receipt', async () => {
  await coding.close()
  await app.close()
  await boot({ unit: { population: () => 'unknown', recoverProofMs: 200 }, reapRetryMs: 5_000 })
  await addAgent()
  const old = `${fake.boot}|1111:5`
  const seed = seedLaunch('releasing', { manager: old, receipts: ['released.json', 'ended.json'] })
  // The database lost its copy of the manager identity (an older backup).
  db.sqlite
    .prepare('UPDATE coding_launches SET manager = NULL WHERE launch_id = ?')
    .run(seed.launchId)
  await coding.recover()
  expect(launchRow(seed.launchId)).toMatchObject({ phase: 'settled', proof: 'receipt', held: 0 })
})

test('#6 (re-review): a recorded boot that differs means ended, and nothing is signalled', async () => {
  await addAgent()
  const seed = seedLaunch('releasing', { manager: 'boot-OLD|99:5' })
  await coding.recover()
  expect(launchRow(seed.launchId)).toMatchObject({ phase: 'settled', proof: 'boot-change' })
  expect(fake.signals).toEqual([])
})

test('#2 (re-review): a launch the journal does not own is never stopped, reset or settled', async () => {
  await addAgent()
  const seed = seedLaunch('releasing', { withUnit: true, receipts: ['released.json'] })
  vi.spyOn(CodingJournal.prototype, 'isOwned').mockReturnValue(false)
  await coding.recover()
  expect(seed.live!.running).toBe(true)
  expect(fake.signals).toEqual([])
  expect(fake.calls.filter((c) => c.includes('stop') || c.includes('reset-failed'))).toEqual([])
  expect(journalKinds(seed.launchId)).toEqual(['launch-requested', 'armed', 'releasing'])
})

test('#2 (re-review): a unit of another installation is never stopped or reset, whatever its journal record says', async () => {
  await addAgent()
  const other = 'score-11111111-c-deadbeefdeadbeefdeadbeefdeadbeef.service'
  const unit = fake.addUnit(other)
  // The unit-level stop and reset refuse a name outside the caller's prefix before looking at systemd.
  const { stopUnit, resetUnit } = await import('../../src/runtimes/coding/units.ts')
  fake.calls.length = 0
  expect(await stopUnit(fake.run, other, unit.invocationId, 'score-abcdef01-c-')).toBe('unknown')
  expect(await resetUnit(fake.run, other, unit.invocationId, 'score-abcdef01-c-')).toBe('unknown')
  expect(fake.calls).toEqual([])
})

test('#14 (re-review): the stop cause is journaled before any signal reaches the supervisor', async () => {
  await addAgent()
  const seed = seedLaunch('releasing', { withUnit: true, receipts: ['released.json'] })
  const order: string[] = []
  const original = CodingJournal.prototype.recordStop
  vi.spyOn(CodingJournal.prototype, 'recordStop').mockImplementation(function (
    this: CodingJournal,
    ...args: Parameters<CodingJournal['recordStop']>
  ) {
    order.push(`journal:${args[1]}`)
    return original.apply(this, args)
  })
  const handler = seed.live!.stopHandler
  seed.live!.stopHandler = () => {
    order.push('signal')
    handler?.()
  }
  await coding.stopRun({ agentId: 'coder', runId: seed.runId })
  expect(order).toEqual(['journal:user', 'signal'])
})

test('#8 (re-review): Release settles the launch in the journal first; a restart never stops it again', async () => {
  await coding.close()
  await app.close()
  await boot({ unit: { recoverProofMs: 200 }, reapRetryMs: 30 })
  await addAgent()
  const seed = seedLaunch('releasing', { withUnit: true })
  fake.hooks.showFails = true
  await coding.recover()
  await vi.waitFor(
    async () =>
      expect((await request('GET', '/api/coding-agents')).json().items[0].heldGroups).toEqual([
        expect.objectContaining({ canRelease: true }),
      ]),
    { timeout: 15_000 },
  )
  const waive = vi.spyOn(CodingJournal.prototype, 'waive')
  expect((await request('POST', '/api/coding-agents/coder/release', {})).statusCode).toBe(200)
  expect(waive).toHaveBeenCalledWith(seed.launchId, expect.any(String), expect.anything())
  expect(journalKinds(seed.launchId).at(-1)).toBe('waived')
  const before = fake.signals.length
  fake.hooks.showFails = false
  await backend.recover()
  expect(fake.signals.length).toBe(before)
})

// ---- the process-group fallback's reconciliation (re-review #6) -------------------------------------------------------

function seedFallback(over: { identity?: boolean; witness?: boolean; run?: boolean } = {}) {
  const n = ++seeded
  const launchId = `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`
  const runId = `cr_fb${n}`
  if (over.run !== false) seedRun(runId)
  const cj = new CodingJournal(journal)
  expect(cj.requestLaunch({ launchId, runId, turnId: `turn-${runId}`, generation: 0 }).ok).toBe(
    true,
  )
  cj.arm(launchId, { disposition: 'process-group' })
  cj.release(launchId, () => true)
  return { cj, launchId, runId }
}

test('#6 (re-review): a released fallback launch with no recorded identity fences the agent and can be released', async () => {
  await boot({ noUnit: true })
  await addAgent()
  const seed = seedFallback()
  await coding.recover()
  expect(db.sqlite.prepare('SELECT unresolved, unobservable FROM coding_processes').all()).toEqual([
    { unresolved: 1, unobservable: 1 },
  ])
  const refused = await coding
    .startRun({ agentId: 'coder', input: 'go', turnId: 't-fenced' })
    .catch((error: unknown) => error)
  expect(refused).toMatchObject({ status: 422, code: 'agent_still_stopping' })
  const view = (await request('GET', '/api/coding-agents')).json().items[0]
  expect(view.heldGroups).toEqual([{ runId: seed.runId, pgid: 0, canRelease: true }])
  // The person's release waives the launch in the journal.
  expect((await request('POST', '/api/coding-agents/coder/release', {})).statusCode).toBe(200)
  expect(journalKinds(seed.launchId).at(-1)).toBe('waived')
  expect(db.sqlite.prepare('SELECT 1 FROM coding_processes').all()).toEqual([])
})

test('#6 (re-review): surviving tools recorded beside the journal are stopped even when the database lost the group, and a group that survives fences everyone', async () => {
  await boot({ noUnit: true })
  await addAgent()
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
    detached: true,
    stdio: 'ignore',
  })
  try {
    const pid = child.pid!
    // A restored database: no run row, no process row. The leader is long gone (no identity); a tool survives.
    const seed = seedFallback({ run: false })
    const { writeFallbackWitness } = await import('../../src/runtimes/coding/fallback-witness.ts')
    writeFallbackWitness(namespace, {
      launch: seed.launchId,
      runId: seed.runId,
      turnId: `turn-${seed.runId}`,
      agentId: 'coder',
      members: [{ pid, start: processStart(pid)! }],
      at: Date.now(),
    })
    await coding.recover()
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 10_000 })
    expect(journalKinds(seed.launchId).slice(-2)).toEqual(['ended', 'settled'])
  } finally {
    try {
      process.kill(-child.pid!, 'SIGKILL')
    } catch {
      // gone
    }
  }
})

test('#6 (re-review): an unresolved fallback group whose run row is gone fences every agent and is visible', async () => {
  await coding.close()
  await app.close()
  await boot({ noUnit: true })
  await addAgent()
  const seed = seedFallback({ run: false })
  db.sqlite
    .prepare(
      `INSERT INTO coding_processes (run_id, pid, pgid, start_time, boot_id, created_at, unresolved, unobservable)
       VALUES (?, 0, 0, NULL, NULL, ?, 1, 1)`,
    )
    .run(seed.runId, new Date().toISOString())
  const refused = await coding
    .startRun({ agentId: 'coder', input: 'go', turnId: 't-lost-routing' })
    .catch((error: unknown) => error)
  expect(refused).toMatchObject({ status: 422, code: 'agent_still_stopping' })
  expect((await request('GET', '/api/coding-agents')).json().items[0].heldGroups).toHaveLength(1)
})
