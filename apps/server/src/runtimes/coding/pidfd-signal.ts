import { execFileSync } from 'node:child_process'
import { constants } from 'node:os'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('./pidfd-signal.py', import.meta.url))

/** `signalled`: delivered through the pidfd. `mismatch`: not the recorded process (or gone). `unavailable`: no way to prove identity. */
export type PidSignalResult = 'signalled' | 'mismatch' | 'unavailable'

export interface PidfdSupport {
  /** The interpreter that passed the probe, or null. */
  python: string | null
  detail: string
}

let cached: PidfdSupport | undefined

/** Probes `python3` (or `SCORE_PYTHON`) for pidfd support, once. Without it nothing is ever signalled by pid number. */
export function pidfdSupport(candidate = process.env.SCORE_PYTHON || 'python3'): PidfdSupport {
  if (candidate === (process.env.SCORE_PYTHON || 'python3') && cached) return cached
  let found: PidfdSupport
  try {
    execFileSync(candidate, ['-I', SCRIPT, '--probe'], { stdio: 'ignore', timeout: 5000 })
    found = { python: candidate, detail: `pidfd signalling via ${candidate}` }
  } catch (error) {
    const status = (error as { status?: number }).status
    found = {
      python: null,
      detail:
        status === 4
          ? `${candidate} has no pidfd support: process-group fallback signalling is disabled`
          : `${candidate} is not usable: process-group fallback signalling is disabled`,
    }
  }
  if (candidate === (process.env.SCORE_PYTHON || 'python3')) cached = found
  return found
}

/** Test hook: forget the probe result. */
export function resetPidfdSupport(): void {
  cached = undefined
}

function run(python: string | null, args: string[]): PidSignalResult {
  if (python === null) return 'unavailable'
  try {
    execFileSync(python, ['-I', SCRIPT, ...args], { stdio: 'ignore', timeout: 5000 })
    return 'signalled'
  } catch (error) {
    return (error as { status?: number }).status === 3 ? 'mismatch' : 'unavailable'
  }
}

function signum(signal: NodeJS.Signals | 0): number | undefined {
  return signal === 0 ? 0 : constants.signals[signal]
}

const validTarget = (pid: number, startTime: string) =>
  Number.isInteger(pid) && pid > 1 && /^\d+$/.test(startTime)

/**
 * Signals one process only if it still has the recorded start time, checked while a pidfd pins it, so the pid can't
 * have been reused between the check and the signal. Signal 0 verifies identity without signalling.
 */
export function signalPid(
  pid: number,
  startTime: string,
  signal: NodeJS.Signals | 0,
  python: string | null = pidfdSupport().python,
): PidSignalResult {
  const num = signum(signal)
  if (!validTarget(pid, startTime) || num === undefined) return 'unavailable'
  return run(python, [String(num), `${pid}:${startTime}`])
}

/**
 * Signals the whole process group led by `leader` through the leader's pidfd (PIDFD_SIGNAL_PROCESS_GROUP), after the
 * start time matched while the pidfd was held. The group number is never used. `unavailable` also covers a kernel
 * without the flag (EINVAL).
 */
export function signalGroup(
  leader: number,
  startTime: string,
  signal: NodeJS.Signals,
  python: string | null = pidfdSupport().python,
): PidSignalResult {
  const num = signum(signal)
  if (!validTarget(leader, startTime) || num === undefined) return 'unavailable'
  return run(python, ['--group', String(num), `${leader}:${startTime}`])
}
