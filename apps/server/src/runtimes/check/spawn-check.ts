// 3.13 (decision 150): runs the oracle's command. No shell (argv as the person wrote it), its own process group so a
// timeout or Stop takes every child with it, the terminal's clean environment (none of Score's), and only the end of
// its output kept. Score runs under systemd, so a restart takes a running check down with Score's cgroup; the executor
// then marks it interrupted.

import { spawn } from 'node:child_process'
import { checkRoot, type RootPolicy } from '../../workspace/policy.ts'
import { terminalLaunch } from '../../terminal/env.ts'

export interface CheckRequest {
  argv: string[]
  cwd: string
  timeoutMs: number
  /** Bytes of output kept (the end). */
  keepBytes: number
}
export interface CheckResult {
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  stopped: boolean
  output: string
}
export interface CheckProcess {
  /** SIGTERM, then SIGKILL after a grace; `force` kills at once (Score is shutting down). */
  stop(force?: boolean): void
  done: Promise<CheckResult>
}
/** Starts a check, or says why it can't (the folder is no longer allowed). */
export type CheckSpawner = (request: CheckRequest) => Promise<CheckProcess | { refused: string }>

const KILL_AFTER_MS = 5_000

export function makeCheckSpawner(policy: RootPolicy): CheckSpawner {
  return async (request) => {
    const root = await checkRoot(request.cwd, policy)
    if (!root.ok) return { refused: root.reason }
    const env = { ...terminalLaunch().env, TERM: 'dumb', CI: '1' }
    const child = spawn(request.argv[0]!, request.argv.slice(1), {
      cwd: root.real,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let kept = Buffer.alloc(0)
    const keep = (chunk: Buffer) => {
      kept = Buffer.concat([kept, chunk])
      if (kept.length > request.keepBytes * 2) kept = kept.subarray(kept.length - request.keepBytes)
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    let timedOut = false
    let stopped = false
    // Once the leader has exited its pid may be reused: the group is never signalled again after that (review P2).
    let exited = false
    let killTimer: NodeJS.Timeout | undefined
    const signalGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined || exited) return
      try {
        process.kill(-child.pid, signal)
      } catch {
        // ESRCH: the group is gone already.
      }
    }
    const terminate = (force = false) => {
      signalGroup(force ? 'SIGKILL' : 'SIGTERM')
      if (!force) killTimer ??= setTimeout(() => signalGroup('SIGKILL'), KILL_AFTER_MS)
    }
    const deadline = setTimeout(() => {
      timedOut = true
      terminate()
    }, request.timeoutMs)
    const done = new Promise<CheckResult>((resolve) => {
      let spawnError: string | null = null
      let settled = false
      let exitCode: number | null = null
      let exitSignal: string | null = null
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        clearTimeout(killTimer)
        child.stdout.destroy()
        child.stderr.destroy()
        const output =
          kept.length > request.keepBytes ? kept.subarray(kept.length - request.keepBytes) : kept
        resolve({
          exitCode: spawnError ? null : exitCode,
          signal: exitSignal,
          timedOut,
          stopped,
          output: spawnError ?? output.toString('utf8'),
        })
      }
      child.on('error', (error: NodeJS.ErrnoException) => {
        spawnError =
          error.code === 'ENOENT'
            ? `Couldn’t start “${request.argv[0]}”: no such program.`
            : `Couldn’t start “${request.argv[0]}” (${error.code ?? 'error'}).`
      })
      child.on('exit', (code, signal) => {
        // The verdict is the exit: a deadline or Stop arriving while the rest of the output drains changes nothing.
        clearTimeout(deadline)
        clearTimeout(killTimer)
        exitCode = code
        exitSignal = signal ?? null
        // Anything the command left running in its group goes with it, while the leader's pid still names the group.
        signalGroup('SIGKILL')
        exited = true
        // A process that left the group (setsid) may hold the pipes open: wait briefly for the rest of the output only.
        setTimeout(finish, 2_000).unref()
      })
      child.on('close', (code, signal) => {
        if (exitCode === null) exitCode = code
        exitSignal ??= signal ?? null
        finish()
      })
    })
    return {
      stop(force = false) {
        if (exited) return
        stopped = true
        terminate(force)
      },
      done,
    }
  }
}
