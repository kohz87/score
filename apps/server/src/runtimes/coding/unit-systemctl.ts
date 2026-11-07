import { ENV_NAME, SYSTEMCTL, type RunTool } from './unit-systemd-types.ts'
import { validateUnitName } from './unit-names.ts'

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
  /** The main process as systemd last ran it (kept after it exited): pid, exit status and how it ended (1 = exited). */
  execMainPid: number
  execMainStatus: number | null
  execMainCode: number | null
}

export type UnitLookup =
  { kind: 'present'; state: UnitState } | { kind: 'absent' } | { kind: 'unknown'; detail: string }

function numberOrNull(text: string | undefined): number | null {
  if (text === undefined || !/^\d+$/.test(text)) return null
  return Number(text)
}

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
    execMainPid: Number(m.get('ExecMainPID') ?? '0') || 0,
    execMainStatus: numberOrNull(m.get('ExecMainStatus')),
    execMainCode: numberOrNull(m.get('ExecMainCode')),
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
  'ExecMainPID',
  'ExecMainStatus',
  'ExecMainCode',
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
