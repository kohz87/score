import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { uptime } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

const LockSchema = z.object({ pid: z.int().positive(), startedAt: z.iso.datetime() })
type LockOwner = z.infer<typeof LockSchema>

// An unreadable lock younger than this is assumed to be mid-write by a starting server.
const UNREADABLE_GRACE_MS = 10_000
// Slack for clock and uptime rounding when comparing a lock's start time with the boot time.
const BOOT_SLACK_MS = 60_000

export interface LockEnvironment {
  now: () => number
  bootTime: () => number
  isAlive: (pid: number) => boolean
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // Permission denial is evidence of a live process, not permission to take its lock.
    return !hasCode(error, 'ESRCH')
  }
}

const defaultEnvironment: LockEnvironment = {
  now: () => Date.now(),
  bootTime: () => Date.now() - uptime() * 1000,
  isAlive: processAlive,
}

type LockState = { kind: 'missing' } | { kind: 'live'; owner: LockOwner } | { kind: 'stale' }

// Stale means: the owner is gone, it predates this boot (its pid may have been reused), or the
// file is unreadable and old enough that its writer must have died mid-write.
function inspect(path: string, env: LockEnvironment): LockState {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return { kind: 'missing' }
    throw error
  }
  let owner: LockOwner
  try {
    owner = LockSchema.parse(JSON.parse(text))
  } catch {
    if (env.now() - statSync(path).mtimeMs >= UNREADABLE_GRACE_MS) return { kind: 'stale' }
    throw new Error(`${path} is being written by a starting Score server; retry in a few seconds`)
  }
  if (Date.parse(owner.startedAt) < env.bootTime() - BOOT_SLACK_MS) return { kind: 'stale' }
  return env.isAlive(owner.pid) ? { kind: 'live', owner } : { kind: 'stale' }
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error
  }
}

export function acquireHomeLock(
  home: string,
  env: LockEnvironment = defaultEnvironment,
): { release(): void } {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const path = join(home, 'score.lock')
  const recovery = join(home, 'score.lock.recovery')
  const owner = { pid: process.pid, startedAt: new Date(env.now()).toISOString() }
  const content = JSON.stringify(owner)

  function rejectLive(state: LockState): void {
    if (state.kind === 'live') {
      throw new Error(`Another Score server (pid ${state.owner.pid}) is using ${home}`)
    }
  }

  try {
    writeFileSync(path, content, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error
    rejectLive(inspect(path, env))
    // Exclusive recovery ownership stops two contenders replacing the same stale lock. A recovery
    // file left by a crashed contender is judged by the same staleness rules, so it can't wedge startup.
    const recoveryState = inspect(recovery, env)
    rejectLive(recoveryState)
    if (recoveryState.kind === 'stale') removeIfPresent(recovery)
    writeFileSync(recovery, content, { flag: 'wx', mode: 0o600 })
    let renamed = false
    try {
      rejectLive(inspect(path, env))
      renameSync(recovery, path)
      renamed = true
    } finally {
      if (!renamed) removeIfPresent(recovery)
    }
  }

  let released = false
  return {
    release() {
      if (released) return
      released = true
      try {
        const stored = LockSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
        if (stored.pid === owner.pid && stored.startedAt === owner.startedAt) unlinkSync(path)
      } catch (error) {
        if (
          !hasCode(error, 'ENOENT') &&
          !(error instanceof SyntaxError) &&
          !(error instanceof z.ZodError)
        )
          throw error
      }
    },
  }
}
