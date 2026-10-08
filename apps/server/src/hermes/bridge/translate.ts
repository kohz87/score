import { BridgeEventSchema, BridgeIdentifierSchema, type BridgeEvent } from '@score/contract'
import { z } from 'zod'
import {
  applyApprovalSignal,
  completeApprovalTool,
  GateSignalSchema,
} from '../../domain/approvals.ts'
import type { DomainEventDraft, Observation } from '../../hub/ingest.ts'
import { defineLifecycle, guardedUpsert } from '../../hub/projections.ts'
import { redact, redactBounded, redactValue } from '../../redact.ts'
import { KanbanDenialSchema, recordKanbanDenial } from '../../domain/kanban-denials.ts'
import {
  isSensitiveTool,
  recordToolFrames,
  touchesCredentialFile,
  WatchInfoSchema,
} from '../../domain/watch-frames.ts'
import type { Producer } from './registry.ts'
import type { ScreenshotImporter } from './screenshots.ts'

export interface BridgeMetrics {
  unknownHooks: number
  mismatchedKanbanTasks?: number
}

const ToolPayloadSchema = z.object({
  gateIds: z.array(BridgeIdentifierSchema).max(16).optional(),
  tool_name: z.string().optional(),
  args: z.unknown().optional(),
  result: z.unknown().optional(),
  status: z.string().nullish(),
  duration_ms: z.int().nonnegative().nullish(),
  command_digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullish(),
  // The plugin's redacted terminal tail; a malformed one only costs the frame its output.
  watch: WatchInfoSchema.optional().catch(undefined),
})
const ExpirySchema = z.union([
  z.iso.datetime(),
  z
    .number()
    .finite()
    .nonnegative()
    .max(253402300799)
    .transform((value) => new Date(value * 1000).toISOString()),
])
const ApprovalPayloadSchema = z.object({
  requestId: BridgeIdentifierSchema.nullable().optional(),
  request_id: BridgeIdentifierSchema.nullable().optional(),
  gateId: BridgeIdentifierSchema.nullish(),
  linkedGateId: BridgeIdentifierSchema.nullish(),
  supersedesGateId: BridgeIdentifierSchema.nullish(),
  transportRequestId: BridgeIdentifierSchema.nullish(),
})
const GapPayloadSchema = z
  .object({
    from_counter: z.int().positive(),
    to_counter: z.int().positive(),
    dropped: z.int().positive(),
    corrupt_records: z.int().nonnegative().optional(),
  })
  .refine(
    (gap) =>
      gap.to_counter >= gap.from_counter && gap.dropped === gap.to_counter - gap.from_counter + 1,
  )
const ToolRowSchema = z.object({ started_at: z.iso.datetime(), version: z.int().nonnegative() })
const lifecycle = defineLifecycle({
  states: ['running', 'ok', 'error', 'blocked'],
  terminal: ['ok', 'error', 'blocked'],
  order: ['running', 'ok', 'error', 'blocked'],
})
const approvalHooks = new Set([
  'pre_approval_request',
  'post_approval_response',
  'on_human_input_request',
  'on_human_input_resolved',
  'approval.settled',
])
const systemHooks = new Set([
  'on_session_start',
  'on_session_end',
  'subagent_start',
  'subagent_stop',
  'on_kanban_worker_spawned',
  'on_kanban_worker_exited',
  'on_kanban_worker_stale_claim',
  'on_kanban_task_updated',
  'on_kanban_dispatch_tick',
])

function tooComplex(value: unknown): boolean {
  const pending = [{ value, depth: 0 }]
  let nodes = 0
  while (pending.length) {
    const item = pending.pop()!
    if (++nodes > 10_000 || item.depth > 32) return true
    if (item.value !== null && typeof item.value === 'object') {
      for (const child of Object.values(item.value)) {
        pending.push({ value: child, depth: item.depth + 1 })
      }
    }
  }
  return false
}

const payloadIdentifierNames = [
  'profile',
  'incarnation',
  'kanbanTaskId',
  'sessionKey',
  'sessionId',
  'toolCallId',
  'requestId',
  'gateId',
  'linkedGateId',
  'supersedesGateId',
  'transportRequestId',
  'turn_id',
  'turnId',
  'kanban_task_id',
  'session_key',
  'session_id',
  'tool_call_id',
  'request_id',
]

function redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const identifiers: Record<string, unknown> = {}
  if (Object.hasOwn(payload, 'gateIds'))
    identifiers.gateIds = z.array(BridgeIdentifierSchema).max(16).parse(payload.gateIds)
  const content = { ...payload }
  delete content.gateIds
  for (const name of payloadIdentifierNames) {
    if (!Object.hasOwn(content, name)) continue
    identifiers[name] = BridgeIdentifierSchema.nullable().parse(content[name])
    delete content[name]
  }
  return { ...z.record(z.string(), z.unknown()).parse(redactValue(content)), ...identifiers }
}

function decodeResult(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function preview(value: unknown): string | null {
  if (value === undefined) return null
  return redactBounded(JSON.stringify(redactValue(value)), 2048)
}

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
    systemHooks.has(parsed.hook)
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
  const denial =
    parsed.hook === 'post_tool_call' && !omitted
      ? KanbanDenialSchema.safeParse(parsed.payload.kanbanDenial)
      : undefined
  const pre = event.hook === 'pre_tool_call'
  const post = event.hook === 'post_tool_call'
  const tool = pre || post ? ToolPayloadSchema.parse(event.payload) : undefined
  const result = post ? redactValue(decodeResult(tool?.result)) : undefined
  // Stored here, outside the ingest transaction; the frame only keeps the resulting id.
  const screenshotMediaId =
    post && tool?.tool_name === 'browser_vision' && tool.watch?.screenshotPath && importScreenshot
      ? importScreenshot(producer.profile, tool.watch.screenshotPath)
      : null
  const nested = z.object({ status: z.string().optional() }).safeParse(result)
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
  const message = event.hook === 'on_interim_message'
  const system = systemHooks.has(event.hook) || (event.hook === 'bridge.gap' && omitted)
  const text =
    message || system
      ? z
          .object({ text: z.string().optional(), message: z.string().optional() })
          .parse(event.payload)
      : undefined

  function log(kind: 'tool' | 'approval' | 'message' | 'system', text: string): DomainEventDraft {
    return {
      type: 'log.line',
      data: {
        id: identity,
        at: event.at,
        agentId: producer.profile,
        kind,
        text: redactBounded(text, 2048),
      },
    }
  }

  return {
    source,
    identity,
    checkpoint,
    apply({ sqlite, now }) {
      if (gap) {
        const reason = redact(
          `Bridge dropped ${gap.dropped} events (counters ${gap.from_counter}–${gap.to_counter})`,
        )
        sqlite
          .prepare(
            'INSERT INTO gaps (source, run_id, from_ts, to_ts, reason) VALUES (?, NULL, ?, ?, ?)',
          )
          .run(source, event.at, event.at, reason)
        sqlite
          .prepare(
            `INSERT INTO ingest_checkpoints (source, scope, cursor, incarnation, updated_at)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT (source, scope) DO UPDATE SET cursor = MAX(CAST(cursor AS INTEGER), CAST(excluded.cursor AS INTEGER)), updated_at = excluded.updated_at`,
          )
          .run(source, `gap:${gap.from_counter}`, String(gap.to_counter), producer.incarnation, now)
        return [
          {
            type: 'gap.recorded',
            data: { source, runId: null, from: event.at, to: event.at, reason },
          },
        ]
      }
      if (tool) {
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
      if (approval) {
        const inserted = sqlite
          .prepare(
            `INSERT INTO approval_signals
          (producer_id, profile, hook, session_key, request_id, payload, at, producer_incarnation, counter, gate_id, linked_gate_id, transport_request_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            producer.id,
            producer.profile,
            event.hook,
            event.sessionKey,
            approval.requestId ?? null,
            JSON.stringify({ ...event.payload, ...signal }),
            event.at,
            producer.incarnation,
            event.counter,
            approval.gateId ?? null,
            approval.linkedGateId ?? null,
            approval.transportRequestId ?? null,
          )
        return [
          ...applyApprovalSignal(sqlite, Number(inserted.lastInsertRowid), now, { disabled }),
          log('approval', event.hook),
        ]
      }
      if (text) {
        return [
          log(
            message ? 'message' : 'system',
            `${event.hook}${text.text || text.message ? `: ${text.text ?? text.message}` : ''}`,
          ),
        ]
      }
      metrics.unknownHooks++
      return []
    },
  }
}
