import { BridgeEventSchema, BridgeIdentifierSchema, type BridgeEvent } from '@score/contract'
import { z } from 'zod'
import { GateSignalSchema } from '../../domain/approvals.ts'
import { isSensitiveTool, touchesCredentialFile } from '../../domain/watch-frames.ts'
import type { Observation } from '../../hub/ingest.ts'
import type { Producer } from './registry.ts'
import type { ScreenshotImporter } from './screenshots.ts'
import { applyApprovalEvent } from './translate-approvals.ts'
import { createBridgeLog } from './translate-log.ts'
import {
  decodeResult,
  payloadIdentifierNames,
  redactPayload,
  tooComplex,
} from './translate-payload.ts'
import {
  approvalHooks,
  ApprovalPayloadSchema,
  CompactionSchema,
  DeleteSchema,
  ExpirySchema,
  GapPayloadSchema,
  systemHooks,
  ToolPayloadSchema,
  type BridgeMetrics,
} from './translate-schemas.ts'
import {
  applyCompactionEvent,
  applyDeletedSessionsEvent,
  applyGapEvent,
  applyTextEvent,
} from './translate-system.ts'
import { applyToolEvent } from './translate-tools.ts'

export type { BridgeMetrics } from './translate-schemas.ts'

export function translateBridgeEvent(
  producer: Producer,
  value: BridgeEvent,
  metrics: BridgeMetrics,
  disabled: readonly string[] = [],
  importScreenshot?: ScreenshotImporter,
): Observation {
  const parsed = BridgeEventSchema.parse(value)
  const source = `bridge:${producer.incarnation}`
  const identity = `${source}:${parsed.counter}`
  const checkpoint = {
    scope: 'events',
    position: parsed.counter,
    incarnation: producer.incarnation,
  }
  const supported =
    parsed.hook === 'pre_tool_call' ||
    parsed.hook === 'post_tool_call' ||
    parsed.hook === 'bridge.gap' ||
    parsed.hook === 'on_interim_message' ||
    approvalHooks.has(parsed.hook) ||
    systemHooks.has(parsed.hook) ||
    parsed.hook === 'on_session_delete' ||
    parsed.hook === 'post_compaction'
  if (!supported) {
    return {
      source,
      identity,
      checkpoint,
      apply() {
        metrics.unknownHooks++
        return []
      },
    }
  }
  // Decode nested result JSON before redaction, which can replace JSON string quotes.
  const payload: Record<string, unknown> = {
    ...parsed.payload,
    ...(parsed.hook === 'post_tool_call' ? { result: decodeResult(parsed.payload.result) } : {}),
  }
  // Credential-bearing tools keep a name and a status only, whatever the producer sent (D6).
  if (
    (parsed.hook === 'pre_tool_call' || parsed.hook === 'post_tool_call') &&
    isSensitiveTool(
      typeof parsed.payload.tool_name === 'string' ? parsed.payload.tool_name : undefined,
    )
  ) {
    for (const name of ['args', 'result', 'command', 'watch', 'error_message', 'positional_args'])
      delete payload[name]
  }
  // File tools that touch a credential file keep their path but lose content and results, as in the plugin.
  if (
    (parsed.hook === 'pre_tool_call' || parsed.hook === 'post_tool_call') &&
    touchesCredentialFile(payload.args)
  ) {
    for (const name of ['result', 'watch', 'error_message']) delete payload[name]
    const args = { ...(payload.args as Record<string, unknown>) }
    // Replaced, not deleted: the editor frame still needs a body to show its "hidden" note.
    for (const name of ['content', 'patch', 'old_string', 'new_string'])
      if (name in args) args[name] = '[hidden]'
    payload.args = args
  }
  // Validate structural identifiers even if the rest of the supported payload will be omitted.
  for (const name of payloadIdentifierNames) {
    if (Object.hasOwn(payload, name)) BridgeIdentifierSchema.nullable().parse(payload[name])
  }
  const omitted = tooComplex(payload)
  const event = {
    ...parsed,
    payload: omitted ? { omitted: 'payload too complex' } : redactPayload(payload),
  }
  const pre = event.hook === 'pre_tool_call'
  const post = event.hook === 'post_tool_call'
  const tool = pre || post ? ToolPayloadSchema.parse(event.payload) : undefined
  // Stored here, outside the ingest transaction; the frame only keeps the resulting id.
  const screenshotMediaId =
    post && tool?.tool_name === 'browser_vision' && tool.watch?.screenshotPath && importScreenshot
      ? importScreenshot(producer.profile, tool.watch.screenshotPath)
      : null
  const approval = approvalHooks.has(event.hook)
    ? ApprovalPayloadSchema.parse(event.payload)
    : undefined
  const signal = approval
    ? GateSignalSchema.parse({
        ...event.payload,
        kind:
          event.hook === 'pre_approval_request'
            ? 'pre'
            : event.hook === 'post_approval_response'
              ? 'post'
              : 'closed',
        toolCallId: event.toolCallId,
        sessionId: event.sessionId,
        turnId: event.payload.turn_id ?? event.payload.turnId,
        expiresAt: ExpirySchema.nullish().parse(
          event.payload.expiresAt ?? event.payload.expires_at,
        ),
      })
    : undefined
  const gap =
    event.hook === 'bridge.gap' && !omitted
      ? GapPayloadSchema.refine((gap) => gap.to_counter <= event.counter).parse(event.payload)
      : undefined
  const deleted =
    event.hook === 'on_session_delete' && !omitted
      ? DeleteSchema.safeParse(event.payload).data
      : undefined
  const compacted =
    event.hook === 'post_compaction' && !omitted
      ? CompactionSchema.safeParse(event.payload).data
      : undefined
  const message = event.hook === 'on_interim_message'
  const system = systemHooks.has(event.hook) || (event.hook === 'bridge.gap' && omitted)
  const text =
    message || system
      ? z
          .object({ text: z.string().optional(), message: z.string().optional() })
          .parse(event.payload)
      : undefined
  const log = createBridgeLog(identity, event, producer)

  return {
    source,
    identity,
    checkpoint,
    apply({ sqlite, now }) {
      if (deleted) return applyDeletedSessionsEvent({ sqlite, producer, deleted, now, log })
      if (event.hook === 'on_session_delete') return []
      if (event.hook === 'post_compaction') return applyCompactionEvent({ compacted, log })
      if (gap) return applyGapEvent({ sqlite, producer, source, event, gap, now })
      if (tool)
        return applyToolEvent({
          sqlite,
          producer,
          event,
          metrics,
          disabled,
          log,
          tool,
          omitted,
          kanbanDenial: parsed.payload.kanbanDenial,
          screenshotMediaId,
        })
      if (approval)
        return applyApprovalEvent({
          sqlite,
          now,
          producer,
          event,
          disabled,
          log,
          approval,
          signal,
        })
      if (text) return applyTextEvent({ event, message, text, log })
      metrics.unknownHooks++
      return []
    },
  }
}
