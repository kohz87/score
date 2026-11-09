import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

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

/** The owner's defaults (decision 173), and what Apply sets as the agent's ceiling. */
export const SUBAGENT_DEFAULTS = { maxConcurrent: 4, maxTotal: 20, maxIterations: 50 } as const

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
 * A session runs inline only when its profile has gone inline and the session is new since then: Hermes freezes the mode
 * when a session starts, so one Score already ran before that moment is still in background mode.
 */
export function sessionIsInline(sqlite: DatabaseSync, profile: string, sessionId: string): boolean {
  const setup = sqlite
    .prepare('SELECT inline_since FROM subagent_setup WHERE profile = ?')
    .get(profile) as { inline_since: string } | undefined
  if (!setup) return false
  return (
    sqlite
      .prepare('SELECT 1 FROM runs WHERE profile = ? AND session_id = ? AND started_at < ? LIMIT 1')
      .get(profile, sessionId, setup.inline_since) === undefined
  )
}

export function defaultSubagentPolicy(inline: boolean): SubagentPolicy {
  return {
    v: 1,
    inline,
    enabled: true,
    maxConcurrent: SUBAGENT_DEFAULTS.maxConcurrent,
    maxTotal: SUBAGENT_DEFAULTS.maxTotal,
    used: 0,
  }
}
