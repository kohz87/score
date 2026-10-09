import type { WatchFrame } from '@score/contract'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { z } from 'zod'
import { appendRunMessage, completeRunMessage, noteRunProgress } from '../../domain/message-runs.ts'
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
import { rememberCliSession } from './store.ts'
import type { CodingEvent, ToolDetail } from './types.ts'

const MAX_THINKING_CHARS = 4096

/** Per-run state the translator keeps between events (the process owns it, not the DB). */
export interface RunTranslation {
  runId: string
  agentId: string
  roomId: string | null
  seq: number
  calls: Map<string, { seq: number; startedAt: string; detail?: ToolDetail }>
  usage: { input: number; output: number; costUsd: number | null } | null
}
export const newTranslation = (
  runId: string,
  agentId: string,
  roomId: string | null,
): RunTranslation => ({ runId, agentId, roomId, seq: 0, calls: new Map(), usage: null })

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
      args: { command: detail.command, workdir: detail.cwd ?? '' },
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
  if (phase.hook === 'pre') return []
  if (!phase.ok) return []
  const tool = detail.type === 'write' ? 'write_file' : 'patch'
  const args =
    detail.type === 'write'
      ? { path: detail.path, content: detail.content }
      : {
          mode: 'replace',
          path: detail.path,
          old_string: detail.oldString,
          new_string: detail.newString,
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
  event: CodingEvent,
  index: number,
): Observation {
  const { runId, agentId } = translation
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
          // Durable as soon as it is known: a restart keeps the session so the next turn resumes it.
          if (translation.roomId)
            rememberCliSession(sqlite, translation.roomId, agentId, event.sessionId, now)
          drafts.push(runDraft(sqlite, runId))
          break
        }
        case 'text':
          drafts.push(...appendRunMessage(sqlite, runId, event.text, now))
          break
        case 'thinking':
          sqlite
            .prepare(
              'INSERT INTO run_thinking (run_id, seq, text) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
            )
            .run(runId, seq, redactBounded(event.text, MAX_THINKING_CHARS))
          break
        case 'tool_start': {
          translation.calls.set(event.callId, {
            seq,
            startedAt: now,
            ...(event.detail ? { detail: event.detail } : {}),
          })
          sqlite
            .prepare(
              `INSERT INTO tool_calls (run_id, seq, tool, preview, status, started_at) VALUES (?, ?, ?, ?, 'running', ?) ON CONFLICT DO NOTHING`,
            )
            .run(runId, seq, event.tool.slice(0, 200), redactBounded(event.preview, 2048), now)
          const tools = z
            .array(z.object({ tool: z.string() }))
            .parse(
              sqlite
                .prepare('SELECT DISTINCT tool FROM tool_calls WHERE run_id = ? ORDER BY seq')
                .all(runId),
            )
          setRun(sqlite, runId, now, { tools_used: JSON.stringify(tools.map(({ tool }) => tool)) })
          drafts.push({
            type: 'log.line',
            data: {
              id: `coding:${runId}:${seq}`,
              at: now,
              agentId,
              kind: 'tool',
              text: redactBounded(`${event.tool}: ${event.preview}`, 2048),
            },
          })
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
          if (call.detail)
            drafts.push(
              ...framesFor(sqlite, translation, event.callId, now, call.detail, {
                hook: 'post',
                ok: event.ok,
                output: redact(tailBytes(event.preview, OUTPUT_BYTES - 40).text),
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
}

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
      const row = readRun(sqlite, runId)
      if (runLifecycle.isTerminal(row.status)) return []
      const usage = translation.usage
      const changed = setRun(sqlite, runId, now, {
        status: info.status,
        ended_at: now,
        output: info.output == null ? null : redactBounded(info.output, 8192),
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
          handoffs: info.status === 'completed',
          status: info.status,
          error: info.error ?? null,
        }),
      ]
    },
  }
}
