import { createHash, createHmac, randomBytes } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import type { FastifyRequest, preHandlerHookHandler, onSendHookHandler } from 'fastify'
import { z } from 'zod'
import type { ScoreDb } from '../db/index.ts'
import { HttpError } from '../errors.ts'

const ReceiptSchema = z.object({
  body_sha256: z.string(),
  status: z.int().nullable(),
  response: z.string().nullable(),
})
const CompressedReceiptSchema = z.object({ scoreReceiptGzip: z.string() }).strict()
// Mirrors the request_receipts CHECK (migration 0010): task details may be larger than other responses.
function storageLimit(route: string): number {
  return route === '/api/tasks' || route.startsWith('/api/tasks/') ? 524288 : 65536
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

export function requestIdempotency(
  db: ScoreDb | undefined,
  clock = Date.now,
  maxResponseBytes = 65536,
  /**
   * Secret-bearing routes (a pasted API key): the stored body hash is an HMAC under a per-process random secret, so
   * the receipt can't be used to confirm a guess at the body. A retry after a restart is then a conflict, not a replay.
   */
  options: {
    secretBody?: boolean
    /**
     * The handler can safely run again with the same key (it reconciles with the upstream's own idempotency): a
     * server error or a receipt left pending by a crash is dropped instead of replayed, so a retry can succeed.
     */
    rerunUncertain?: boolean
  } = {},
): { preHandler: preHandlerHookHandler; onSend: onSendHookHandler } {
  const owners = new WeakMap<FastifyRequest, { key: string; route: string; finish: () => void }>()
  const flights = new Map<string, Promise<void>>()
  const secret = randomBytes(32)
  return {
    async preHandler(request, reply) {
      const header = request.headers['idempotency-key']
      if (header === undefined || !db) return
      const key = z
        .string()
        .regex(/^[\x21-\x7e]{1,256}$/)
        .parse(header)
      const route = request.url.split('?', 1)[0]!
      const identity = JSON.stringify([key, route])
      const hash = (options.secretBody ? createHmac('sha256', secret) : createHash('sha256'))
        // Method and query are part of the request: `?agent=` picks the profile and `?dryRun=1` turns an apply into a
        // preview, so the same key and body with another query must not replay the first answer (audit 2026-10-08).
        .update(
          canonical({ method: request.method, query: request.query ?? {}, body: request.body }),
        )
        .digest('hex')
      const read = () =>
        db.sqlite
          .prepare('SELECT * FROM request_receipts WHERE key = ? AND route = ?')
          .get(key, route)
      const cutoff = new Date(clock() - 24 * 60 * 60 * 1000).toISOString()
      db.sqlite
        // Pending receipts never expire: the action may have happened before a crash (repeat → 409, not a rerun).
        .prepare(
          'DELETE FROM request_receipts WHERE key = ? AND route = ? AND created_at <= ? AND status IS NOT NULL',
        )
        .run(key, route, cutoff)
      let value = read()
      if (value) {
        let receipt = ReceiptSchema.parse(value)
        if (receipt.body_sha256 !== hash)
          throw new HttpError(
            409,
            'idempotency_conflict',
            'Idempotency key belongs to a different body',
          )
        const flight = flights.get(identity)
        if (receipt.status === null && flight) {
          await flight
          value = read()
          receipt = ReceiptSchema.parse(value)
        }
        if (
          options.rerunUncertain &&
          !flights.has(identity) &&
          (receipt.status === null || receipt.status >= 500)
        ) {
          db.sqlite
            .prepare('DELETE FROM request_receipts WHERE key = ? AND route = ?')
            .run(key, route)
          value = undefined
        }
      }
      if (value) {
        const receipt = ReceiptSchema.parse(value)
        // A crash may leave an uncertain side effect: never rerun a pending receipt.
        if (receipt.status === null || receipt.response === null)
          throw new HttpError(409, 'idempotency_pending', 'Original request has not completed')
        const stored: unknown = JSON.parse(receipt.response)
        const compressed = CompressedReceiptSchema.safeParse(stored)
        const response: unknown = compressed.success
          ? JSON.parse(
              gunzipSync(Buffer.from(compressed.data.scoreReceiptGzip, 'base64'), {
                maxOutputLength: maxResponseBytes,
              }).toString('utf8'),
            )
          : stored
        return reply.code(receipt.status).send(response)
      }
      db.sqlite
        .prepare(
          'INSERT INTO request_receipts (key, route, body_sha256, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(key, route, hash, new Date(clock()).toISOString())
      const pending = Promise.withResolvers<void>()
      flights.set(identity, pending.promise)
      owners.set(request, {
        key,
        route,
        finish: () => {
          flights.delete(identity)
          pending.resolve()
        },
      })
    },
    async onSend(request, reply, payload) {
      const owner = owners.get(request)
      if (!owner || !db) return payload
      try {
        const response = z.string().parse(payload)
        if (Buffer.byteLength(response) > maxResponseBytes)
          throw new Error('Idempotency response exceeds its size limit')
        JSON.parse(response)
        // Keep the DB's 64 KB cap while preserving larger, bounded JSON responses exactly.
        const stored =
          Buffer.byteLength(response) <= storageLimit(owner.route)
            ? response
            : JSON.stringify({ scoreReceiptGzip: gzipSync(response).toString('base64') })
        if (Buffer.byteLength(stored) > storageLimit(owner.route))
          throw new Error('Compressed idempotency response exceeds 64 KB')
        db.sqlite
          .prepare(
            'UPDATE request_receipts SET status = ?, response = ? WHERE key = ? AND route = ?',
          )
          .run(reply.statusCode, stored, owner.key, owner.route)
      } finally {
        owners.delete(request)
        owner.finish()
      }
      return payload
    },
  }
}
