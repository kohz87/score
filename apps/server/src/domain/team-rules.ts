import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { ApprovalModeSchema, type AgentDetail } from '@score/contract'
import { isKnownPatternKey, neverId, type AgentOverrides, type Baseline } from '../hermes/index.ts'

// Team baseline + per-agent stricter-only deltas (task 2.18). The Hermes config itself is written through the
// adapter; this is only Score's record of what the team asked for.
export const DEFAULT_BASELINE: Baseline = { mode: 'smart', goAhead: [], never: [] }
const RowSchema = z.object({
  mode: ApprovalModeSchema,
  go_ahead: z.string(),
  never: z.string(),
})
const List = z.array(z.string())
export function readBaseline(sqlite: DatabaseSync): Baseline {
  const row = sqlite.prepare('SELECT mode, go_ahead, never FROM team_rules WHERE id = 1').get()
  if (!row) return structuredClone(DEFAULT_BASELINE)
  const parsed = RowSchema.parse(row)
  return {
    mode: parsed.mode,
    goAhead: List.parse(JSON.parse(parsed.go_ahead)),
    never: List.parse(JSON.parse(parsed.never)),
  }
}
export function writeBaseline(sqlite: DatabaseSync, baseline: Baseline, now: string): void {
  sqlite
    .prepare(
      `INSERT INTO team_rules (id, mode, go_ahead, never, updated_at) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET mode = excluded.mode, go_ahead = excluded.go_ahead,
         never = excluded.never, updated_at = excluded.updated_at`,
    )
    .run(baseline.mode, JSON.stringify(baseline.goAhead), JSON.stringify(baseline.never), now)
}

const OverrideRow = z.object({
  kind: z.enum(['without_go_ahead', 'extra_never']),
  value: z.string(),
})
export function readOverrides(sqlite: DatabaseSync, agentId: string): AgentOverrides {
  const rows = z
    .array(OverrideRow)
    .parse(
      sqlite
        .prepare('SELECT kind, value FROM agent_rule_overrides WHERE agent_id = ?')
        .all(agentId),
    )
  return {
    withoutGoAhead: rows.filter((r) => r.kind === 'without_go_ahead').map((r) => r.value),
    extraNever: rows.filter((r) => r.kind === 'extra_never').map((r) => r.value),
  }
}
export function addOverride(
  sqlite: DatabaseSync,
  agentId: string,
  kind: 'without_go_ahead' | 'extra_never',
  value: string,
): void {
  sqlite
    .prepare('INSERT OR IGNORE INTO agent_rule_overrides (agent_id, kind, value) VALUES (?, ?, ?)')
    .run(agentId, kind, value)
}

export function removeOverride(
  sqlite: DatabaseSync,
  agentId: string,
  kind: 'without_go_ahead' | 'extra_never',
  value: string,
): void {
  sqlite
    .prepare('DELETE FROM agent_rule_overrides WHERE agent_id = ? AND kind = ? AND value = ?')
    .run(agentId, kind, value)
}

/** Marks which permission rows simply come from the team baseline (as opposed to this agent's own choice). */
export function withInheritance(sqlite: DatabaseSync, agent: AgentDetail): AgentDetail {
  if (agent.permissions.length === 0) return agent
  const baseline = readBaseline(sqlite)
  const goAhead = new Set(baseline.goAhead.filter(isKnownPatternKey))
  const never = new Set(baseline.never.map(neverId))
  return {
    ...agent,
    permissions: agent.permissions.map((p) => ({
      ...p,
      inherited: p.level === 'never' ? never.has(p.id) : goAhead.has(p.id),
    })),
  }
}
