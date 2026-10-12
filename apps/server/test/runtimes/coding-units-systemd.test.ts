import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { CodingJournal } from '../../src/domain/orchestration/coding-journal.ts'
import { ExecutionJournal } from '../../src/domain/orchestration/journal.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { CliLocator } from '../../src/runtimes/coding/cli.ts'
import { alive } from '../helpers/coding-harness.ts'
import { CodingRuntime } from '../../src/runtimes/coding/service.ts'
import { insertCodingAgent } from '../../src/runtimes/coding/store.ts'
import { UNIT_CAPABLE_FILE, UnitBackend } from '../../src/runtimes/coding/unit-backend.ts'
import {
  listInstallationUnits,
  realRunTool,
  SYSTEMCTL,
  showUnit,
  SYSTEMD_RUN,
} from '../../src/runtimes/coding/units.ts'
import { defaultRootPolicy } from '../../src/workspace/policy.ts'
import { FAKE_CLI } from './coding-fixtures.ts'

// 7.7a part 3: a real coding turn of a harmless fake CLI driver through CodingRuntime on REAL systemd user units.
// Opt-in: SCORE_TEST_SYSTEMD=1. Every unit is named score-test-<random>-c-<launch id> (the installation prefix is
// replaced by the test prefix), and every one is stopped, reset and verified gone in afterEach. Nothing else is touched.

const ENABLED = process.env['SCORE_TEST_SYSTEMD'] === '1'
const RAND = randomBytes(4).toString('hex')
const RUNTIME = process.env['XDG_RUNTIME_DIR'] ?? ''
const PREFIX = `score-test-${RAND}-c-`
const run = realRunTool

interface Kit {
  dir: string
  workspace: string
  runtimeDir: string
  installationId: string
  db: ScoreDb
  ingest: Ingest
  backend: UnitBackend
  coding: CodingRuntime
  cliLog: string
}
const kits: Kit[] = []
const extraUnits: string[] = []
const childPids: number[] = []
const extraDirs: string[] = []

const sctl = (...args: string[]) => run(SYSTEMCTL, ['--user', ...args])

afterEach(async () => {
  for (const pid of childPids.splice(0))
    if (alive(pid))
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // gone
      }
  for (const kit of kits.splice(0)) {
    await kit.coding.close().catch(() => undefined)
    await kit.ingest.close()
    kit.db.close()
    rmSync(kit.dir, { recursive: true, force: true })
    rmSync(kit.runtimeDir, { recursive: true, force: true })
  }
  for (const dir of extraDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  // Only units carrying this run's random test prefix, by exact name.
  const listed = await listInstallationUnits(run, PREFIX)
  const names = new Set([...extraUnits.splice(0), ...(listed.kind === 'ok' ? listed.names : [])])
  for (const name of names) {
    await sctl('stop', '--', name)
    await sctl('reset-failed', '--', name)
  }
  const after = await listInstallationUnits(run, PREFIX)
  expect(after).toEqual({ kind: 'ok', names: [] })
})

async function kitFor(
  dir = mkdtempSync(join(tmpdir(), 'score-cus-')),
  installationId = `${RAND}${randomBytes(4).toString('hex')}`,
): Promise<Kit> {
  const workspace = join(dir, 'ws')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(join(dir, 'home'), { recursive: true })
  const runtimeDir = join(RUNTIME, `score-test-${RAND}-${kits.length}`)
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
  const namespace = join(dir, 'journal', installationId)
  mkdirSync(join(namespace, 'launches'), { recursive: true })
  const cliLog = join(dir, 'cli.log')
  process.env['SCORE_CODING_FAKE_LOG'] = cliLog
  const db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  const ingest = createIngest(db)
  const backend = new UnitBackend({
    db,
    journal: new CodingJournal(new ExecutionJournal(namespace, installationId)),
    installationId,
    namespaceDir: namespace,
    runtimeDir,
    home: process.env['HOME']!,
    unitPrefix: PREFIX,
    notifySocket: join(RUNTIME, 'systemd', 'notify'),
    graceMs: 500,
  })
  const status = await backend.start()
  expect(status.checks.filter((c) => !c.ok)).toEqual([])
  expect(status.kind).toBe('unit')
  const coding = new CodingRuntime({
    db,
    ingest,
    unit: backend,
    graceMs: 500,
    stopObserveMs: 20_000,
    terminalRetryMs: 20,
    locator: new CliLocator({ fakeCli: FAKE_CLI, cacheMs: 0 }),
    home: join(dir, 'home'),
    policy: defaultRootPolicy([join(dir, 'home')]),
  })
  const kit = { dir, workspace, runtimeDir, installationId, db, ingest, backend, coding, cliLog }
  kits.push(kit)
  return kit
}

function seedAgent(kit: Kit) {
  insertCodingAgent(kit.db.sqlite, {
    id: 'real',
    name: 'Real',
    role: '',
    runtime: 'claude-code',
    workspace: kit.workspace,
    permission: 'workspace-write',
    model: null,
    style: { color: '#19C39A', shape: 'hexagon' },
    createdAt: new Date().toISOString(),
  })
}
const runStatus = (kit: Kit, runId: string) =>
  kit.db.sqlite.prepare('SELECT status, error FROM runs WHERE id = ?').get(runId) as
    { status: string; error: string | null } | undefined
const launchRows = (kit: Kit) =>
  kit.db.sqlite.prepare('SELECT * FROM coding_launches').all() as unknown as {
    launch_id: string
    phase: string
    unit: string
    receipt_dir: string
    proof: string
    held: number
    stop_cause: string | null
  }[]

describe.skipIf(!ENABLED)(
  'coding runs on real systemd user units (opt-in: SCORE_TEST_SYSTEMD=1)',
  () => {
    test('a real coding turn: stream, completion, ended proof, settlement and collection on a real unit', async () => {
      const kit = await kitFor()
      seedAgent(kit)
      const { runId } = await kit.coding.startRun({
        agentId: 'real',
        input: '[fixture:basic] hello',
        turnId: 'turn-1',
      })
      await vi.waitFor(() => expect(runStatus(kit, runId)?.status).toBe('completed'), {
        timeout: 60_000,
        interval: 200,
      })
      await vi.waitFor(() => expect(launchRows(kit)[0]?.phase).toBe('settled'), { timeout: 30_000 })
      const [launch] = launchRows(kit)
      expect(launch!.unit.startsWith(PREFIX)).toBe(true)
      expect(launch!.proof).toMatch(/cgroup|never/)
      expect(readdirSync(launch!.receipt_dir).sort()).toEqual([
        'ended.json',
        'identity.json',
        'released.json',
        'routing.json',
      ])
      // The unit is collected: systemd no longer knows it.
      expect(await listInstallationUnits(run, PREFIX)).toEqual({ kind: 'ok', names: [] })
      // The spec (with its token) is gone from the runtime dir.
      expect(
        existsSync(
          join(
            kit.runtimeDir,
            'score',
            kit.installationId.slice(0, 8),
            'launches',
            launch!.launch_id,
          ),
        ),
      ).toBe(false)
      const output = kit.db.sqlite.prepare('SELECT output FROM runs WHERE id = ?').get(runId) as {
        output: string
      }
      expect(output.output).toContain('Created hello.txt and changed it.')
    }, 120_000)

    test('Stop on a real running unit: INT then the unit ends, proof comes from its cgroup, the run is cancelled', async () => {
      const kit = await kitFor()
      seedAgent(kit)
      const { runId } = await kit.coding.startRun({
        agentId: 'real',
        input: '[fixture:slow] hold',
        turnId: 'turn-stop',
      })
      await vi.waitFor(() => expect(existsSync(kit.cliLog)).toBe(true), { timeout: 60_000 })
      await vi
        .waitFor(() => expect(launchRows(kit)[0]?.phase).toBe('released'), { timeout: 60_000 })
        .catch(() => undefined)
      expect(await kit.coding.stopRun({ agentId: 'real', runId })).toBe('stopped')
      await vi.waitFor(() => expect(runStatus(kit, runId)?.status).toBe('cancelled'), {
        timeout: 30_000,
      })
      await vi.waitFor(() => expect(launchRows(kit)[0]?.phase).toBe('settled'), { timeout: 30_000 })
      expect(launchRows(kit)[0]).toMatchObject({ stop_cause: 'user', held: 0 })
    }, 150_000)

    test('Score crashes (SIGKILL) mid-run: the supervisor stops the CLI tree by itself; the restart proves and settles', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'score-cus-'))
      const installationId = `${RAND}${randomBytes(4).toString('hex')}`
      const runtimeDir = join(RUNTIME, `score-test-${RAND}-crash`)
      mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
      const workspace = join(dir, 'ws')
      mkdirSync(workspace)
      const cliLog = join(dir, 'cli.log')
      const script = fileURLToPath(new URL('./crash-unit-server.ts', import.meta.url))
      const server = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          script,
          dir,
          workspace,
          FAKE_CLI,
          runtimeDir,
          installationId,
          PREFIX,
          cliLog,
        ],
        {
          cwd: fileURLToPath(new URL('../..', import.meta.url)),
          env: { ...process.env, SCORE_CODING_FAKE_LOG: cliLog },
          stdio: ['ignore', 'pipe', 'inherit'],
        },
      )
      childPids.push(server.pid!)
      const cliPid = await new Promise<number>((resolve, reject) => {
        let out = ''
        server.stdout.on('data', (chunk: Buffer) => {
          out += chunk.toString()
          const match = /READY (\d+)/.exec(out)
          if (match) resolve(Number(match[1]))
        })
        server.on('exit', () => reject(new Error(`server exited early: ${out}`)))
      })
      expect(alive(cliPid)).toBe(true)
      server.removeAllListeners('exit')
      server.kill('SIGKILL')
      await new Promise((resolve) => server.on('exit', resolve))
      // The supervisor sees the socket close and stops the CLI by itself (INT -> TERM -> KILL, one grace each).
      await vi.waitFor(() => expect(alive(cliPid)).toBe(false), { timeout: 30_000 })
      // The restart: same database, journal and prefix.
      const kit = await kitFor(dir, installationId)
      const before = launchRows(kit)
      expect(before).toHaveLength(1)
      const report = await kit.coding.recover()
      expect(report).toBe(1)
      const [launch] = launchRows(kit)
      expect(launch).toMatchObject({ phase: 'settled', held: 0 })
      const runId = (kit.db.sqlite.prepare('SELECT id FROM runs').get() as { id: string }).id
      expect(runStatus(kit, runId)).toMatchObject({ status: 'interrupted' })
      expect(await listInstallationUnits(run, PREFIX)).toEqual({ kind: 'ok', names: [] })
    }, 180_000)

    test('a real unit with the installation prefix and no journal launch is an orphan: reported, fenced, never stopped or adopted', async () => {
      const kit = await kitFor()
      const orphan = `${PREFIX}00000000000000000000000000000001.service`
      extraUnits.push(orphan)
      const started = await run(SYSTEMD_RUN, [
        '--user',
        '--no-ask-password',
        `--unit=${orphan}`,
        '--property=RuntimeMaxSec=120s',
        '--',
        '/usr/bin/sleep',
        '120',
      ])
      expect(started.code).toBe(0)
      const names: string[][] = []
      const coding = new CodingRuntime({
        db: kit.db,
        ingest: kit.ingest,
        unit: kit.backend,
        locator: new CliLocator({ fakeCli: FAKE_CLI, cacheMs: 0 }),
        home: join(kit.dir, 'home'),
        policy: defaultRootPolicy([join(kit.dir, 'home')]),
        onOrphans: (list) => names.push(list),
      })
      await coding.recover()
      expect(names).toEqual([[orphan]])
      const still = await sctl('is-active', '--', orphan)
      expect(still.stdout.trim()).toBe('active')
      expect(kit.backend.block()).toMatch(/isn’t accounted for/)
    }, 90_000)

    test('re-review 2 #10: systemd reports a finished main process’s pid, exit code and status, and a pass is remembered', async () => {
      const kit = await kitFor()
      // The first passing check is remembered beside the journal (decision 69).
      expect(existsSync(join(kit.dir, 'journal', kit.installationId, UNIT_CAPABLE_FILE))).toBe(true)
      const name = `${PREFIX}${randomBytes(8).toString('hex')}.service`
      extraUnits.push(name)
      const started = await run(SYSTEMD_RUN, [
        '--user',
        '--no-ask-password',
        `--unit=${name}`,
        '--property=Type=exec',
        '--',
        '/usr/bin/sh',
        '-c',
        'exit 3',
      ])
      expect(started.code, started.stderr).toBe(0)
      let state: Awaited<ReturnType<typeof showUnit>> | undefined
      await vi.waitFor(
        async () => {
          state = await showUnit(run, name)
          expect(state.kind === 'present' && state.state.activeState === 'failed').toBe(true)
        },
        { timeout: 15_000 },
      )
      if (state?.kind !== 'present') throw new Error('unit not present')
      // A failed unit stays visible with the status of its main process: what the eligibility check reads.
      expect(state.state).toMatchObject({ execMainCode: 1, execMainStatus: 3, result: 'exit-code' })
      expect(state.state.execMainPid).toBeGreaterThan(1)
    }, 60_000)

    test('the capability check on this host passes, including real unit properties', async () => {
      const kit = await kitFor()
      expect(kit.backend.status.kind).toBe('unit')
      expect(kit.backend.status.checks.map((c) => c.name)).toEqual(
        expect.arrayContaining([
          'manager',
          'cgroup-v2',
          'linger',
          'socket-path',
          'properties',
          'socket',
          'python',
          'notify',
        ]),
      )
      expect(readFileSync('/proc/self/cgroup', 'utf8')).toContain('0::')
    }, 60_000)
  },
)
