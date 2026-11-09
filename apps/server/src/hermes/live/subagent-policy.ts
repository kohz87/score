import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { effectiveLimits } from '../../domain/subagents.ts'

// The limits a session runs under, for the plugin's guard to read at each delegate_task (hermes-plugin/score_bridge/
// subagent_guard.py; docs/API-CONTRACT.md §19). A file, because a hook that called Score could stall a whole profile.

export interface SubagentPolicy {
  v: 1
  inline: boolean
  enabled: boolean
  maxConcurrent: number
  maxTotal: number
  used: number
}

/** Steps for each subagent, as in the approved mock-up (Hermes' own default is 250). */
export const DEFAULT_MAX_ITERATIONS = 50

/** A session id is not a safe file name. The plugin computes the same one. */
export const subagentPolicyPath = (scoreHome: string, sessionId: string): string =>
  join(scoreHome, 'subagents', `${createHash('sha256').update(sessionId).digest('hex')}.json`)

/** Written whole, so the guard never reads half a file: anything it can't parse it refuses. */
export function writeSubagentPolicy(
  scoreHome: string,
  sessionId: string,
  policy: SubagentPolicy,
): void {
  const path = subagentPolicyPath(scoreHome, sessionId)
  mkdirSync(join(scoreHome, 'subagents'), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(policy), { mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

/**
 * A session runs inline only when its profile went inline before the session began: Hermes freezes the mode when a
 * session starts. `hermesStartedAtMs`: when Hermes says it began (a room can continue a session Score never ran); null
 * for one Hermes doesn't have yet, which this run will start.
 */
export function sessionIsInline(
  sqlite: DatabaseSync,
  profile: string,
  sessionId: string,
  hermesStartedAtMs: number | null,
): boolean {
  const setup = sqlite
    .prepare('SELECT inline_since FROM subagent_agents WHERE profile = ?')
    .get(profile) as { inline_since: string | null } | undefined
  if (!setup?.inline_since) return false
  if (hermesStartedAtMs !== null && hermesStartedAtMs < Date.parse(setup.inline_since)) return false
  return (
    sqlite
      .prepare('SELECT 1 FROM runs WHERE profile = ? AND session_id = ? AND started_at < ? LIMIT 1')
      .get(profile, sessionId, setup.inline_since) === undefined
  )
}

export function subagentPolicyFor(
  sqlite: DatabaseSync,
  profile: string,
  sessionId: string,
  jobId: string | null,
  hermesStartedAtMs: number | null,
): SubagentPolicy {
  return {
    v: 1,
    inline: sessionIsInline(sqlite, profile, sessionId, hermesStartedAtMs),
    ...effectiveLimits(sqlite, profile, jobId),
  }
}
