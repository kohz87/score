import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { CodingSocketServer, type RunSession } from '../../src/runtimes/coding/coding-socket.ts'
import { processStart } from '../../src/runtimes/coding/proc.ts'
import { hashSpec, type SupervisorSpec } from '../../src/runtimes/coding/supervisor.mjs'
import {
  buildSystemRun,
  cgroupPopulation,
  checkCapabilities,
  realRunTool,
  resetUnit,
  showUnit,
  stopUnit,
  SYSTEMCTL,
  type UnitState,
} from '../../src/runtimes/coding/units.ts'
import { alive, SUPERVISOR, WRAPPER } from '../helpers/coding-harness.ts'

// 7.7a part 2: REAL systemd user units. Opt-in: SCORE_TEST_SYSTEMD=1. Every unit is named score-test-<random>-<n>,
// and every one is stopped, reset and verified gone in afterEach. Nothing else is ever touched.

const ENABLED = process.env['SCORE_TEST_SYSTEMD'] === '1'
const RAND = randomBytes(4).toString('hex')
const RUNTIME = process.env['XDG_RUNTIME_DIR'] ?? ''
const run = realRunTool

interface Live {
  unit: string
  dir: string
  server: CodingSocketServer
  session: RunSession
  spec: SupervisorSpec
  receiptDir: string
  state: UnitState
  stdout: string[]
}
const lives: Live[] = []
const manager: string[] = []
let counter = 0

const sctl = (...args: string[]) => run(SYSTEMCTL, ['--user', ...args])

afterEach(async () => {
  const problems: string[] = []
  for (const l of lives.splice(0)) {
    // Exact-name stop and reset of our own test unit, then prove it is gone.
    await sctl('stop', '--', l.unit)
    await sctl('reset-failed', '--', l.unit)
    await l.server.shutdown()
    try {
      await vi.waitFor(
        async () => expect(await showUnit(run, l.unit)).toEqual({ kind: 'absent' }),
        { timeout: 10_000 },
      )
    } catch {
      problems.push(`unit ${l.unit} still present`)
    }
    rmSync(l.dir, { recursive: true, force: true })
  }
  for (const name of manager.splice(0)) await sctl('unset-environment', name)
  expect(problems).toEqual([])
})

async function launch(
  script: string,
  options: { graceMs?: number; env?: Record<string, string>; managerEnvNames?: string[] } = {},
): Promise<Live> {
  const unit = `score-test-${RAND}-${++counter}.service`
  const dir = mkdtempSync(join(tmpdir(), 'score-systemd-'))
  const runtimeDir = join(RUNTIME, `score-test-${RAND}-${counter}`)
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
  const server = new CodingSocketServer({ runtimeDir, installationId: `${RAND}00000000` })
  await server.start(true)
  const receiptDir = join(dir, 'receipts')
  mkdirSync(receiptDir)
  const spec: SupervisorSpec = {
    launch: `L${counter}`,
    generation: 1,
    token: '',
    socket: server.path,
    receiptDir,
    command: {
      file: process.execPath,
      args: ['-e', script],
      env: { PATH: process.env['PATH'] ?? '', ...options.env },
      cwd: dir,
    },
    graceMs: options.graceMs ?? 1000,
    deadline: Date.now() + 120_000,
    python: '/usr/bin/python3',
    wrapper: WRAPPER,
    notifyBin: '/usr/bin/systemd-notify',
  }
  const stdout: string[] = []
  const { token, session } = server.expect({
    launch: spec.launch,
    generation: 1,
    specHash: hashSpec(spec),
    handlers: { onStdoutRecord: (l) => void stdout.push(l) },
  })
  spec.token = token
  const specPath = join(dir, 'spec.json')
  writeFileSync(specPath, JSON.stringify(spec), { mode: 0o600 })
  const cmd = buildSystemRun({
    unit,
    graceMs: spec.graceMs,
    remainingTurnMs: 120_000,
    home: process.env['HOME']!,
    node: process.execPath,
    supervisor: SUPERVISOR,
    spec: specPath,
    notifySocket: join(RUNTIME, 'systemd', 'notify'),
    managerEnvNames: options.managerEnvNames,
  })
  const l = { unit, dir, server, session, spec, receiptDir, stdout } as Live
  lives.push(l)
  const started = await run(cmd.file, cmd.args, { timeoutMs: 30_000 })
  expect(started.stderr + started.code).toContain('0')
  expect(started.code).toBe(0)
  const ready = await session.ready
  // Identity verification (design 5): the supervisor's claims against systemd and /proc.
  const shown = await showUnit(run, unit)
  if (shown.kind !== 'present') throw new Error('unit not present')
  l.state = shown.state
  expect(shown.state.mainPid).toBe(ready.pid)
  expect(shown.state.controlGroup).toBe(ready.cgroup)
  expect(processStart(ready.pid)).toBe(ready.start)
  expect(shown.state.invocationId).toMatch(/^[0-9a-f]{32}$/)
  return l
}

const settled = async (unit: string, timeout = 30_000) =>
  vi.waitFor(
    async () => {
      const s = await showUnit(run, unit)
      expect(
        s.kind === 'absent' ||
          (s.kind === 'present' && ['inactive', 'failed'].includes(s.state.activeState)),
      ).toBe(true)
    },
    { timeout, interval: 250 },
  )

describe.skipIf(!ENABLED)('real systemd user units (opt-in: SCORE_TEST_SYSTEMD=1)', () => {
  test('capability check passes on this host, including the manager accepting every unit property', async () => {
    const result = await checkCapabilities({
      run,
      socketPath: CodingSocketServer.socketPath(RUNTIME, `${RAND}00000000`),
      probeProperties: true,
    })
    expect(result.checks.filter((c) => !c.ok)).toEqual([])
  }, 60_000)

  test('a normal run: supervisor and CLI in the right cgroups, clean environment, receipts, unit ends and its cgroup is gone', async () => {
    // Harmless sentinels in the user manager: none may reach the supervisor or the CLI (design 1).
    const sentinel = join(mkdtempSync(join(tmpdir(), 'score-sentinel-')), 'loaded')
    const hook = join(tmpdir(), `score-test-${RAND}-hook.cjs`)
    writeFileSync(hook, `require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'x')`)
    const vars: Record<string, string> = {
      NODE_OPTIONS: `--require ${hook}`,
      GLIBC_TUNABLES: 'glibc.malloc.perturb=0',
      [`SCORE_TEST_SECRET_${RAND}`]: 'credential-sentinel',
    }
    // Enumerated BEFORE the sentinels are imported: they arrive between enumeration and start (design 1).
    const names = (await sctl('show-environment')).stdout
      .split('\n')
      .map((l) => l.split('=')[0]!)
      .filter(Boolean)
    for (const [k, v] of Object.entries(vars)) {
      expect((await sctl('show-environment')).stdout).not.toContain(`${k}=`)
      manager.push(k)
      expect((await sctl('set-environment', `${k}=${v}`)).code).toBe(0)
    }
    const l = await launch(
      `console.log(JSON.stringify({ env: Object.keys(process.env).sort(), cgroup: require('fs').readFileSync('/proc/self/cgroup','utf8').trim(), ppidCg: 'x' }))`,
      { managerEnvNames: names },
    )
    const supEnv = readFileSync(`/proc/${l.state.mainPid}/environ`, 'utf8')
      .split('\0')
      .filter(Boolean)
      .map((e) => e.split('=')[0])
      .sort()
    expect(supEnv).toEqual(['HOME', 'LANG', 'NOTIFY_SOCKET', 'PATH'])
    l.session.go()
    const outcome = await l.session.outcome
    expect(outcome).toMatchObject({
      kind: 'ended',
      eligible: true,
      exit: { code: 0, signal: null },
    })
    const seen = JSON.parse(l.stdout[0]!) as { env: string[]; cgroup: string }
    // Node itself adds LC_CTYPE under a C locale; nothing from the manager may appear.
    expect(seen.env.filter((k) => k !== 'LC_CTYPE')).toEqual(['PATH'])
    // The CLI was born in payload/ (never moved after spawning).
    expect(seen.cgroup).toBe(`0::${l.state.controlGroup}/payload`)
    expect(existsSync(sentinel)).toBe(false)
    await settled(l.unit)
    expect(
      existsSync(join(l.receiptDir, 'released.json')) &&
        existsSync(join(l.receiptDir, 'ended.json')),
    ).toBe(true)
    expect(['absent', 'empty']).toContain(cgroupPopulation(l.state.controlGroup))
    rmSync(hook)
  }, 60_000)

  test('supervisor SIGKILLed after go: systemd stops the unit and kills the whole cgroup, including a setsid survivor', async () => {
    const pids = join(mkdtempSync(join(tmpdir(), 'score-surv-')), 'pids')
    const l = await launch(
      `const {spawn}=require('child_process'); const fs=require('fs');
       const s=spawn('sleep',['300'],{detached:true,stdio:'ignore'}); s.unref();
       fs.writeFileSync(${JSON.stringify(pids)}, s.pid+' '+process.pid); console.log('up'); setInterval(()=>{},1000)`,
    )
    l.session.go()
    await vi.waitFor(() => expect(existsSync(pids) && l.stdout.includes('up')).toBe(true), {
      timeout: 15_000,
    })
    const [survivor, cli] = readFileSync(pids, 'utf8').split(' ').map(Number) as [number, number]
    expect(alive(survivor) && alive(cli)).toBe(true)
    // Exactly our unit's main process, via systemd (not a numeric kill of a pid we do not own).
    expect((await sctl('kill', '--signal=SIGKILL', '--kill-whom=main', '--', l.unit)).code).toBe(0)
    await settled(l.unit)
    await vi.waitFor(() => expect(alive(survivor) || alive(cli)).toBe(false), { timeout: 15_000 })
    expect(['absent', 'empty']).toContain(cgroupPopulation(l.state.controlGroup))
    expect((await l.session.outcome).kind).toBe('lost')
  }, 60_000)

  test('supervisor frozen (SIGSTOP): the watchdog kills it within ~10 s and the whole cgroup goes with it', async () => {
    const pids = join(mkdtempSync(join(tmpdir(), 'score-stop-')), 'pids')
    const l = await launch(
      `const {spawn}=require('child_process'); const s=spawn('sleep',['300'],{detached:true,stdio:'ignore'}); s.unref();
       require('fs').writeFileSync(${JSON.stringify(pids)}, s.pid+' '+process.pid); setInterval(()=>{},1000)`,
    )
    l.session.go()
    await vi.waitFor(() => expect(existsSync(pids)).toBe(true), { timeout: 15_000 })
    const [survivor, cli] = readFileSync(pids, 'utf8').split(' ').map(Number) as [number, number]
    const started = Date.now()
    expect((await sctl('kill', '--signal=SIGSTOP', '--kill-whom=main', '--', l.unit)).code).toBe(0)
    await settled(l.unit, 40_000)
    const elapsed = Date.now() - started
    expect(elapsed).toBeLessThan(25_000)
    await vi.waitFor(() => expect(alive(survivor) || alive(cli)).toBe(false), { timeout: 15_000 })
  }, 90_000)

  test('Stop through the protocol: INT, TERM, KILL once each, one grace apart; the unit then ends on its own', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'score-sigreal-'))
    const log = join(dir, 'sig.log')
    const l = await launch(
      `const fs=require('fs'); for (const s of ['SIGINT','SIGTERM']) process.on(s,()=>fs.appendFileSync(${JSON.stringify(log)}, s+'\\n'));
       console.log('up'); setInterval(()=>{},1000)`,
      { graceMs: 1000 },
    )
    l.session.go()
    await vi.waitFor(() => expect(l.stdout).toContain('up'), { timeout: 15_000 })
    l.session.stop('user')
    const outcome = await l.session.outcome
    expect(readFileSync(log, 'utf8')).toBe('SIGINT\nSIGTERM\n')
    expect(outcome).toMatchObject({
      kind: 'ended',
      eligible: false,
      exit: { signal: 'SIGKILL' },
      stopCause: 'user',
    })
    await settled(l.unit)
    expect(['absent', 'empty']).toContain(cgroupPopulation(l.state.controlGroup))
  }, 60_000)

  test('systemctl stop reaches the supervisor as SIGINT (cause unit-stop); stop/reset are gated on the InvocationID', async () => {
    const l = await launch(`console.log('up'); setInterval(()=>{},1000)`)
    l.session.go()
    await vi.waitFor(() => expect(l.stdout).toContain('up'), { timeout: 15_000 })
    expect(await stopUnit(run, l.unit, 'f'.repeat(32))).toBe('mismatch')
    expect(await resetUnit(run, l.unit, 'f'.repeat(32))).toBe('mismatch')
    const still = await showUnit(run, l.unit)
    expect(still).toMatchObject({ kind: 'present', state: { activeState: 'active' } })
    expect(await stopUnit(run, l.unit, l.state.invocationId)).toBe('stopped')
    const ended = JSON.parse(readFileSync(join(l.receiptDir, 'ended.json'), 'utf8')) as {
      stopCause: string
    }
    expect(ended.stopCause).toBe('unit-stop')
    expect(['absent', 'empty']).toContain(cgroupPopulation(l.state.controlGroup))
  }, 60_000)

  test('socket loss: the supervisor stops the CLI tree and the unit ends by itself, bounded by the stop budget', async () => {
    const l = await launch(`console.log('up'); setInterval(()=>{},1000)`)
    l.session.go()
    await vi.waitFor(() => expect(l.stdout).toContain('up'), { timeout: 15_000 })
    const started = Date.now()
    ;(l.session as unknown as { socket: { destroy(): void } }).socket.destroy()
    await settled(l.unit, 30_000)
    expect(Date.now() - started).toBeLessThan(2 * l.spec.graceMs + 5000 + 3000)
    expect(JSON.parse(readFileSync(join(l.receiptDir, 'ended.json'), 'utf8'))).toMatchObject({
      stopCause: 'socket-loss',
    })
  }, 60_000)
})
