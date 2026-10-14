import type { WatchFrame } from '@score/contract'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { z } from 'zod'
import {
  appendRunMessage,
  completeRunMessage,
  liveActivityDraft,
  noteRunProgress,
} from '../../domain/message-runs.ts'
import {
  framesForTool,
  recordFrame,
  tailBytes,
  type FrameDraft,
  OUTPUT_BYTES,
} from '../../domain/watch-frames.ts'
import type { DomainEventDraft, Observation } from '../../hub/ingest.ts'
import { guardedUpsert } from '../../hub/projections.ts'
import { redact, redactBounded } from '../../redact.ts'
import { readRun, runDraft, runLifecycle } from '../../hermes/index.ts'
import { boundEvent, detailBytes, MAX_REMEMBERED_IDS, redactNote } from './note.ts'
import {
  chargeObservation,
  CODING_OUTPUT_BYTES,
  CODING_RESULT_BYTES,
} from '../../domain/orchestration/ops.ts'
import { recordRunResult } from '../../domain/workflows/verdict.ts'
import { rememberCliSession } from './store.ts'
import type { CodingEvent, ToolDetail } from './types.ts'

const MAX_THINKING_CHARS = 4096

/** Per-run state the translator keeps between events (the process owns it, not the DB). */
export interface RunTranslation {
  runId: string
  agentId: string
  roomId: string | null
  /** An orchestration- or workflow-owned run (7.7b §6): it never writes Chat's (room, agent) session cache. */
  owned: boolean
  seq: number
  calls: Map<string, { seq: number; startedAt: string; detail?: ToolDetail }>
  usage: { input: number; output: number; costUsd: number | null } | null
}
/** Bytes the translator's per-run state holds (call ids and the tool details kept for their frames). */
export function translationBytes(translation: RunTranslation): number {
  let bytes = 0
  for (const [id, call] of translation.calls)
    bytes += Buffer.byteLength(id) + detailBytes(call.detail) + 64
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
  roomId: string | null,
  owned = false,
): RunTranslation => ({ runId, agentId, roomId, owned, seq: 0, calls: new Map(), usage: null })

function setRun(
  sqlite: DatabaseSync,
  runId: string,
  now: string,
  values: Record<string, SQLInputValue>,
): boolean {
  const row = readRun(sqlite, runId)
  return (
    guardedUpsert(sqlite, {
      table: 'runs',
      key: { id: runId },
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

/** The run left the queue: its process started. */
export function runningObservation(translation: RunTranslation): Observation {
  const { runId, agentId } = translation
  return {
    source: `coding:${agentId}`,
    identity: `coding:${runId}:running`,
    apply({ sqlite, now }) {
      return setRun(sqlite, runId, now, { status: 'running' }) ? [runDraft(sqlite, runId)] : []
    },
  }
}

function frameDrafts(
  sqlite: DatabaseSync,
  translation: RunTranslation,
  callKey: string,
  at: string,
  draft: FrameDraft,
): DomainEventDraft[] {
  try {
    const frame: WatchFrame = recordFrame(sqlite, {
      agentId: translation.agentId,
      runId: translation.runId,
      at,
      callKey: `${translation.runId}:${callKey}${draft.suffix}`,
      surface: draft.surface,
      payload: draft.payload,
      caption: draft.caption,
    })
    return [{ type: 'watch.frame', data: frame }]
  } catch (error) {
    // The replay is best effort: a frame that fails validation must not stop the run.
    console.error('Coding watch frame skipped', error)
    return []
  }
}

/** Watch frames come from the same parsed events (D6): Hermes-shaped tool inputs feed the same frame builders. */
function framesFor(
  sqlite: DatabaseSync,
  translation: RunTranslation,
  callId: string,
  at: string,
  detail: ToolDetail,
  phase: { hook: 'pre' } | { hook: 'post'; ok: boolean; output: string; exitCode: number | null },
): DomainEventDraft[] {
  const base = { watch: null, status: phase.hook === 'pre' ? ('running' as const) : null }
  if (detail.type === 'command') {
    const post = phase.hook === 'post'
    const drafts = framesForTool({
      hook: phase.hook,
      tool: 'terminal',
      args: { command: redact(detail.command), workdir: detail.cwd ?? '' },
      result: post ? { output: phase.output, exit_code: phase.exitCode } : {},
      status: post ? (phase.ok ? 'ok' : 'error') : 'running',
      watch: base.watch,
      lastBrowser: null,
    })
    return drafts.flatMap((draft) => frameDrafts(sqlite, translation, callId, at, draft))
  }
  if (detail.type === 'file') {
    if (phase.hook === 'pre') return []
    const verb = { add: 'Added', update: 'Edited', delete: 'Deleted' }[detail.change]
    return frameDrafts(sqlite, translation, callId, at, {
      suffix: '',
      surface: 'editor',
      payload: { path: detail.path, diff: `${verb} ${detail.path}`, language: null },
      caption: `${verb} ${detail.path}`,
    })
  }
  if (detail.type === 'browser') {
    if (phase.hook === 'pre') return []
    return framesForTool({
      hook: 'post',
      tool: detail.url ? 'browser_navigate' : 'browser_snapshot',
      args: { url: detail.url ?? '' },
      result: {},
      status: phase.ok ? 'ok' : 'error',
      watch: null,
      lastBrowser: null,
    }).flatMap((draft) => frameDrafts(sqlite, translation, callId, at, draft))
  }
  if (phase.hook === 'pre') return []
  if (!phase.ok) return []
  const tool = detail.type === 'write' ? 'write_file' : 'patch'
  const args =
    detail.type === 'write'
      ? { path: detail.path, content: redact(detail.content) }
      : {
          mode: 'replace',
          path: detail.path,
          old_string: redact(detail.oldString),
          new_string: redact(detail.newString),
        }
  return framesForTool({
    hook: 'post',
    tool,
    args,
    result: {},
    status: 'ok',
    watch: null,
    lastBrowser: null,
  }).flatMap((draft) => frameDrafts(sqlite, translation, callId, at, draft))
}

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
          if (translation.roomId && !translation.owned)
            rememberCliSession(sqlite, translation.roomId, agentId, event.sessionId, now)
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
          })
          // CLI metadata is redacted before it is bounded or stored: tool names and what is derived from them (#12).
          const toolName = redactNote(event.tool, 200)
          // The whole bounded row is charged at the start: preview, result preview and overhead.
          if (chargeObservation(sqlite, runId, 2048 + 2000 + 256)) {
            sqlite
              .prepare(
                `INSERT INTO tool_calls (run_id, seq, tool, preview, status, started_at) VALUES (?, ?, ?, ?, 'running', ?) ON CONFLICT DO NOTHING`,
              )
              .run(runId, seq, toolName, redactBounded(event.preview, 2048), now)
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
            },
          })
          drafts.push(...liveActivityDraft(sqlite, runId))
          if (event.detail)
            drafts.push(
              ...framesFor(sqlite, translation, event.callId, now, event.detail, { hook: 'pre' }),
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
              ...framesFor(sqlite, translation, event.callId, now, call.detail, {
                hook: 'post',
                ok: event.ok,
                // Redact the whole result first: a tail cut can remove the label that marks the value as secret.
                output: tailBytes(redact(event.preview), OUTPUT_BYTES - 40).text,
                exitCode: event.exitCode ?? null,
              }),
            )
          break
        }
        case 'usage':
          translation.usage = {
            input: Math.round(event.inputTokens),
            output: Math.round(event.outputTokens),
            costUsd: event.costUsd ?? null,
          }
          break
        case 'result':
          break
      }
      return drafts
    },
  }
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

export { CODING_RESULT_BYTES }

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
