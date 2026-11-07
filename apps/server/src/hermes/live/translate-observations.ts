import { z } from 'zod'
import { requestRunApproval, closeRunApprovals } from '../../domain/approvals.ts'
import { completeRunMessage } from '../../domain/message-runs.ts'
import { closeRunQuestions } from '../../domain/questions.ts'
import { recordRunResult } from '../../domain/workflows/verdict.ts'
import type { Observation } from '../../hub/ingest.ts'
import { redactBounded, redactValue } from '../../redact.ts'
import { GatewayRunSchema, redactRunPayload, type GatewayRun } from './gateway.ts'
import { ApprovalSchema } from './translate-payloads.ts'
import { readRun, runDraft, runLifecycle, updateRun } from './translate-runs.ts'
import type { RunContext } from './translate-types.ts'

/**
 * The approval a polled run status carries while the run waits. SSE normally delivers it, but a stream that
 * was truncated or gave up would otherwise leave the run waiting with nobody asked. Idempotent per request id.
 */
export function statusApprovalObservation(
  context: RunContext,
  run: GatewayRun,
): Observation | null {
  if (run.status !== 'waiting_for_approval') return null
  const safe = redactRunPayload(run.approval)
  const parsed = ApprovalSchema.safeParse(safe)
  if (!parsed.success) return null
  const approval = parsed.data
  const stamp = z.object({ timestamp: z.number().finite().nonnegative() }).safeParse(safe)
  return {
    source: `run-sse:${context.profile}`,
    identity: `run_approval:${context.runId}:${approval.request_id}`,
    apply({ sqlite, now }) {
      const row = readRun(sqlite, context.runId)
      if (
        row.profile !== context.profile ||
        row.credential_generation !== context.credentialGeneration
      )
        throw new Error('Run credential mapping mismatch')
      if (runLifecycle.isTerminal(row.status)) return []
      const at = stamp.success ? new Date(stamp.data.timestamp * 1000).toISOString() : now
      const drafts = requestRunApproval(
        sqlite,
        {
          profile: row.profile,
          runId: row.id,
          requestId: (approval.request_id ?? approval.prompt_id)!,
          command: approval.command,
          description: approval.description,
          choices: approval.choices,
          patternKeys:
            approval.pattern_keys ?? (approval.pattern_key ? [approval.pattern_key] : []),
          ...(approval.expires_at
            ? { expiresAt: approval.expires_at }
            : approval.timeout_s
              ? { expiresAt: new Date(Date.parse(at) + approval.timeout_s * 1000).toISOString() }
              : {}),
        },
        at,
        { disabled: context.getDisabled?.() ?? [] },
      )
      if (updateRun(sqlite, row, now, { status: 'waiting_for_approval' }))
        drafts.push(runDraft(sqlite, row.id))
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
      if (terminal && (safe.status === 'completed' || safe.status === 'failed'))
        recordRunResult(sqlite, row.id, safe.output, now)
      return [
        ...(changed ? [runDraft(sqlite, row.id)] : []),
        ...(terminal ? closeRunApprovals(sqlite, row.id, now) : []),
        ...(terminal ? closeRunQuestions(sqlite, row.id, now) : []),
        ...(terminal
          ? completeRunMessage(sqlite, row.id, now, {
              output: safe.output,
              handoffs: safe.status === 'completed',
              status: safe.status,
              error: safe.error,
            })
          : []),
      ]
    },
  }
}

/**
 * Hermes forgot the run (its record outlived the 24 h retention): end it visibly instead of waiting forever. `stopped`: the person (or Score) asked it to stop and Hermes no longer had it (3.7.1) — it
 * ends as stopped, not interrupted, so nothing treats it as a failure to retry. Same identity as the follower's own.
 */
export function runLostObservation(
  context: RunContext,
  stopped = false,
  reason = 'Hermes no longer has a record of this run',
): Observation {
  return {
    source: `run-sse:${context.profile}`,
    identity: `run_lost:${context.runId}`,
    apply({ sqlite, now }) {
      const row = readRun(sqlite, context.runId)
      if (runLifecycle.isTerminal(row.status)) return []
      const status = stopped ? 'cancelled' : 'interrupted'
      const error = reason
      const changed = updateRun(sqlite, row, now, {
        status,
        ended_at: now,
        error,
      })
      return [
        ...(changed ? [runDraft(sqlite, row.id)] : []),
        ...closeRunApprovals(sqlite, row.id, now),
        ...closeRunQuestions(sqlite, row.id, now),
        ...completeRunMessage(sqlite, row.id, now, {
          handoffs: false,
          status,
          error,
        }),
      ]
    },
  }
}

/** Hermes forgot the run, but its session history still holds the final answer: complete the reply with it. */
export function runRecoveredObservation(context: RunContext, output: string): Observation {
  return {
    source: `run-sse:${context.profile}`,
    identity: `run_lost:${context.runId}`,
    apply({ sqlite, now }) {
      const row = readRun(sqlite, context.runId)
      if (runLifecycle.isTerminal(row.status)) return []
      const reason = 'Run record expired; the result was recovered from the session history'
      const changed = updateRun(sqlite, row, now, {
        status: 'completed',
        terminal_source: 'recovered',
        ended_at: now,
        output: redactBounded(output, 8192),
        error: null,
      })
      sqlite
        .prepare('INSERT INTO gaps (source, run_id, from_ts, to_ts, reason) VALUES (?, ?, ?, ?, ?)')
        .run(`run-sse:${context.profile}`, context.runId, row.updated_at, now, reason)
      return [
        {
          type: 'gap.recorded',
          data: {
            source: `run-sse:${context.profile}`,
            runId: context.runId,
            from: row.updated_at,
            to: now,
            reason,
          },
        },
        ...(changed ? [runDraft(sqlite, row.id)] : []),
        ...closeRunApprovals(sqlite, row.id, now),
        ...closeRunQuestions(sqlite, row.id, now),
        ...completeRunMessage(sqlite, row.id, now, { output, handoffs: true, status: 'completed' }),
      ]
    },
  }
}
