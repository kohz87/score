import { ENV_BIN, PINNED_PATH, SYSTEMD_RUN, unsetEnvironmentList } from './unit-systemd-types.ts'
import { validateUnitName } from './unit-names.ts'

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
