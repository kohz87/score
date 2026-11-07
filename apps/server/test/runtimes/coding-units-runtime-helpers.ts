import { RoomSchema, type CodingAgent, type Message } from '@score/contract'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, vi } from 'vitest'
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
import { processStart } from '../../src/runtimes/coding/proc.ts'
import { spawnCli } from '../../src/runtimes/coding/process.ts'
import { CodingRuntime, type CodingRuntimeDeps } from '../../src/runtimes/coding/service.ts'
import { writeReceipt } from '../../src/runtimes/coding/supervisor.mjs'
import { UnitBackend, type UnitBackendDeps } from '../../src/runtimes/coding/unit-backend.ts'
import { defaultRootPolicy } from '../../src/workspace/policy.ts'
import { FakeSystemd } from '../helpers/fake-systemd.ts'
import { FAKE_CLI } from './coding-fixtures.ts'
import { onMentions } from '../helpers/on-mentions.ts'

// 7.7a part 3: the real CodingRuntime on the unit backend, with the real supervisor and Score socket and a fake
// systemd boundary (test/helpers/fake-systemd.ts). Nothing here starts a real unit.

vi.setConfig({ testTimeout: 40_000 })

export const INSTALLATION = 'abcdef0123456789'
export let dir: string
export let home: string
export let workspace: string
export let log: string
export let namespace: string
export let runtimeDir: string
export let db: ScoreDb
export let ingest: Ingest
export let port: FakePort
export let fake: FakeSystemd
export let journal: ExecutionJournal
export let coding: CodingRuntime
export let backend: UnitBackend
export let app: ReturnType<typeof buildApp>
export let headers: { 'x-score-client': string; cookie: string }
export let roomId: string
export let processLaunches = 0
const secrets = new Map<string, string | undefined>()
export const errors: unknown[] = []

export function setEnv(name: string, value: string | undefined) {
  if (!secrets.has(name)) secrets.set(name, process.env[name])
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

export interface BootOptions {
  maxTurnMs?: number
  graceMs?: number
  stopObserveMs?: number
  reapRetryMs?: number
  unit?: Partial<UnitBackendDeps>
  blocked?: () => string | null
  ingestWrap?: (ingest: Ingest) => Pick<Ingest, 'submit'>
  noUnit?: boolean
  onOrphans?: (names: string[]) => void
  /** Decision 71: why Score holds all agent work (the sentence), wired to both the backend and the runtime. */
  frozen?: () => string | null
}

export function makeBackend(options: BootOptions = {}): UnitBackend {
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
    ...(options.frozen ? { frozen: options.frozen } : {}),
    ...options.unit,
  })
}

export async function boot(options: BootOptions = {}) {
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
    ...(options.frozen ? { frozen: options.frozen } : {}),
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

export async function beforeEachHarness() {
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
}

export async function afterEachHarness() {
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
}

export const request = (
  method: 'POST' | 'PATCH' | 'DELETE' | 'GET',
  url: string,
  payload?: object,
) => app.inject({ method, url, headers, ...(payload ? { payload } : {}) })
const style = { color: '#19C39A', shape: 'hexagon' }
export async function addAgent(over: Record<string, unknown> = {}): Promise<CodingAgent> {
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
export async function makeRoom(): Promise<string> {
  const created = await request('POST', '/api/rooms', {
    name: `code${++roomCount}`,
    leadAgentId: 'lead',
  })
  roomId = RoomSchema.parse(created.json()).id
  onMentions(db, roomId)
  return roomId
}
export async function say(text: string) {
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
export const runs = () =>
  db.sqlite
    .prepare("SELECT * FROM runs WHERE runtime != 'hermes' ORDER BY started_at, rowid")
    .all() as unknown as RunRow[]
export async function finished(count = 1) {
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
export const replies = (): Message[] =>
  db.sqlite
    .prepare(
      "SELECT * FROM messages WHERE room_id = ? AND author_kind = 'agent' ORDER BY created_at, id",
    )
    .all(roomId)
    .map(messageFromRow)
export const cliCalls = () =>
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
export const launches = () =>
  db.sqlite
    .prepare('SELECT * FROM coding_launches ORDER BY updated_at, launch_id')
    .all() as unknown as LaunchRow[]
export const journalKinds = (launchId: string) => {
  const read = journal.readOwn()
  if (!read.ok) throw new Error(read.reason)
  return read.entries.filter((e) => 'launchId' in e && e.launchId === launchId).map((e) => e.kind)
}
export const textOf = (message: Message | undefined) => JSON.stringify(message?.parts ?? [])

export async function rebootWithKill(killGroup: CodingRuntimeDeps['killGroup']) {
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

let seeded = 0
export function seedRun(runId: string, status = 'running') {
  const now = new Date().toISOString()
  db.sqlite
    .prepare(
      `INSERT INTO runs (id, profile, origin, score_turn_id, status, model, started_at, updated_at, runtime)
       VALUES (?, 'coder', 'score', ?, ?, NULL, ?, ?, 'claude-code')`,
    )
    .run(runId, `turn-${runId}`, status, now, now)
}
type Upto = 'requested' | 'armed' | 'releasing' | 'released-seen'
export function seedLaunch(
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
export const launchRow = (id: string) => launches().find((l) => l.launch_id === id)!
export const runRow = (id: string) => runs().find((r) => r.id === id)!
