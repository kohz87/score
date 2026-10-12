import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  buildSystemRun,
  cgroupPopulation,
  checkCapabilities,
  ENV_DENY_LIST,
  hasInstallationPrefix,
  managerIncarnation,
  parseCgroupEvents,
  parseShow,
  parseUnitState,
  resetUnit,
  sameIncarnation,
  showUnit,
  stopUnit,
  unitNameFor,
  unsetEnvironmentList,
  validateUnitName,
  type RunTool,
  type ToolResult,
} from '../../src/runtimes/coding/units.ts'

// 7.7a part 2: the unit builder and systemctl plumbing against a fake systemd. Fake-boundary tests.

const base = {
  unit: 'score-coding-01234567-abc123.service',
  graceMs: 5000,
  remainingTurnMs: 120_000,
  home: '/home/u',
  node: '/usr/bin/node',
  supervisor: '/opt/score/supervisor.mjs',
  spec: '/run/user/1000/score/spec.json',
  notifySocket: '/run/user/1000/systemd/notify',
}

test('systemd-run argv is exactly design section 1', () => {
  const { file, args } = buildSystemRun(base)
  expect(file).toBe('/usr/bin/systemd-run')
  const deny = ENV_DENY_LIST.join(' ')
  expect(args).toEqual([
    '--user',
    '--no-ask-password',
    '--expand-environment=no',
    '--unit=score-coding-01234567-abc123.service',
    '--description=Score coding run',
    '--property=Type=exec',
    '--property=ExitType=main',
    '--property=KillMode=mixed',
    '--property=KillSignal=SIGINT',
    '--property=TimeoutStopSec=15s',
    '--property=FinalKillSignal=SIGKILL',
    '--property=SendSIGKILL=yes',
    '--property=RuntimeMaxSec=135s',
    '--property=TasksAccounting=yes',
    '--property=StandardInput=null',
    '--property=StandardOutput=null',
    '--property=StandardError=null',
    '--property=Delegate=yes',
    '--property=WatchdogSec=10s',
    '--property=WatchdogSignal=SIGKILL',
    '--property=NotifyAccess=all',
    '--property=Restart=no',
    '--property=Environment=',
    `--property=UnsetEnvironment=${deny}`,
    '--setenv=PATH=/usr/local/bin:/usr/bin:/bin',
    '--setenv=HOME=/home/u',
    '--setenv=LANG=C.UTF-8',
    '--',
    '/usr/bin/env',
    '-i',
    'PATH=/usr/local/bin:/usr/bin:/bin',
    'HOME=/home/u',
    'LANG=C.UTF-8',
    'NOTIFY_SOCKET=/run/user/1000/systemd/notify',
    '/usr/bin/node',
    '--no-warnings',
    '/opt/score/supervisor.mjs',
    '/run/user/1000/score/spec.json',
  ])
})

test('the deny list is concrete (no patterns) and covers the design names', () => {
  for (const name of ['LD_PRELOAD', 'NODE_OPTIONS', 'GCONV_PATH', 'PYTHONSTARTUP', 'OPENSSL_CONF'])
    expect(ENV_DENY_LIST).toContain(name)
  expect(ENV_DENY_LIST.some((n) => /[*?]/.test(n))).toBe(false)
})

test('every other name the manager exports is added, except PATH/HOME/LANG/NOTIFY_SOCKET and non-names', () => {
  const list = unsetEnvironmentList([
    'GLIBC_TUNABLES',
    'MY_SECRET',
    'PATH',
    'HOME',
    'LANG',
    'NOTIFY_SOCKET',
    'bad name',
    'X=1',
    'LD_PRELOAD',
  ])
  expect(list).toContain('GLIBC_TUNABLES')
  expect(list).toContain('MY_SECRET')
  expect(list.filter((n) => n === 'LD_PRELOAD')).toHaveLength(1)
  for (const n of ['PATH', 'HOME', 'LANG', 'NOTIFY_SOCKET', 'bad name', 'X=1'])
    expect(list).not.toContain(n)
})

test('unit names are validated; arguments with control characters or relative paths are refused', () => {
  expect(validateUnitName('score-coding-01234567-abc.service')).toBe(true)
  for (const bad of [
    '',
    'x.service',
    'score-.service',
    'score-a b.service',
    'score-a/../b.service',
    '-score-a.service',
    'score-a.timer',
    'score-a\n.service',
    `score-${'a'.repeat(300)}.service`,
  ])
    expect(validateUnitName(bad)).toBe(false)
  expect(() => buildSystemRun({ ...base, unit: 'bad name.service' })).toThrow()
  expect(() => buildSystemRun({ ...base, home: 'relative' })).toThrow()
  expect(() => buildSystemRun({ ...base, spec: '/a\nb' })).toThrow()
  expect(unitNameFor('0123456789abcdef', 'LAUNCH-1_x')).toBe('score-01234567-c-LAUNCH1x.service')
  expect(hasInstallationPrefix('score-01234567-c-a.service', '0123456789abcdef')).toBe(true)
  expect(hasInstallationPrefix('score-99999999-c-a.service', '0123456789abcdef')).toBe(false)
})

test('systemctl show output is parsed into unit state; Job marks a pending job', () => {
  const text =
    'LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=123\nInvocationID=abc\nControlGroup=/user.slice/x.service\nResult=success\nJob=77\nExecMainPID=122\nExecMainStatus=0\nExecMainCode=1\n'
  expect(parseShow(text).get('MainPID')).toBe('123')
  expect(parseUnitState(text)).toEqual({
    loadState: 'loaded',
    activeState: 'active',
    subState: 'running',
    mainPid: 123,
    invocationId: 'abc',
    controlGroup: '/user.slice/x.service',
    result: 'success',
    jobPending: true,
    execMainPid: 122,
    execMainStatus: 0,
    execMainCode: 1,
  })
  expect(parseUnitState('LoadState=loaded\n').jobPending).toBe(false)
  // A unit that never ran its main process reports nothing: unknown, never a clean zero.
  expect(parseUnitState('LoadState=loaded\nExecMainStatus=\n').execMainStatus).toBeNull()
})

test('cgroup.events and population: populated 0/1, absent directory, unreadable', () => {
  expect(parseCgroupEvents('populated 1\nfrozen 0\n')).toBe('populated')
  expect(parseCgroupEvents('populated 0\nfrozen 0\n')).toBe('empty')
  expect(parseCgroupEvents('garbage')).toBe('unknown')
  const root = mkdtempSync(join(tmpdir(), 'score-cg-'))
  mkdirSync(join(root, 'u', 'x.service'), { recursive: true })
  writeFileSync(join(root, 'u', 'x.service', 'cgroup.events'), 'populated 0\n')
  expect(cgroupPopulation('/u/x.service', root)).toBe('empty')
  expect(cgroupPopulation('/u/gone.service', root)).toBe('absent')
  expect(cgroupPopulation('/u/../x', root)).toBe('unknown')
  expect(cgroupPopulation('relative', root)).toBe('unknown')
})

function fakeSystemd(initial: Partial<Record<string, string>> = {}) {
  const calls: string[][] = []
  const state: Record<string, string> = {
    LoadState: 'loaded',
    ActiveState: 'active',
    SubState: 'running',
    MainPID: '10',
    InvocationID: 'inv-1',
    ControlGroup: '/x',
    Result: 'success',
    Job: '',
    ...initial,
  }
  let transport: 'ok' | 'fail' = 'ok'
  const run: RunTool = async (_file, args): Promise<ToolResult> => {
    calls.push(args)
    if (transport === 'fail')
      return { code: 1, stdout: '', stderr: 'Failed to connect to bus: Permission denied' }
    if (args.includes('show'))
      return {
        code: 0,
        stdout: Object.entries(state)
          .map(([k, v]) => `${k}=${v}`)
          .join('\n'),
        stderr: '',
      }
    if (args.includes('stop')) {
      state['ActiveState'] = 'inactive'
      return { code: 0, stdout: '', stderr: '' }
    }
    if (args.includes('reset-failed')) {
      state['LoadState'] = 'not-found'
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  return { run, calls, state, breakTransport: () => (transport = 'fail') }
}
const NAME = 'score-coding-01234567-abc.service'

test('stop acts on the exact name only while InvocationID matches, and re-checks after the call', async () => {
  const s = fakeSystemd()
  expect(await stopUnit(s.run, NAME, 'inv-OTHER')).toBe('mismatch')
  expect(s.calls.some((c) => c.includes('stop'))).toBe(false)
  expect(await stopUnit(s.run, NAME, 'inv-1')).toBe('stopped')
  expect(s.calls.find((c) => c.includes('stop'))).toEqual(['--user', 'stop', '--', NAME])
})

test('a different InvocationID after the stop call is uncertainty, not success', async () => {
  const s = fakeSystemd()
  const run: RunTool = async (file, args) => {
    const r = await s.run(file, args)
    if (args.includes('stop')) s.state['InvocationID'] = 'inv-2'
    return r
  }
  expect(await stopUnit(run, NAME, 'inv-1')).toBe('uncertain')
})

test('a unit still active after stop is uncertain', async () => {
  const s = fakeSystemd()
  const run: RunTool = async (file, args) => {
    const r = await s.run(file, args)
    if (args.includes('stop')) s.state['ActiveState'] = 'deactivating'
    return r
  }
  expect(await stopUnit(run, NAME, 'inv-1')).toBe('uncertain')
})

test('transport and permission errors are unknown, never absent; not-found is absent', async () => {
  const s = fakeSystemd()
  s.breakTransport()
  expect(await showUnit(s.run, NAME)).toMatchObject({ kind: 'unknown' })
  expect(await stopUnit(s.run, NAME, 'inv-1')).toBe('unknown')
  expect(await resetUnit(s.run, NAME, 'inv-1')).toBe('unknown')
  const gone = fakeSystemd({ LoadState: 'not-found', ActiveState: 'inactive', InvocationID: '' })
  expect(await showUnit(gone.run, NAME)).toEqual({ kind: 'absent' })
  expect(await stopUnit(gone.run, NAME, 'inv-1')).toBe('absent')
})

test('reset-failed is gated the same way and refuses invalid names', async () => {
  const s = fakeSystemd({ ActiveState: 'failed' })
  expect(await resetUnit(s.run, NAME, 'wrong')).toBe('mismatch')
  expect(await resetUnit(s.run, NAME, 'inv-1')).toBe('reset')
  expect(await resetUnit(s.run, '--all', 'inv-1')).toBe('unknown')
  expect(s.calls.every((c) => !c.includes('--all'))).toBe(true)
})

test('manager incarnation is the user manager pid plus its /proc start time', async () => {
  const run: RunTool = async (_f, args) => {
    expect(args).toEqual(['show', '--property=MainPID', '--', 'user@1000.service'])
    return { code: 0, stdout: 'MainPID=900\n', stderr: '' }
  }
  const a = await managerIncarnation(run, 1000, () => '555')
  expect(a).toEqual({ pid: 900, start: '555' })
  expect(sameIncarnation(a, await managerIncarnation(run, 1000, () => '555'))).toBe(true)
  expect(sameIncarnation(a, await managerIncarnation(run, 1000, () => '556'))).toBe(false)
  expect(
    await managerIncarnation(
      async () => ({ code: 0, stdout: 'MainPID=0\n', stderr: '' }),
      1000,
      () => '1',
    ),
  ).toBeNull()
  expect(await managerIncarnation(run, 1000, () => null)).toBeNull()
  expect(sameIncarnation(null, null)).toBe(false)
})

test('the capability check reports each failure: manager, cgroup v2, linger, socket path, properties', async () => {
  const root = mkdtempSync(join(tmpdir(), 'score-cgv2-'))
  writeFileSync(join(root, 'cgroup.controllers'), 'cpu memory')
  const good: RunTool = async (file, args) => {
    if (file.endsWith('loginctl')) return { code: 0, stdout: 'Linger=yes\n', stderr: '' }
    if (args.includes('--property=Version')) return { code: 0, stdout: 'Version=259\n', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  const ok = await checkCapabilities({
    run: good,
    uid: 1000,
    socketPath: '/run/user/1000/score/01234567.sock',
    cgroupRoot: root,
    probeProperties: true,
  })
  expect(ok.ok).toBe(true)
  expect(ok.checks.map((c) => c.name)).toEqual([
    'manager',
    'cgroup-v2',
    'linger',
    'socket-path',
    'properties',
  ])

  const bad = await checkCapabilities({
    run: async (file) =>
      file.endsWith('loginctl')
        ? { code: 0, stdout: 'Linger=no\n', stderr: '' }
        : { code: 1, stdout: '', stderr: 'Failed to connect to bus: No medium found' },
    uid: 1000,
    socketPath: '/' + 'a'.repeat(120),
    cgroupRoot: '/nonexistent-cgroup-root',
    probeProperties: true,
  })
  expect(bad.ok).toBe(false)
  expect(Object.fromEntries(bad.checks.map((c) => [c.name, c.ok]))).toEqual({
    manager: false,
    'cgroup-v2': false,
    linger: false,
    'socket-path': false,
    properties: false,
  })
})
