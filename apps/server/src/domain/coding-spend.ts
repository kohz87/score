import type { CostKind, Runtime } from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

export interface CodingSpend {
  agentId: string
  runtime: Runtime
  /** null = no run in the window gave a cost. */
  costUsd: number | null
  basis: CostKind
}

/**
 * Spend of coding agents in [from, to] (epoch ms), from their own runs. Claude Code reports an API-price
 * equivalent (a subscription isn't billed per token), so it is "estimated"; Codex gives tokens only, so its spend is
 * "unknown" and never counted as zero. An agent with no runs in the window spent nothing.
 */
export function codingSpendInWindow(sqlite: DatabaseSync, from: number, to: number): CodingSpend[] {
  const rows = z
    .array(
      z.object({
        profile: z.string(),
        runtime: z.string(),
        runs: z.int(),
        priced: z.int(),
        cost: z.number().nullable(),
      }),
    )
    .parse(
      sqlite
        .prepare(
          `SELECT profile, runtime, count(*) AS runs, count(cost_usd) AS priced, sum(cost_usd) AS cost
           FROM runs WHERE runtime != 'hermes' AND started_at >= ? AND started_at <= ?
           GROUP BY profile, runtime`,
        )
        .all(new Date(from).toISOString(), new Date(to).toISOString()),
    )
  return rows.map((row) => ({
    agentId: row.profile,
    runtime: row.runtime as Runtime,
    costUsd: row.priced > 0 ? Math.round((row.cost ?? 0) * 100) / 100 : null,
    basis: row.priced > 0 ? 'estimated' : 'unknown',
  }))
}
