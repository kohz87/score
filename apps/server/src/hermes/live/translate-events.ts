import { type RunSummary } from '@score/contract'
import type { SQLInputValue } from 'node:sqlite'
import { z } from 'zod'
import {
  requestRunApproval,
  respondRunApproval,
  closeRunApprovals,
} from '../../domain/approvals.ts'
import {
  appendRunMessage,
  completeRunMessage,
  liveActivityDraft,
  noteRunProgress,
} from '../../domain/message-runs.ts'
import { chargeObservation } from '../../domain/orchestration/ops.ts'
import { closeRunQuestions, requestRunQuestion, settleRunQuestion } from '../../domain/questions.ts'
import { recordRunResult } from '../../domain/workflows/verdict.ts'
import type { DomainEventDraft, Observation } from '../../hub/ingest.ts'
import { redactBounded } from '../../redact.ts'
import { redactRunPayload } from './gateway.ts'
import { ProfileNameSchema } from './paths.ts'
import {
  ApprovalSchema,
  ClarifySchema,
  DeltaSchema,
  EnvelopeSchema,
  InterimSchema,
  PASSIVE_EVENTS,
  ReasoningSchema,
  ResponseSchema,
  SettledSchema,
  TerminalSchema,
  ToolCompletedSchema,
  ToolStartedSchema,
} from './translate-payloads.ts'
import { readRun, runDraft, runLifecycle, updateRun } from './translate-runs.ts'
import { MAX_THINKING_CHARS, type RunContext, type RunMetrics } from './translate-types.ts'

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
  // 0.22.5 announces a prompt that left the queue (answered anywhere, withdrawn, or of an older generation) without
  // the choice: known, and the approval closes with the run or Score's own answer.
  const settled = event === 'approval.settled'
  const question = event === 'clarify.request' ? ClarifySchema.parse(safe) : undefined
  const questionSettled =
    event === 'clarify.settled' ? SettledSchema.safeParse(safe).data : undefined
  const passive = PASSIVE_EVENTS.has(event) || event === 'clarify.settled'
  const terminal =
    event.startsWith('run.') && runLifecycle.isTerminal(event.slice(4) as RunSummary['status'])
      ? TerminalSchema.parse(safe)
      : undefined
  // Reply text stays raw here: redacting each chunk on its own would destroy the context a secret split across
  // chunks needs ("Authorization: Bearer" + token). appendRunMessage redacts it once it settles.
  const delta = event === 'message.delta' ? DeltaSchema.parse(value) : undefined
  const interim = event === 'message.interim' ? InterimSchema.parse(value) : undefined
  const ignored = event === 'reasoning.available'
  const reasoning = ignored ? ReasoningSchema.safeParse(safe).data : undefined
  const known = Boolean(
    started ||
    completed ||
    approval ||
    terminal ||
    delta ||
    interim ||
    event === 'approval.responded' ||
    settled ||
    question ||
    passive ||
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
    apply({ sqlite, now }) {
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
              // The schema's refine guarantees one of the two (each non-empty).
              requestId: (approval.request_id ?? approval.prompt_id)!,
              command: approval.command,
              description: approval.description,
              choices: approval.choices,
              patternKeys:
                approval.pattern_keys ?? (approval.pattern_key ? [approval.pattern_key] : []),
              ...(approval.expires_at
                ? { expiresAt: approval.expires_at }
                : approval.timeout_s
                  ? {
                      expiresAt: new Date(Date.parse(at) + approval.timeout_s * 1000).toISOString(),
                    }
                  : {}),
            },
            at,
            { disabled: context.getDisabled?.() ?? [] },
          ),
        )
        if (runLifecycle.isTerminal(row.status))
          drafts.push(...closeRunApprovals(sqlite, row.id, at))
      }
      if (question && !runLifecycle.isTerminal(row.status))
        drafts.push(
          ...requestRunQuestion(
            sqlite,
            {
              profile: row.profile,
              runId: row.id,
              promptId: question.prompt_id,
              generation: question.execution_generation ?? null,
              question: question.question,
              options: question.choices ?? [],
              multiSelect: question.multi_select ?? false,
              expiresAt: question.timeout_s
                ? new Date(Date.parse(at) + question.timeout_s * 1000).toISOString()
                : null,
            },
            at,
          ),
        )
      if (questionSettled)
        drafts.push(...settleRunQuestion(sqlite, row.id, questionSettled.prompt_id, at))
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
      // Any event of a live run is a sign of life for its streaming reply (the stall notice, contract §6). Stamped with
      // Score's own clock: it is what the browser compares against, and Hermes's may differ.
      const progress =
        !runLifecycle.isTerminal(row.status) && !terminal && event !== 'approval.responded'
          ? noteRunProgress(sqlite, row.id, now, { announce: !delta && !interim })
          : []
      drafts.push(...progress)
      // Approval evidence may refine a closed row even when run lifecycle observations are stale.
      if (runLifecycle.isTerminal(row.status) || seq <= (row.last_seq ?? -1)) return drafts
      if (delta || interim || ignored || passive || !known) {
        sqlite
          .prepare('UPDATE runs SET last_seq = ?, updated_at = ? WHERE id = ?')
          .run(seq, at, row.id)
        // Kept for the collapsed thinking part (PLAN 5.25); `safe` is already redacted, and the text is bounded.
        if (reasoning?.text.trim() && chargeObservation(sqlite, row.id, MAX_THINKING_CHARS * 4))
          sqlite
            .prepare(
              'INSERT INTO run_thinking (run_id, seq, text) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
            )
            .run(row.id, seq, redactBounded(reasoning.text, MAX_THINKING_CHARS))
        return [
          // `drafts` holds the progress note and any question raised or settled by this event.
          ...drafts,
          // Reasoning that was kept appears as a collapsed card while the reply is written (PLAN 5.39).
          ...(reasoning?.text.trim() ? liveActivityDraft(sqlite, row.id) : []),
          ...(delta
            ? appendRunMessage(sqlite, row.id, delta.delta, at)
            : interim && !interim.already_streamed
              ? appendRunMessage(sqlite, row.id, interim.text, at)
              : []),
        ]
      }
      const values: Record<string, SQLInputValue> = { last_seq: seq }
      if (!ignored && known) values.status = 'running'
      if (
        started && // The whole bounded row is reserved at the start: preview (2048) and result preview (500 chars, 2000 bytes) and overhead.
        chargeObservation(sqlite, row.id, 2048 + 2000 + 256)
      ) {
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
      // The wire carries no call id. Hermes runs parallel calls concurrently but emits their completions in the
      // original call order (agent/tool_executor.py), so a completion belongs to the OLDEST running call of that name.
      if (completed) {
        sqlite
          .prepare(
            `UPDATE tool_calls SET status = ?, ended_at = ?, duration_ms = ?, result_preview = ? WHERE run_id = ? AND seq = (SELECT seq FROM tool_calls WHERE run_id = ? AND tool = ? AND status = 'running' ORDER BY seq ASC LIMIT 1)`,
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
      // The reply under way shows the tool as a running card, then as done (PLAN 5.39).
      if (started || completed) drafts.push(...liveActivityDraft(sqlite, row.id))
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
        drafts.push(
          ...closeRunApprovals(sqlite, row.id, at),
          ...closeRunQuestions(sqlite, row.id, at),
        )
        values.status = event.slice(4)
        values.ended_at = at
        values.output = terminal.output == null ? null : redactBounded(terminal.output, 8192)
        values.error = terminal.error == null ? null : redactBounded(terminal.error, 2048)
        // Workflow steps keep the complete-reply facts (verdict, bounded output) before the 8 KiB cut above.
        if (event === 'run.completed' || event === 'run.failed')
          recordRunResult(sqlite, row.id, terminal.output ?? null, at)
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
            status: event.slice(4),
            error: terminal.error,
            exitReason: terminal.turn_exit_reason ?? null,
          }),
        )
      return drafts
    },
  }
}
