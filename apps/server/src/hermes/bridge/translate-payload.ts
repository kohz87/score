import { BridgeIdentifierSchema } from '@score/contract'
import { z } from 'zod'
import { redactBounded, redactValue } from '../../redact.ts'

export function tooComplex(value: unknown): boolean {
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

export const payloadIdentifierNames = [
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

export function redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
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

export function decodeResult(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

export function preview(value: unknown): string | null {
  if (value === undefined) return null
  return redactBounded(JSON.stringify(redactValue(value)), 2048)
}
