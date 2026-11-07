import { z } from 'zod'
import { redactValue } from '../../redact.ts'
import { HermesHttpError } from './gateway-errors.ts'

export function redactRunPayload(value: unknown, secrets: string[] = []): Record<string, unknown> {
  const content = { ...z.record(z.string(), z.unknown()).parse(value) }
  const identifiers: Record<string, string | null> = {}
  for (const name of [
    'run_id',
    'request_id',
    'session_id',
    'session_key',
    'tool_call_id',
    'turn_id',
    'gate_id',
  ]) {
    if (!Object.hasOwn(content, name)) continue
    if (content[name] === null && name !== 'run_id' && name !== 'request_id') {
      identifiers[name] = null
      delete content[name]
      continue
    }
    const id = z
      .string()
      .regex(/^[\x21-\x7e]{1,256}$/)
      .parse(content[name])
    if (secrets.some((secret) => secret && id.includes(secret)))
      throw new HermesHttpError(200, 'invalid_response')
    identifiers[name] = id
    delete content[name]
  }
  return {
    ...z.record(z.string(), z.unknown()).parse(redactValue(content, secrets)),
    ...identifiers,
  }
}

/**
 * Streamed reply text (message.delta / message.interim) must reach the message layer unredacted: pattern redaction
 * per chunk destroys the context a secret split across chunks needs ("Authorization: Bearer " + token), and the
 * message layer redacts the joined text once it settles (domain/message-runs.ts). Only this profile's own gateway key
 * is stripped here; every other field gets the usual treatment.
 */
const STREAM_TEXT_FIELD: Record<string, string> = {
  'message.delta': 'delta',
  'message.interim': 'text',
}
export function redactRunFrame(
  event: string,
  value: unknown,
  secrets: string[] = [],
): Record<string, unknown> {
  const record = z.record(z.string(), z.unknown()).parse(value)
  // Hermes names the event inside the payload too (translate reads that one); the SSE event line is a fallback.
  const field = STREAM_TEXT_FIELD[typeof record.event === 'string' ? record.event : event]
  if (!field || typeof record[field] !== 'string') return redactRunPayload(record, secrets)
  const { [field]: text, ...rest } = record
  let raw = text as string
  for (const secret of secrets) if (secret) raw = raw.replaceAll(secret, '[redacted]')
  return { ...redactRunPayload(rest, secrets), [field]: raw }
}
