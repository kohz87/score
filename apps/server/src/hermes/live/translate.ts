import { ApprovalChoiceSchema, RunSummarySchema, type RunSummary } from '@score/contract'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { z } from 'zod'
import {
  requestRunApproval,
  respondRunApproval,
  closeRunApprovals,
} from '../../domain/approvals.ts'
import type { DomainEventDraft, Observation } from '../../hub/ingest.ts'
import { guardedUpsert, type Lifecycle } from '../../hub/projections.ts'
import { redactBounded, redactValue } from '../../redact.ts'
import {
  GatewayRunSchema,
  RunStatusSchema,
  UsageSchema,
  redactRunPayload,
  type GatewayRun,
} from './gateway.ts'
import { appendRunMessage, completeRunMessage } from '../../domain/message-runs.ts'
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
    refs: [],
    gaps,
  })
}
export const runDraft = (sqlite: DatabaseSync, runId: string): DomainEventDraft => ({
  type: 'run.updated',
  data: runSummary(sqlite, runId),
})

export interface RunContext {
  profile: string
  runId: string
  credentialGeneration: number
  getDisabled?: () => readonly string[]
}
const EnvelopeSchema = z.object({
  event: z.string().min(1),
  run_id: z.string().min(1),
  seq: z.int().nonnegative(),
  timestamp: z.number().finite().nonnegative(),
})
const ToolStartedSchema = z.object({ tool: z.string().min(1), preview: z.string() })
const ToolCompletedSchema = ToolStartedSchema.extend({
  duration: z.number().finite().nonnegative(),
  error: z.boolean(),
})
const DeltaSchema = z.object({ delta: z.string() })
const InterimSchema = z.object({ text: z.string(), already_streamed: z.boolean().optional() })
const TerminalSchema = z.object({
  output: z.string().nullish(),
  error: z.string().nullish(),
  usage: UsageSchema.nullish(),
})
const ApprovalSchema = z
  .object({
    command: z.string(),
    description: z.string(),
    request_id: z.string().min(1),
    choices: z.array(ApprovalChoiceSchema),
    pattern_keys: z.array(z.string()).optional(),
    pattern_key: z.string().optional(),
    expires_at: z
      .union([
        z.iso.datetime(),
        z
          .number()
          .finite()
          .nonnegative()
          .max(253402300799)
          .transform((value) => new Date(value * 1000).toISOString()),
      ])
      .optional(),
  })
  .passthrough()
// Other API clients may answer without a request_id (resolve-first or resolve-all); that is evidence we can't bind.
const ResponseSchema = z.object({
  request_id: z.string().min(1).optional(),
  choice: ApprovalChoiceSchema,
  resolved: z.int().nonnegative().optional(),
})
export interface RunMetrics {
  unknownEvents: number
}

function updateRun(
  sqlite: DatabaseSync,
  row: RunRow,
  now: string,
  values: Record<string, SQLInputValue>,
): boolean {
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

export function translateRunEvent(
  context: RunContext,
  value: unknown,
  metrics: RunMetrics,
): Observation {
  ProfileNameSchema.parse(context.profile)
  const safe = redactRunPayload(value)
  const envelope = EnvelopeSchema.parse(safe)
  if (envelope.run_id !== context.runId) throw new Error('Run event belongs to a different run')
  const { event, seq } = envelope
  const at = new Date(envelope.timestamp * 1000).toISOString()
  const started = event === 'tool.started' ? ToolStartedSchema.parse(safe) : undefined
  const completed = event === 'tool.completed' ? ToolCompletedSchema.parse(safe) : undefined
  const approval = event === 'approval.request' ? ApprovalSchema.parse(safe) : undefined
  const responded = event === 'approval.responded' ? ResponseSchema.safeParse(safe).data : undefined
  const terminal =
    event.startsWith('run.') && runLifecycle.isTerminal(event.slice(4) as RunSummary['status'])
      ? TerminalSchema.parse(safe)
      : undefined
  // Reply text stays raw here: redacting each chunk on its own would destroy the context a secret split across
  // chunks needs ("Authorization: Bearer" + token). appendRunMessage redacts it once it settles.
  const delta = event === 'message.delta' ? DeltaSchema.parse(value) : undefined
  const interim = event === 'message.interim' ? InterimSchema.parse(value) : undefined
  const ignored = event === 'reasoning.available'
  const known = Boolean(
    started ||
    completed ||
    approval ||
    terminal ||
    delta ||
    interim ||
    event === 'approval.responded' ||
    ignored,
  )
  return {
    source: `run-sse:${context.profile}`,
    identity: `sse:${context.runId}:${seq}`,
    checkpoint: {
      scope: `run:${context.runId}`,
      position: seq,
      incarnation: `${context.profile}:g${context.credentialGeneration}`,
    },
    apply({ sqlite }) {
      const row = readRun(sqlite, context.runId)
      if (
        row.profile !== context.profile ||
        row.credential_generation !== context.credentialGeneration
      )
        throw new Error('Run credential mapping mismatch')
      if (!known) metrics.unknownEvents++
      const drafts: DomainEventDraft[] = []
      if (approval) {
        drafts.push(
          ...requestRunApproval(
            sqlite,
            {
              profile: row.profile,
              runId: row.id,
              requestId: approval.request_id,
              command: approval.command,
              description: approval.description,
              choices: approval.choices,
              patternKeys:
                approval.pattern_keys ?? (approval.pattern_key ? [approval.pattern_key] : []),
              ...(approval.expires_at ? { expiresAt: approval.expires_at } : {}),
            },
            at,
            { disabled: context.getDisabled?.() ?? [] },
          ),
        )
        if (runLifecycle.isTerminal(row.status))
          drafts.push(...closeRunApprovals(sqlite, row.id, at))
      }
      if (responded?.request_id && (responded.resolved === undefined || responded.resolved === 1))
        drafts.push(
          ...respondRunApproval(
            sqlite,
            row.profile,
            row.id,
            responded.request_id,
            responded.choice,
            at,
          ),
        )
      // Approval evidence may refine a closed row even when run lifecycle observations are stale.
      if (runLifecycle.isTerminal(row.status) || seq <= (row.last_seq ?? -1)) return drafts
      if (delta || interim || ignored || !known) {
        sqlite
          .prepare('UPDATE runs SET last_seq = ?, updated_at = ? WHERE id = ?')
          .run(seq, at, row.id)
        return delta
          ? appendRunMessage(sqlite, row.id, delta.delta, at)
          : interim && !interim.already_streamed
            ? appendRunMessage(sqlite, row.id, interim.text, at)
            : []
      }
      const values: Record<string, SQLInputValue> = { last_seq: seq }
      if (!ignored && known) values.status = 'running'
      if (started) {
        sqlite
          .prepare(
            `INSERT INTO tool_calls (run_id, seq, tool, preview, status, started_at) VALUES (?, ?, ?, ?, 'running', ?) ON CONFLICT DO NOTHING`,
          )
          .run(row.id, seq, started.tool, redactBounded(started.preview, 2048), at)
        const tools = z
          .array(z.object({ tool: z.string() }))
          .parse(
            sqlite
              .prepare('SELECT DISTINCT tool FROM tool_calls WHERE run_id = ? ORDER BY seq')
              .all(row.id),
          )
        values.tools_used = JSON.stringify(tools.map(({ tool }) => tool))
      }
      if (completed) {
        sqlite
          .prepare(
            `UPDATE tool_calls SET status = ?, ended_at = ?, duration_ms = ?, result_preview = ? WHERE run_id = ? AND seq = (SELECT seq FROM tool_calls WHERE run_id = ? AND tool = ? AND status = 'running' ORDER BY seq DESC LIMIT 1)`,
          )
          .run(
            completed.error ? 'error' : 'ok',
            at,
            Math.round(completed.duration * 1000),
            redactBounded(completed.preview, 2000).slice(0, 500),
            row.id,
            row.id,
            completed.tool,
          )
      }
      if (started || completed || approval)
        drafts.push({
          type: 'log.line',
          data: {
            id: `sse:${row.id}:${seq}`,
            at,
            agentId: row.profile,
            kind: approval ? 'approval' : 'tool',
            text: approval
              ? redactBounded(JSON.stringify(approval), 2048)
              : redactBounded(
                  `${(started ?? completed)!.tool}: ${(started ?? completed)!.preview}`,
                  2048,
                ),
          },
        })
      if (approval) values.status = 'waiting_for_approval'
      if (terminal) {
        drafts.push(...closeRunApprovals(sqlite, row.id, at))
        values.status = event.slice(4)
        values.ended_at = at
        values.output = terminal.output == null ? null : redactBounded(terminal.output, 8192)
        values.error = terminal.error == null ? null : redactBounded(terminal.error, 2048)
        if (terminal.usage) {
          values.input_tokens = terminal.usage.input_tokens
          values.output_tokens = terminal.usage.output_tokens
          values.cost_usd = terminal.usage.cost_usd ?? null
        }
      }
      if (updateRun(sqlite, row, at, values) && !ignored && known)
        drafts.push(runDraft(sqlite, row.id))
      if (terminal)
        drafts.push(
          ...completeRunMessage(sqlite, row.id, at, {
            output: terminal.output,
            handoffs: event === 'run.completed',
          }),
        )
      return drafts
    },
  }
}

export function runStatusObservation(context: RunContext, run: GatewayRun): Observation {
  const safe = GatewayRunSchema.parse(redactValue(run))
  if (safe.run_id !== context.runId) throw new Error('Run status belongs to a different run')
  return {
    source: `run-sse:${context.profile}`,
    identity: `run_status:${context.runId}@${safe.status}`,
    apply({ sqlite, now }) {
      const row = readRun(sqlite, context.runId)
      if (
        row.profile !== context.profile ||
        row.credential_generation !== context.credentialGeneration
      )
        throw new Error('Run credential mapping mismatch')
      const terminal = runLifecycle.isTerminal(safe.status)
      const changed = updateRun(sqlite, row, now, {
        status: safe.status,
        session_id: safe.session_id,
        model: safe.model,
        ended_at: terminal ? safe.updated_at : null,
        output: safe.output === null ? null : redactBounded(safe.output, 8192),
        error: safe.error === null ? null : redactBounded(safe.error, 2048),
        ...(safe.usage
          ? {
              input_tokens: safe.usage.input_tokens,
              output_tokens: safe.usage.output_tokens,
              cost_usd: safe.usage.cost_usd ?? null,
            }
          : {}),
      })
      return [
        ...(changed ? [runDraft(sqlite, row.id)] : []),
        ...(terminal ? closeRunApprovals(sqlite, row.id, now) : []),
        ...(terminal
          ? completeRunMessage(sqlite, row.id, now, {
              output: safe.output,
              handoffs: safe.status === 'completed',
            })
          : []),
      ]
    },
  }
}
