import { gunzipSync, gzipSync } from 'node:zlib'
import { z } from 'zod'

// Stored idempotency receipts (`request_receipts.response`): plain JSON, or `{ scoreReceiptGzip }` when the response
// is larger than the table allows. Shared by the replay path (http/idempotency.ts) and by receipt rewrites.

const CompressedReceiptSchema = z.object({ scoreReceiptGzip: z.string() }).strict()

/** Mirrors the request_receipts CHECK (migration 0010): task details may be larger than other responses. */
export function storageLimit(route: string): number {
  return route === '/api/tasks' || route.startsWith('/api/tasks/') ? 524288 : 65536
}

/** The response a receipt holds. */
export function decodeReceipt(stored: string, maxResponseBytes: number): unknown {
  const parsed: unknown = JSON.parse(stored)
  const compressed = CompressedReceiptSchema.safeParse(parsed)
  return compressed.success
    ? JSON.parse(
        gunzipSync(Buffer.from(compressed.data.scoreReceiptGzip, 'base64'), {
          maxOutputLength: maxResponseBytes,
        }).toString('utf8'),
      )
    : parsed
}

/** The form to store a serialized response in: as is when it fits, else gzipped. Throws when it still does not fit. */
export function encodeReceipt(response: string, route: string): string {
  const stored =
    Buffer.byteLength(response) <= storageLimit(route)
      ? response
      : JSON.stringify({ scoreReceiptGzip: gzipSync(response).toString('base64') })
  if (Buffer.byteLength(stored) > storageLimit(route))
    throw new Error('Compressed idempotency response exceeds 64 KB')
  return stored
}
