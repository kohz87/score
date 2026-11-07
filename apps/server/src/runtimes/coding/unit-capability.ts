import { existsSync } from 'node:fs'
import { processStart } from './proc.ts'
import {
  CGROUP_ROOT,
  LOGINCTL,
  SYSTEMCTL,
  SYSTEMD_RUN,
  type RunTool,
} from './unit-systemd-types.ts'
import { unitProperties } from './unit-launch.ts'
import { parseShow } from './unit-systemctl.ts'

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
