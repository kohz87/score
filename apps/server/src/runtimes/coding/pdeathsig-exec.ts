import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('./pdeathsig-exec.py', import.meta.url))

export const PDEATHSIG_SCRIPT = SCRIPT
/** The gate descriptor in the child: the launcher waits on it for the "g" byte Score writes once the process is recorded. */
export const GATE_FD = 3

export interface PdeathsigSupport {
  /** Absolute path of the interpreter that passed the probe, or null. */
  python: string | null
  detail: string
}

let cached: PdeathsigSupport | undefined

/**
 * Probes `python3` (or `SCORE_PYTHON`) for prctl(PR_SET_PDEATHSIG), once. Without it the fallback does not start
 * coding turns: a CLI that would outlive Score is not launched at all.
 */
export function pdeathsigSupport(
  candidate = process.env.SCORE_PYTHON || 'python3',
): PdeathsigSupport {
  const isDefault = candidate === (process.env.SCORE_PYTHON || 'python3')
  if (isDefault && cached) return cached
  let found: PdeathsigSupport
  try {
    const out = execFileSync(candidate, ['-I', SCRIPT, '--probe'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim()
    found = out.startsWith('/')
      ? { python: out, detail: `parent-death cleanup via ${out}` }
      : { python: null, detail: `${candidate} gave an unexpected answer` }
  } catch {
    found = {
      python: null,
      detail: `Coding agents need Python 3 on Linux (python3 or SCORE_PYTHON) so a CLI stops when Score does; it was not found or does not support it.`,
    }
  }
  if (isDefault) cached = found
  return found
}

/** Test hook: forget the probe result. */
export function resetPdeathsigSupport(): void {
  cached = undefined
}
