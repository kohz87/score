import type { SubagentSetup, SubagentSetupAgent } from '@score/contract'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { HttpError } from '../../errors.ts'
import type { ScoreDb } from '../../db/index.ts'
import { configJson } from './agent-config.ts'
import type { HermesRunner } from './cli.ts'
import { SUBAGENT_DEFAULTS } from './subagent-policy.ts'

// Whether each Hermes profile is set up for subagents, and the one change that sets it up (docs/API-CONTRACT.md §19).

interface SetupDeps {
  runner: HermesRunner
  hermesHome: string
  /** The profile's own home. */
  home(agentId: string): string
}

const hasGuard = (home: string): boolean =>
  existsSync(join(home, 'plugins', 'score-bridge', 'subagent_guard.py'))

async function readAgent(deps: SetupDeps, agentId: string): Promise<SubagentSetupAgent> {
  const mode = await configJson(deps.runner, deps.hermesHome, agentId, 'delegation.gateway_mode')
  return {
    agentId,
    inline: mode.state === 'ok' && mode.value === 'inline',
    guard: hasGuard(deps.home(agentId)),
  }
}

export async function readSubagentSetup(
  deps: SetupDeps,
  agentIds: readonly string[],
): Promise<SubagentSetup> {
  return { agents: await Promise.all(agentIds.map((agentId) => readAgent(deps, agentId))) }
}

/** Nothing changes unless every agent named can take it: inline without the guard would leave subagents unlimited. */
export async function applySubagentSetup(
  deps: SetupDeps,
  db: ScoreDb,
  known: readonly string[],
  agentIds: readonly string[],
  now: () => string,
): Promise<SubagentSetup> {
  const unknown = agentIds.find((agentId) => !known.includes(agentId))
  if (unknown) throw new HttpError(400, 'bad_request', 'Couldn’t find that agent.')
  const before = await readSubagentSetup(deps, agentIds)
  const unready = before.agents.find((agent) => !agent.guard)
  if (unready)
    throw new HttpError(
      409,
      'conflict',
      `${unready.agentId} needs the updated Score plugin first, so nothing was changed.`,
    )
  for (const { agentId, inline } of before.agents) {
    for (const [key, value] of [
      ['delegation.max_concurrent_children', String(SUBAGENT_DEFAULTS.maxConcurrent)],
      ['delegation.max_iterations', String(SUBAGENT_DEFAULTS.maxIterations)],
      ['delegation.gateway_mode', 'inline'],
    ] as const) {
      const result = await deps
        .runner(['-p', agentId, 'config', 'set', key, value], {
          timeoutMs: 30_000,
          hermesHome: deps.hermesHome,
          closeStdin: true,
        })
        .catch(() => ({ exitCode: -1 }))
      if (result.exitCode !== 0)
        throw new HttpError(502, 'hermes_error', `Hermes didn’t change ${key} for ${agentId}.`)
    }
    // Keeps the first moment while it stays inline: sessions since then are already inline.
    if (!inline || !sinceRecorded(db, agentId)) recordInline(db, agentId, now())
  }
  return readSubagentSetup(deps, agentIds)
}

const sinceRecorded = (db: ScoreDb, profile: string): boolean =>
  db.read(
    (sqlite) =>
      sqlite.prepare('SELECT 1 FROM subagent_setup WHERE profile = ?').get(profile) !== undefined,
  )

function recordInline(db: ScoreDb, profile: string, at: string): void {
  db.tx((sqlite) => {
    sqlite
      .prepare(
        `INSERT INTO subagent_setup (profile, inline_since) VALUES (?, ?)
         ON CONFLICT (profile) DO UPDATE SET inline_since = excluded.inline_since`,
      )
      .run(profile, at)
  })
}
