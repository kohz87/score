import { endRunningSubagentsOf } from '../../domain/subagent-rows.ts'
import { completeRunMessage } from '../../domain/message-runs.ts'
import { CODING_OUTPUT_BYTES, CODING_RESULT_BYTES } from '../../domain/orchestration/ops.ts'
import { applyCliTtft } from '../../domain/run-speed.ts'
import { recordRunResult } from '../../domain/workflows/verdict.ts'
import { readRun, runDraft, runLifecycle } from '../../hermes/index.ts'
import type { Observation } from '../../hub/ingest.ts'
import { redact, redactBounded } from '../../redact.ts'
import { setRun } from './translate-runs.ts'
import type { RunTranslation, TerminalInfo } from './translate-types.ts'

/** The run ended: record it and finish the room reply (hand-offs only after a clean finish). */
export function terminalObservation(
  translation: RunTranslation,
  info: TerminalInfo,
  key = 'terminal',
): Observation {
  const { runId, agentId } = translation
  return {
    source: `coding:${agentId}`,
    identity: `coding:${runId}:${key}`,
    apply({ sqlite, now }) {
      if (info.group === 'released') {
        sqlite.prepare('DELETE FROM coding_processes WHERE run_id = ?').run(runId)
        sqlite.prepare('DELETE FROM coding_process_members WHERE run_id = ?').run(runId)
      } else if (info.group === 'unconfirmed')
        sqlite.prepare('UPDATE coding_processes SET unresolved = 1 WHERE run_id = ?').run(runId)
      const row = readRun(sqlite, runId)
      if (runLifecycle.isTerminal(row.status)) return []
      const usage = translation.usage
      if (
        info.ownedResult &&
        info.status === 'completed' &&
        info.group !== 'unconfirmed' &&
        typeof info.reply === 'string'
      ) {
        const redacted = redact(info.reply)
        const kept = redactBounded(info.reply, CODING_RESULT_BYTES)
        sqlite
          .prepare(
            'INSERT OR IGNORE INTO coding_run_results (run_id, reply, truncated, created_at) VALUES (?, ?, ?, ?)',
          )
          .run(runId, kept, Buffer.byteLength(redacted) > CODING_RESULT_BYTES ? 1 : 0, now)
        // A workflow step's verdict is read from the COMPLETE eligible reply, here, before any display cut, storage cut or
        // Score annotation, and stored with the run's generation (7.7c §3). Never from the 32 KiB copy above.
        recordRunResult(sqlite, runId, info.reply, now)
      }
      // The CLI's own time to first token beats Score's measurement.
      if (usage?.ttftMs !== undefined) applyCliTtft(sqlite, runId, usage.ttftMs, now)
      // Stop ends a subagent with no word from it. Nothing of this run is still working.
      const stoppedSubagents = translation.subagentJobId
        ? endRunningSubagentsOf(sqlite, translation.subagentJobId, agentId, now)
        : []
      const changed = setRun(sqlite, runId, now, {
        status: info.status,
        ended_at: now,
        ...(info.group === 'unconfirmed' ? { terminal_source: 'unconfirmed' } : {}),
        output: info.output == null ? null : redactBounded(info.output, CODING_OUTPUT_BYTES),
        error: info.error == null ? null : redactBounded(info.error, 2048),
        cost_kind: usage?.costUsd != null ? info.costKind : 'unknown',
        ...(usage
          ? {
              input_tokens: usage.input,
              output_tokens: usage.output,
              cost_usd: usage.costUsd,
            }
          : {}),
      })
      return [
        ...stoppedSubagents,
        ...(changed ? [runDraft(sqlite, runId)] : []),
        ...completeRunMessage(sqlite, runId, now, {
          output: info.output ?? null,
          handoffs: info.status === 'completed' && info.group !== 'unconfirmed',
          status: info.status,
          error: info.error ?? null,
          ...(info.reply === undefined ? {} : { reply: info.reply }),
        }),
      ]
    },
  }
}
