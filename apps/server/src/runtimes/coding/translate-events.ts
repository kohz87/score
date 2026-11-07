import { SubagentSummarySchema, type SubagentSummary } from '@score/contract'
import { z } from 'zod'
import { appendRunMessage, liveActivityDraft, noteRunProgress } from '../../domain/message-runs.ts'
import { OUTPUT_BYTES, tailBytes } from '../../domain/watch-frames.ts'
import type { DomainEventDraft, Observation } from '../../hub/ingest.ts'
import { redact, redactBounded } from '../../redact.ts'
import { readRun, runDraft, runLifecycle } from '../../hermes/index.ts'
import { boundEvent, MAX_REMEMBERED_IDS, redactNote } from './note.ts'
import { chargeObservation } from '../../domain/orchestration/ops.ts'
import { rememberCliSession } from './store.ts'
import type { CodingEvent } from './types.ts'
import { framesFor } from './translate-frames.ts'
import { setRun } from './translate-runs.ts'
import type { RunTranslation } from './translate-types.ts'

const MAX_THINKING_CHARS = 4096
const boundCallId = (id: string) => id.slice(0, 200)

/**
 * One parsed CLI event as an observation. Everything stored is redacted here: tool previews, thinking, frames and
 * the reply text (which `appendRunMessage` redacts once it settles).
 */
export function eventObservation(
  translation: RunTranslation,
  rawEvent: CodingEvent,
  index: number,
): Observation {
  const { runId, agentId } = translation
  // Whatever a parser handed over, the values kept past this point are bounded (re-review #18).
  const event = boundEvent(rawEvent)
  return {
    source: `coding:${agentId}`,
    identity: `coding:${runId}:${index}`,
    apply({ sqlite, now }) {
      const row = readRun(sqlite, runId)
      if (runLifecycle.isTerminal(row.status)) return []
      const drafts: DomainEventDraft[] = []
      const progress = noteRunProgress(sqlite, runId, now, { announce: event.kind !== 'text' })
      drafts.push(...progress)
      translation.seq++
      const seq = translation.seq
      switch (event.kind) {
        case 'session': {
          setRun(sqlite, runId, now, {
            session_id: event.sessionId,
            ...(event.model ? { model: event.model } : {}),
          })
          // Durable as soon as it is known: a restart keeps the session so the next turn resumes it. An owned run keeps
          // its session on its run row only: Chat's cache for that room is never overwritten (7.7b §6).
          if (translation.jobId && !translation.owned)
            rememberCliSession(sqlite, translation.jobId, agentId, event.sessionId, now)
          drafts.push(runDraft(sqlite, runId))
          break
        }
        case 'text':
          drafts.push(...appendRunMessage(sqlite, runId, event.text, now))
          break
        case 'thinking':
          // An orchestration's coding run charges what it keeps to the run's allowance and drops the row when none is
          // left; the protected reserve for Stop and obligation evidence is never spent here (design §11).
          if (chargeObservation(sqlite, runId, MAX_THINKING_CHARS * 4))
            sqlite
              .prepare(
                'INSERT INTO run_thinking (run_id, seq, text) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
              )
              .run(runId, seq, redactBounded(event.text, MAX_THINKING_CHARS))
          break
        case 'tool_start': {
          // Calls that never end must not pile up: past the limit the oldest is forgotten (its end is then ignored).
          if (translation.calls.size >= MAX_REMEMBERED_IDS)
            translation.calls.delete(translation.calls.keys().next().value as string)
          translation.calls.set(event.callId, {
            seq,
            startedAt: now,
            ...(event.detail ? { detail: event.detail } : {}),
            ...(event.parentCallId ? { parentCallId: boundCallId(event.parentCallId) } : {}),
          })
          // CLI metadata is redacted before it is bounded or stored: tool names and what is derived from them (#12).
          const toolName = redactNote(event.tool, 200)
          // The whole bounded row is charged at the start: preview, result preview and overhead.
          if (chargeObservation(sqlite, runId, 2048 + 2000 + 256)) {
            sqlite
              .prepare(
                `INSERT INTO tool_calls (run_id, seq, tool, preview, status, started_at, call_id, parent_call_id) VALUES (?, ?, ?, ?, 'running', ?, ?, ?) ON CONFLICT DO NOTHING`,
              )
              .run(
                runId,
                seq,
                toolName,
                redactBounded(event.preview, 2048),
                now,
                event.callId,
                event.parentCallId ?? null,
              )
            const tools = z
              .array(z.object({ tool: z.string() }))
              .parse(
                sqlite
                  .prepare('SELECT DISTINCT tool FROM tool_calls WHERE run_id = ? ORDER BY seq')
                  .all(runId),
              )
            setRun(sqlite, runId, now, {
              tools_used: JSON.stringify(tools.map(({ tool }) => tool)),
            })
          }
          drafts.push({
            type: 'log.line',
            data: {
              id: `coding:${runId}:${seq}`,
              at: now,
              agentId,
              kind: 'tool',
              text: redactBounded(`${toolName}: ${event.preview}`, 2048),
              callId: boundCallId(event.callId),
              ...(event.parentCallId ? { parentCallId: boundCallId(event.parentCallId) } : {}),
            },
          })
          drafts.push(...liveActivityDraft(sqlite, runId))
          if (event.detail)
            drafts.push(
              ...framesFor(
                sqlite,
                translation,
                event.callId,
                now,
                event.detail,
                { hook: 'pre' },
                event.parentCallId ? boundCallId(event.parentCallId) : null,
              ),
            )
          break
        }
        case 'tool_end': {
          const call = translation.calls.get(event.callId)
          if (!call) break
          translation.calls.delete(event.callId)
          sqlite
            .prepare(
              `UPDATE tool_calls SET status = ?, ended_at = ?, duration_ms = ?, result_preview = ? WHERE run_id = ? AND seq = ?`,
            )
            .run(
              event.ok ? 'ok' : 'error',
              now,
              Math.max(0, Date.parse(now) - Date.parse(call.startedAt)),
              redactBounded(event.preview, 2000).slice(0, 500),
              runId,
              call.seq,
            )
          drafts.push(...liveActivityDraft(sqlite, runId))
          if (call.detail)
            drafts.push(
              ...framesFor(
                sqlite,
                translation,
                event.callId,
                now,
                call.detail,
                {
                  hook: 'post',
                  ok: event.ok,
                  // Redact the whole result first: a tail cut can remove the label that marks the value as secret.
                  output: tailBytes(redact(event.preview), OUTPUT_BYTES - 40).text,
                  exitCode: event.exitCode ?? null,
                },
                call.parentCallId ?? null,
              ),
            )
          break
        }
        case 'usage':
          translation.usage = {
            input: Math.round(event.inputTokens),
            output: Math.round(event.outputTokens),
            costUsd: event.costUsd ?? null,
            ...(event.ttftMs !== undefined ? { ttftMs: event.ttftMs } : {}),
          }
          break
        case 'subagent':
          // The sub-agent's own status lands on the Agent call's row (PLAN 8.7); it never changes the run.
          if (chargeObservation(sqlite, runId, 512)) {
            const row = sqlite
              .prepare('SELECT seq, subagent FROM tool_calls WHERE run_id = ? AND call_id = ?')
              .get(runId, event.callId) as { seq: number; subagent: string | null } | undefined
            if (row) {
              const next = mergeSubagent(row.subagent, event)
              sqlite
                .prepare('UPDATE tool_calls SET subagent = ? WHERE run_id = ? AND seq = ?')
                .run(JSON.stringify(next), runId, row.seq)
              drafts.push(...liveActivityDraft(sqlite, runId))
              // Flow's step log refreshes on log lines; this one carries the new summary.
              drafts.push({
                type: 'log.line',
                data: {
                  id: `coding:${runId}:${row.seq}:sub:${seq}`,
                  at: now,
                  agentId,
                  kind: 'tool',
                  text: `Sub-agent ${next.status === 'running' ? 'working' : next.status}`,
                  callId: boundCallId(event.callId),
                  subagent: next,
                },
              })
            }
          }
          break
        case 'result':
          break
      }
      return drafts
    },
  }
}

function readStoredSubagent(stored: string | null): SubagentSummary | null {
  try {
    const parsed = SubagentSummarySchema.safeParse(stored === null ? null : JSON.parse(stored))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Folds one sub-agent event into the stored summary; an unreadable stored value counts as absent. */
function mergeSubagent(
  stored: string | null,
  event: Extract<CodingEvent, { kind: 'subagent' }>,
): SubagentSummary {
  const before = readStoredSubagent(stored)
  const count = (value: number | undefined, old: number | null | undefined) =>
    value === undefined ? (old ?? null) : Math.max(0, Math.round(value))
  return {
    // A finished sub-agent is not reopened by a late progress record.
    status:
      before && before.status !== 'running' && event.status === 'running'
        ? before.status
        : event.status,
    description:
      event.description === undefined
        ? (before?.description ?? null)
        : redactBounded(event.description, 300),
    subagentType:
      event.subagentType === undefined
        ? (before?.subagentType ?? null)
        : redactBounded(event.subagentType, 100),
    toolCalls: count(event.toolCalls, before?.toolCalls),
    durationMs: count(event.durationMs, before?.durationMs),
    totalTokens: count(event.totalTokens, before?.totalTokens),
  }
}
