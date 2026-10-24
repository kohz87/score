import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

// Standard Webhooks (https://www.standardwebhooks.com): `webhook-id`, `webhook-timestamp` (unix seconds) and
// `webhook-signature` (space-separated `v1,<base64 HMAC-SHA256>` entries over `${id}.${timestamp}.${body}`), keyed by
// the bytes of a `whsec_<base64>` secret. PLAN 11.1d: Score makes the secret and checks every call against it.

export const SIGNATURE_TOLERANCE_SECONDS = 5 * 60

/** A new signing secret: `whsec_` + 32 random bytes, base64. */
export const newWebhookSecret = (): string => `whsec_${randomBytes(32).toString('base64')}`

export function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`
}

export type SignatureCheck =
  | { ok: true }
  | { ok: false; reason: 'missing_headers' | 'stale_timestamp' | 'bad_signature' }

/** Checks a call's headers against the secret; `nowSeconds` is the server's clock. */
export function verifyWebhook(
  secret: string,
  headers: { id?: string; timestamp?: string; signature?: string },
  body: string,
  nowSeconds: number,
): SignatureCheck {
  const { id, timestamp, signature } = headers
  if (!id || !timestamp || !signature || !/^\d{1,12}$/.test(timestamp))
    return { ok: false, reason: 'missing_headers' }
  const sent = Number(timestamp)
  if (Math.abs(nowSeconds - sent) > SIGNATURE_TOLERANCE_SECONDS)
    return { ok: false, reason: 'stale_timestamp' }
  const expected = Buffer.from(signWebhook(secret, id, sent, body).slice(3), 'base64')
  // Several signatures may be sent (secret rotation on the sender's side): one valid v1 entry is enough.
  for (const entry of signature.split(' ')) {
    const [version, value] = entry.split(',', 2)
    if (version !== 'v1' || !value) continue
    const given = Buffer.from(value, 'base64')
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true }
  }
  return { ok: false, reason: 'bad_signature' }
}
