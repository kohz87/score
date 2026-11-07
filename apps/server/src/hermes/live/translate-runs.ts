import { RunSummarySchema, RuntimeSchema, type RunSummary } from '@score/contract'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { z } from 'zod'
import type { DomainEventDraft } from '../../hub/ingest.ts'
import { guardedUpsert, type Lifecycle } from '../../hub/projections.ts'
import { RunStatusSchema } from './gateway.ts'
import { ProfileNameSchema } from './paths.ts'

export const terminalStatuses = ['completed', 'failed', 'cancelled', 'interrupted'] as const
export const runLifecycle: Lifecycle<RunSummary['status']> = {
  parseState: (value) => RunStatusSchema.parse(value),
  isTerminal: (state) => terminalStatuses.includes(state as (typeof terminalStatuses)[number]),
  canTransition: (from, to) => from === to || (!runLifecycle.isTerminal(from) && to !== 'queued'),
}
export const RunRowSchema = z.object({
  id: z.string().min(1),
  profile: ProfileNameSchema,
  origin: RunSummarySchema.shape.origin,
  score_turn_id: z.string().nullable(),
  credential_generation: z.int().positive().nullable(),
  session_id: z.string().nullable(),
  status: RunStatusSchema,
  model: z.string().nullable(),
  started_at: z.iso.datetime(),
  ended_at: z.iso.datetime().nullable(),
  input_tokens: z.int().nonnegative().nullable(),
  output_tokens: z.int().nonnegative().nullable(),
  cost_usd: z.number().finite().nonnegative().nullable(),
  last_seq: z.int().nonnegative().nullable(),
  // PLAN 7.2: coding-agent runs share this table; every other run is a Hermes run.
  runtime: RuntimeSchema.default('hermes'),
  cost_kind: z.enum(['estimated', 'unknown']).nullable().default(null),
  tools_used: z.string().transform((value) => z.array(z.string()).parse(JSON.parse(value))),
  output: z.string().nullable(),
  error: z.string().nullable(),
  version: z.int().nonnegative(),
  updated_at: z.iso.datetime(),
})
export type RunRow = z.infer<typeof RunRowSchema>
export function readRun(sqlite: DatabaseSync, runId: string): RunRow {
  return RunRowSchema.parse(sqlite.prepare('SELECT * FROM runs WHERE id = ?').get(runId))
}
export function runSummary(sqlite: DatabaseSync, runId: string): RunSummary {
  const row = readRun(sqlite, runId)
  const gaps = sqlite
    .prepare(
      'SELECT from_ts AS "from", to_ts AS "to", reason FROM gaps WHERE run_id = ? ORDER BY id',
    )
    .all(runId)
  return RunSummarySchema.parse({
    id: row.id,
    agentId: row.profile,
    origin: row.origin,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    model: row.model,
    toolsUsed: row.tools_used,
    tokens:
      row.input_tokens === null || row.output_tokens === null
        ? null
        : { input: row.input_tokens, output: row.output_tokens },
    costUsd: row.cost_usd,
    ...(row.runtime === 'hermes'
      ? {}
      : { runtime: row.runtime, costKind: row.cost_kind ?? ('unknown' as const) }),
    refs: [],
    gaps,
  })
}
export const runDraft = (sqlite: DatabaseSync, runId: string): DomainEventDraft => ({
  type: 'run.updated',
  data: runSummary(sqlite, runId),
})

export function updateRun(
  sqlite: DatabaseSync,
  row: RunRow,
  now: string,
  values: Record<string, SQLInputValue>,
): boolean {
  // Every terminal writer says where its status came from (fix-h item 1); only Hermes' own word is 'runtime'.
  if (
    typeof values.status === 'string' &&
    runLifecycle.isTerminal(values.status as Parameters<typeof runLifecycle.isTerminal>[0])
  )
    values = { terminal_source: 'runtime', ...values }
  return (
    guardedUpsert(sqlite, {
      table: 'runs',
      key: { id: row.id },
      stateColumn: 'status',
      lifecycle: runLifecycle,
      versionColumn: 'version',
      values: {
        profile: row.profile,
        origin: row.origin,
        started_at: row.started_at,
        status: row.status,
        version: row.version + 1,
        updated_at: now,
        ...values,
      },
    }) === 'applied'
  )
}
