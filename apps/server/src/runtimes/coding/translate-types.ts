import { detailBytes } from './note.ts'
import type { ToolDetail } from './types.ts'

/** Per-run state the translator keeps between events (the process owns it, not the DB). */
export interface RunTranslation {
  runId: string
  agentId: string
  /** The job whose CLI session this run resumes or starts (null: not a room turn). */
  jobId: string | null
  /** The job whose subagent count this run adds to; an orchestration's run has no `jobId` of its own. */
  subagentJobId: string | null
  /** An orchestration- or workflow-owned run (7.7b §6): it never writes Chat's (room, agent) session cache. */
  owned: boolean
  seq: number
  calls: Map<string, { seq: number; startedAt: string; detail?: ToolDetail; parentCallId?: string }>
  usage: { input: number; output: number; costUsd: number | null; ttftMs?: number } | null
}

export interface TerminalInfo {
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted'
  output?: string | null
  error?: string | null
  /** Claude Code's cost is an API-price equivalent (a subscription is not billed per token); Codex gives none. */
  costKind: 'estimated' | 'unknown'
  /**
   * The process record, settled in the same transaction as the result: `released` = the group is proven gone, so the
   * row goes with it (never before: a crash in between must not lose a result); `unconfirmed` = it is not, so the row
   * stays, marked unresolved, and the run is not termination evidence.
   */
  group?: 'released' | 'unconfirmed'
  /** The eligible authoritative reply (7.7a §6): plans and hand-offs read only this. `null` = none; absent = legacy. */
  reply?: string | null
  /**
   * An orchestration-owned run (7.7b §7): the complete eligible reply is also stored, up to 32 KiB, in the same
   * transaction as the terminal state, for the executor to take as the worker's result.
   */
  ownedResult?: boolean
}

/** Bytes the translator's per-run state holds (call ids and the tool details kept for their frames). */
export function translationBytes(translation: RunTranslation): number {
  let bytes = 0
  for (const [id, call] of translation.calls)
    bytes +=
      Buffer.byteLength(id) +
      Buffer.byteLength(call.parentCallId ?? '') +
      detailBytes(call.detail) +
      64
  return bytes
}

/** Bytes a result waiting to be saved holds: the translator's state plus the texts of the terminal record. */
export function pendingBytes(translation: RunTranslation, info: TerminalInfo): number {
  const size = (text: string | null | undefined) => Buffer.byteLength(text ?? '')
  return translationBytes(translation) + size(info.output) + size(info.error) + size(info.reply)
}

export const newTranslation = (
  runId: string,
  agentId: string,
  jobId: string | null,
  owned = false,
): RunTranslation => ({
  runId,
  agentId,
  jobId,
  subagentJobId: jobId,
  owned,
  seq: 0,
  calls: new Map(),
  usage: null,
})
