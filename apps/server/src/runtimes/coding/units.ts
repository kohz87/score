import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { processStart } from './proc.ts'

// systemd user-unit plumbing for coding runs (7.7a design v7 sections 1, 5, 6b, 8). Everything that talks to systemd
// goes through a `RunTool`, so tests drive it with a fake and the opt-in suite with the real thing.

export interface ToolResult {
  /** Exit status; null when the tool could not run or timed out. */
  code: number | null
  stdout: string
  stderr: string
  /** Set when the tool did not run to completion (missing binary, timeout). */
  failed?: 'spawn' | 'timeout'
}
export type RunTool = (
  file: string,
  args: string[],
  options?: { timeoutMs?: number },
) => Promise<ToolResult>

export const realRunTool: RunTool = (file, args, options) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { encoding: 'utf8', timeout: options?.timeoutMs ?? 15_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, stdout, stderr })
        const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string }
        if (typeof e.code === 'number') return resolve({ code: e.code, stdout, stderr })
        resolve({ code: null, stdout, stderr, failed: e.killed ? 'timeout' : 'spawn' })
      },
    )
  })

export const SYSTEMD_RUN = '/usr/bin/systemd-run'
export const SYSTEMCTL = '/usr/bin/systemctl'
export const LOGINCTL = '/usr/bin/loginctl'
export const ENV_BIN = '/usr/bin/env'
export const PINNED_PATH = '/usr/local/bin:/usr/bin:/bin'
export const CGROUP_ROOT = '/sys/fs/cgroup'

/** Design section 1: the concrete deny list, always applied whether or not the manager exports the names. */
export const ENV_DENY_LIST: readonly string[] = [
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'LD_BIND_NOW',
  'LD_DEBUG',
  'LD_PROFILE',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_REPL_EXTERNAL_MODULE',
  'NODE_EXTRA_CA_CERTS',
  'NODE_ICU_DATA',
  'NODE_V8_COVERAGE',
  'NODE_DEBUG',
  'NODE_PENDING_DEPRECATION',
  'NODE_REDIRECT_WARNINGS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_COMPILE_CACHE',
  'NODE_DISABLE_COMPILE_CACHE',
  'UV_THREADPOOL_SIZE',
  'OPENSSL_CONF',
  'OPENSSL_MODULES',
  'OPENSSL_ENGINES',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'MALLOC_CHECK_',
  'MALLOC_PERTURB_',
  'GCONV_PATH',
  'LOCPATH',
  'TZDIR',
  'HOSTALIASES',
  'RES_OPTIONS',
  'PYTHONPATH',
  'PYTHONHOME',
  'PYTHONSTARTUP',
]

/** Set explicitly (never listed: UnsetEnvironment applies last), or owned by systemd itself. */
const NEVER_UNSET = new Set(['PATH', 'HOME', 'LANG', 'NOTIFY_SOCKET'])
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

// ---- names ---------------------------------------------------------------------------------------------------------

const UNIT_NAME = /^score-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\.service$/
const MAX_UNIT_NAME = 200

export function validateUnitName(name: string): boolean {
  return name.length <= MAX_UNIT_NAME && UNIT_NAME.test(name)
}

/** The unit-name prefix of an installation: `score-<installation8>-c-` (lead answer, part 3). */
export function unitPrefix(installationId: string): string {
  return `score-${installationId.slice(0, 8)}-c-`
}

/**
 * `score-<installation8>-c-<launch id without dashes>.service`. Launch ids are server-minted UUIDv4s, so the name is
 * globally unique per launch and never reused (design 6b). The exact name is stored in the launch row and the journal
 * record and is never derived again from other fields. `prefix` is a test seam (the opt-in suite uses `score-test-…`).
 */
export function unitNameFor(installationId: string, launchId: string, prefix?: string): string {
  const name = `${prefix ?? unitPrefix(installationId)}${launchId.replaceAll(/[^A-Za-z0-9]/g, '')}.service`
  if (!validateUnitName(name)) throw new Error('cannot build a valid unit name')
  return name
}

/** Whether a unit name carries this installation's prefix (necessary, not sufficient: the journal decides ownership). */
export function hasInstallationPrefix(
  name: string,
  installationId: string,
  prefix?: string,
): boolean {
  return validateUnitName(name) && name.startsWith(prefix ?? unitPrefix(installationId))
}

// ---- systemd-run argv ----------------------------------------------------------------------------------------------

export interface UnitLaunchOptions {
  unit: string
  /** One escalation grace (ms). */
  graceMs: number
  /** Time left in the turn (ms) when the unit starts: the monotonic backstop for the wall-clock deadline. */
  remainingTurnMs: number
  home: string
  /** Absolute node, supervisor.mjs and the spec file. */
  node: string
  supervisor: string
  spec: string
  /** `$XDG_RUNTIME_DIR/systemd/notify`: the user manager's fixed path. */
  notifySocket: string
  /** Names the manager exports (`systemctl --user show-environment`); added to the deny list. */
  managerEnvNames?: readonly string[]
  pinnedPath?: string
  systemdRun?: string
  envBin?: string
}

const seconds = (ms: number) => `${Math.ceil(ms / 1000)}s`

function assertValue(label: string, value: string, absolute = false): void {
  if (value.length === 0 || [...value].some((c) => c < ' ' || c === '\x7f'))
    throw new Error(`${label}: invalid value`)
  if (absolute && !value.startsWith('/')) throw new Error(`${label}: must be an absolute path`)
}

/** The deny list for `UnsetEnvironment`: the concrete list plus whatever the manager exports (except the exempt names). */
export function unsetEnvironmentList(managerEnvNames: readonly string[] = []): string[] {
  const names = new Set(ENV_DENY_LIST)
  for (const name of managerEnvNames)
    if (ENV_NAME.test(name) && !NEVER_UNSET.has(name)) names.add(name)
  return [...names]
}

/** The property arguments of the transient unit (design section 1). */
export function unitProperties(
  options: Pick<UnitLaunchOptions, 'graceMs' | 'remainingTurnMs' | 'managerEnvNames'>,
): string[] {
  const stop = 2 * options.graceMs + 5000
  return [
    'Type=exec',
    'ExitType=main',
    'KillMode=mixed',
    'KillSignal=SIGINT',
    `TimeoutStopSec=${seconds(stop)}`,
    'FinalKillSignal=SIGKILL',
    'SendSIGKILL=yes',
    `RuntimeMaxSec=${seconds(Math.max(0, options.remainingTurnMs) + stop)}`,
    'TasksAccounting=yes',
    'StandardInput=null',
    'StandardOutput=null',
    'StandardError=null',
    'Delegate=yes',
    'WatchdogSec=10s',
    'WatchdogSignal=SIGKILL',
    'NotifyAccess=all',
    'Restart=no',
    'Environment=',
    `UnsetEnvironment=${unsetEnvironmentList(options.managerEnvNames).join(' ')}`,
  ].map((p) => `--property=${p}`)
}

/**
 * The exact `systemd-run --user` command line of design section 1: argv for execFile, never a shell string. The first
 * program is `env -i` with the fixed variables, so the supervisor starts with exactly those whatever the manager
 * imported later.
 */
export function buildSystemRun(options: UnitLaunchOptions): { file: string; args: string[] } {
  if (!validateUnitName(options.unit)) throw new Error('invalid unit name')
  assertValue('home', options.home, true)
  assertValue('node', options.node, true)
  assertValue('supervisor', options.supervisor, true)
  assertValue('spec', options.spec, true)
  assertValue('notify socket', options.notifySocket, true)
  const path = options.pinnedPath ?? PINNED_PATH
  assertValue('PATH', path)
  const env = options.envBin ?? ENV_BIN
  const args = [
    '--user',
    '--no-ask-password',
    '--expand-environment=no',
    `--unit=${options.unit}`,
    '--description=Score coding run',
    ...unitProperties(options),
    `--setenv=PATH=${path}`,
    `--setenv=HOME=${options.home}`,
    '--setenv=LANG=C.UTF-8',
    '--',
    env,
    '-i',
    `PATH=${path}`,
    `HOME=${options.home}`,
    'LANG=C.UTF-8',
    `NOTIFY_SOCKET=${options.notifySocket}`,
    options.node,
    '--no-warnings',
    options.supervisor,
    options.spec,
  ]
  return { file: options.systemdRun ?? SYSTEMD_RUN, args }
}

// ---- systemctl output ----------------------------------------------------------------------------------------------

/** Parses `systemctl show` output (KEY=value lines; a line without `=` is ignored). */
export function parseShow(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) out.set(line.slice(0, eq), line.slice(eq + 1))
  }
  return out
}

export interface UnitState {
  loadState: string
  activeState: string
  subState: string
  mainPid: number
  invocationId: string
  controlGroup: string
  result: string
  /** A job (start/stop) is queued or running for the unit. */
  jobPending: boolean
}

export type UnitLookup =
  { kind: 'present'; state: UnitState } | { kind: 'absent' } | { kind: 'unknown'; detail: string }

export function parseUnitState(text: string): UnitState {
  const m = parseShow(text)
  const job = m.get('Job') ?? ''
  return {
    loadState: m.get('LoadState') ?? '',
    activeState: m.get('ActiveState') ?? '',
    subState: m.get('SubState') ?? '',
    mainPid: Number(m.get('MainPID') ?? '0') || 0,
    invocationId: m.get('InvocationID') ?? '',
    controlGroup: m.get('ControlGroup') ?? '',
    result: m.get('Result') ?? '',
    jobPending: job !== '' && job !== '0',
  }
}

const SHOW_PROPS = [
  'LoadState',
  'ActiveState',
  'SubState',
  'MainPID',
  'InvocationID',
  'ControlGroup',
  'Result',
  'Job',
]

/**
 * Looks at one unit. A transport or permission error is `unknown`, never `absent` (design section 5): only systemd
 * saying "not-found" means the unit is gone.
 */
export async function showUnit(run: RunTool, name: string): Promise<UnitLookup> {
  if (!validateUnitName(name)) return { kind: 'unknown', detail: 'invalid unit name' }
  const r = await run(SYSTEMCTL, [
    '--user',
    'show',
    ...SHOW_PROPS.map((p) => `--property=${p}`),
    '--',
    name,
  ])
  if (r.code !== 0) return { kind: 'unknown', detail: r.failed ?? r.stderr.trim().slice(0, 200) }
  const state = parseUnitState(r.stdout)
  if (state.loadState === '') return { kind: 'unknown', detail: 'no LoadState in output' }
  if (state.loadState === 'not-found') return { kind: 'absent' }
  return { kind: 'present', state }
}

/** Units of this installation the manager has loaded (active, failed or inactive). Transport errors are `unknown`. */
export async function listInstallationUnits(
  run: RunTool,
  prefix: string,
): Promise<{ kind: 'ok'; names: string[] } | { kind: 'unknown'; detail: string }> {
  const r = await run(SYSTEMCTL, [
    '--user',
    'list-units',
    '--all',
    '--plain',
    '--no-legend',
    '--no-pager',
    '--full',
    '--type=service',
    `${prefix}*`,
  ])
  if (r.code !== 0) return { kind: 'unknown', detail: r.failed ?? r.stderr.trim().slice(0, 200) }
  const names = r.stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[0] ?? '')
    // A failed unit is listed with a bullet in front of the name on some versions.
    .map((name) => name.replace(/^[●*]+/, ''))
    .filter((name) => name.startsWith(prefix) && validateUnitName(name))
  return { kind: 'ok', names: [...new Set(names)] }
}

/** Names of the variables the user manager exports (`show-environment`): added to the unit's deny list. */
export async function managerEnvironmentNames(run: RunTool): Promise<string[]> {
  const r = await run(SYSTEMCTL, ['--user', 'show-environment'])
  if (r.code !== 0) return []
  return r.stdout
    .split('\n')
    .map((line) => line.slice(0, Math.max(0, line.indexOf('='))))
    .filter((name) => ENV_NAME.test(name))
}

export type UnitAction = 'stopped' | 'reset' | 'absent' | 'mismatch' | 'uncertain' | 'unknown'

const ACTIVE = new Set(['active', 'activating', 'deactivating', 'reloading', 'refreshing'])

/**
 * `systemctl --user stop <exact name>`, only while the unit's InvocationID is the recorded one, and re-checked after
 * the call (design section 6b): a mismatch after the call is uncertainty (fence), not success.
 */
export async function stopUnit(
  run: RunTool,
  name: string,
  invocationId: string,
): Promise<UnitAction> {
  return actOnUnit(run, name, invocationId, 'stop')
}

/** `reset-failed` (collection), with the same exact-name and InvocationID gate; only after settled + ended proof. */
export async function resetUnit(
  run: RunTool,
  name: string,
  invocationId: string,
): Promise<UnitAction> {
  return actOnUnit(run, name, invocationId, 'reset-failed')
}

async function actOnUnit(
  run: RunTool,
  name: string,
  invocationId: string,
  verb: 'stop' | 'reset-failed',
): Promise<UnitAction> {
  if (!validateUnitName(name) || invocationId === '') return 'unknown'
  const before = await showUnit(run, name)
  if (before.kind === 'unknown') return 'unknown'
  if (before.kind === 'absent') return 'absent'
  if (before.state.invocationId !== invocationId) return 'mismatch'
  const done = await run(SYSTEMCTL, ['--user', verb, '--', name], { timeoutMs: 60_000 })
  if (done.failed) return 'unknown'
  const after = await showUnit(run, name)
  if (after.kind === 'unknown') return 'unknown'
  if (after.kind === 'absent') return verb === 'stop' ? 'stopped' : 'reset'
  if (after.state.invocationId !== invocationId) return 'uncertain'
  if (verb === 'stop')
    return ACTIVE.has(after.state.activeState) || after.state.jobPending ? 'uncertain' : 'stopped'
  return after.state.activeState === 'failed' ? 'uncertain' : 'reset'
}

// ---- cgroup --------------------------------------------------------------------------------------------------------

export type Population = 'populated' | 'empty' | 'absent' | 'unknown'

/** Parses `cgroup.events` (`populated 0|1` is recursive over descendants). */
export function parseCgroupEvents(text: string): Population {
  const m = /^populated (\d)$/m.exec(text)
  return m ? (m[1] === '0' ? 'empty' : 'populated') : 'unknown'
}

/** Whether a cgroup (the unit's `ControlGroup`, a path like `/user.slice/…/x.service`) still holds processes. */
export function cgroupPopulation(controlGroup: string, root = CGROUP_ROOT): Population {
  if (!controlGroup.startsWith('/') || controlGroup.split('/').includes('..')) return 'unknown'
  const dir = `${root}${controlGroup}`
  try {
    return parseCgroupEvents(readFileSync(`${dir}/cgroup.events`, 'utf8'))
  } catch (error) {
    // The directory is removed once the unit is gone, which is the "absent" proof; anything else is unreadable.
    return (error as NodeJS.ErrnoException).code === 'ENOENT' && !existsSync(dir)
      ? 'absent'
      : 'unknown'
  }
}

// ---- manager incarnation -------------------------------------------------------------------------------------------

export interface ManagerIncarnation {
  pid: number
  start: string
}

/**
 * The user manager's identity (PID + start time): read from the system manager's `user@<uid>.service` and /proc, so
 * it survives the user manager being down or replaced. null when it can't be read (never a guess).
 */
export async function managerIncarnation(
  run: RunTool,
  uid: number = process.getuid!(),
  readStart: (pid: number) => string | null = processStart,
): Promise<ManagerIncarnation | null> {
  const r = await run(SYSTEMCTL, ['show', '--property=MainPID', '--', `user@${uid}.service`])
  if (r.code !== 0) return null
  const pid = Number(parseShow(r.stdout).get('MainPID') ?? '0')
  if (!Number.isInteger(pid) || pid <= 1) return null
  const start = readStart(pid)
  return start === null ? null : { pid, start }
}

export function sameIncarnation(
  a: ManagerIncarnation | null,
  b: ManagerIncarnation | null,
): boolean {
  return a !== null && b !== null && a.pid === b.pid && a.start === b.start
}

// ---- capability check ----------------------------------------------------------------------------------------------

export interface CapabilityCheck {
  name: 'manager' | 'cgroup-v2' | 'linger' | 'socket-path' | 'properties'
  ok: boolean
  detail: string
}

export interface CapabilityOptions {
  run: RunTool
  uid?: number
  socketPath: string
  cgroupRoot?: string
  /** Probe that the manager accepts every property by running a throwaway `/usr/bin/true` unit. */
  probeProperties?: boolean
  graceMs?: number
}

export const MAX_SOCKET_PATH = 100

/** Design sections 7/8: can this host run coding runs as units? Each check reports why it failed. */
export async function checkCapabilities(
  options: CapabilityOptions,
): Promise<{ ok: boolean; checks: CapabilityCheck[] }> {
  const { run } = options
  const checks: CapabilityCheck[] = []
  const manager = await run(SYSTEMCTL, ['--user', 'show', '--property=Version'])
  checks.push({
    name: 'manager',
    ok: manager.code === 0 && /^Version=/m.test(manager.stdout),
    detail:
      manager.code === 0
        ? 'user manager reachable'
        : `user manager unreachable: ${manager.failed ?? manager.stderr.trim().slice(0, 120)}`,
  })
  const root = options.cgroupRoot ?? CGROUP_ROOT
  const v2 = existsSync(`${root}/cgroup.controllers`)
  checks.push({
    name: 'cgroup-v2',
    ok: v2,
    detail: v2 ? 'cgroup v2 (unified)' : 'cgroup v2 is not mounted',
  })
  const uid = options.uid ?? process.getuid!()
  const linger = await run(LOGINCTL, ['show-user', String(uid), '--property=Linger'])
  const lingerOn = linger.code === 0 && /^Linger=yes$/m.test(linger.stdout)
  checks.push({
    name: 'linger',
    ok: lingerOn,
    detail: lingerOn
      ? 'linger enabled'
      : 'linger is off: the user manager would stop at logout (loginctl enable-linger)',
  })
  const length = Buffer.byteLength(options.socketPath)
  checks.push({
    name: 'socket-path',
    ok: length <= MAX_SOCKET_PATH,
    detail:
      length <= MAX_SOCKET_PATH
        ? `socket path ${length} bytes`
        : `socket path is ${length} bytes (limit ${MAX_SOCKET_PATH})`,
  })
  if (options.probeProperties) {
    const unit = `score-probe-${Math.random().toString(36).slice(2, 10)}.service`
    const props = unitProperties({ graceMs: options.graceMs ?? 5000, remainingTurnMs: 60_000 })
    const r = await run(
      SYSTEMD_RUN,
      [
        '--user',
        '--quiet',
        '--wait',
        '--collect',
        '--no-ask-password',
        `--unit=${unit}`,
        ...props,
        '--',
        '/usr/bin/true',
      ],
      { timeoutMs: 30_000 },
    )
    checks.push({
      name: 'properties',
      ok: r.code === 0,
      detail:
        r.code === 0
          ? 'manager accepts the unit properties'
          : `systemd-run refused: ${r.stderr.trim().slice(0, 160)}`,
    })
  }
  return { ok: checks.every((c) => c.ok), checks }
}
