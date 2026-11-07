import type { BridgeEvent } from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { completeApprovalTool } from '../../domain/approvals.ts'
import { KanbanDenialSchema, recordKanbanDenial } from '../../domain/kanban-denials.ts'
import { recordToolFrames } from '../../domain/watch-frames.ts'
import type { DomainEventDraft } from '../../hub/ingest.ts'
import { guardedUpsert } from '../../hub/projections.ts'
import { redact, redactValue } from '../../redact.ts'
import type { Producer } from './registry.ts'
import type { BridgeLog } from './translate-log.ts'
import { decodeResult, preview } from './translate-payload.ts'
import {
  lifecycle,
  ToolRowSchema,
  type BridgeMetrics,
  type ToolPayload,
} from './translate-schemas.ts'

export interface ToolEventContext {
  sqlite: DatabaseSync
  producer: Producer
  event: BridgeEvent
  metrics: BridgeMetrics
  disabled: readonly string[]
  log: BridgeLog
  tool: ToolPayload
  omitted: boolean
  kanbanDenial: unknown
  screenshotMediaId: string | null
}

export function applyToolEvent({
  sqlite,
  producer,
  event,
  metrics,
  disabled,
  log,
  tool,
  omitted,
  kanbanDenial,
  screenshotMediaId,
}: ToolEventContext): DomainEventDraft[] {
  const denial =
    event.hook === 'post_tool_call' && !omitted
      ? KanbanDenialSchema.safeParse(kanbanDenial)
      : undefined
  const pre = event.hook === 'pre_tool_call'
  const post = event.hook === 'post_tool_call'
  const result = post ? redactValue(decodeResult(tool.result)) : undefined
  const nested = z.object({ status: z.string().optional() }).safeParse(result)
  const denialDrafts: DomainEventDraft[] = []
  if (denial?.success) {
    if (producer.kanban_task_id !== denial.data.taskId)
      metrics.mismatchedKanbanTasks = (metrics.mismatchedKanbanTasks ?? 0) + 1
    else {
      const args = z.object({ command: z.string() }).safeParse(tool.args)
      if (args.success)
        denialDrafts.push(
          ...recordKanbanDenial(sqlite, denial.data, producer, args.data.command, event.at),
        )
    }
  }
  const status = pre
    ? 'running'
    : nested.success && nested.data.status === 'blocked'
      ? 'blocked'
      : tool.status === 'error'
        ? 'error'
        : 'ok'
  if (event.sessionId && event.toolCallId) {
    const row = sqlite
      .prepare(
        'SELECT started_at, version FROM session_tool_calls WHERE profile = ? AND session_id = ? AND tool_call_id = ?',
      )
      .get(producer.profile, event.sessionId, event.toolCallId)
    const previous = row === undefined ? undefined : ToolRowSchema.parse(row)
    guardedUpsert(sqlite, {
      table: 'session_tool_calls',
      key: {
        profile: producer.profile,
        session_id: event.sessionId,
        tool_call_id: event.toolCallId,
      },
      stateColumn: 'status',
      lifecycle,
      versionColumn: 'version',
      values: {
        tool: redact(tool.tool_name ?? 'unknown'),
        status,
        started_at: previous?.started_at ?? event.at,
        kanban_task_id: producer.kanban_task_id,
        version: (previous?.version ?? 0) + 1,
        ...(pre
          ? { args_preview: preview(tool.args), command_digest: tool.command_digest ?? null }
          : {
              ended_at: event.at,
              duration_ms: tool.duration_ms ?? null,
              result_preview: preview(result),
              args_digest: tool.args_digest ?? null,
            }),
      },
    })
  }
  const frameDrafts: DomainEventDraft[] = []
  try {
    for (const frame of recordToolFrames(
      sqlite,
      {
        agentId: producer.profile,
        at: event.at,
        sessionId: event.sessionId,
        toolCallId: event.toolCallId,
      },
      {
        hook: pre ? 'pre' : 'post',
        tool: tool.tool_name ?? 'unknown',
        args: tool.args,
        result,
        status,
        watch: tool.watch ?? null,
        screenshotMediaId,
      },
    ))
      frameDrafts.push({ type: 'watch.frame', data: frame })
  } catch (error) {
    // The replay is best effort; a frame that fails validation must not stall the producer's checkpoint.
    console.error('Watch frame skipped', error)
  }
  return [
    ...denialDrafts,
    ...frameDrafts,
    ...(post && tool.gateIds?.length
      ? completeApprovalTool(
          sqlite,
          producer,
          {
            gateIds: tool.gateIds!,
            counter: event.counter,
            sessionKey: event.sessionKey,
          },
          status === 'running' ? 'ok' : status,
          event.at,
          { disabled },
        )
      : []),
    log(
      'tool',
      `${tool.tool_name ?? 'Tool'} ${pre ? 'started' : status}: ${preview(pre ? tool.args : result) ?? ''}`,
    ),
  ]
}
