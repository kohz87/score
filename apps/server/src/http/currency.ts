import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { DisplayCurrencySchema, type DisplayCurrency } from '@score/contract'
import { humanGuard } from '../auth/human.ts'
import type { ScoreDb } from '../db/index.ts'

const KEY = 'display_currency'
const USD: DisplayCurrency = { code: 'USD', rate: 1 }
const RowSchema = z.object({ value: z.string() })

/**
 * Settings › Look "Display currency" (5.29): a code and a rate the person types; Score never fetches rates. Stored in
 * Score's own `meta` table. Reports are always computed in USD; the page multiplies for display.
 */
export function registerCurrencyRoutes(app: FastifyInstance, db: ScoreDb | undefined): void {
  const read = (): DisplayCurrency => {
    if (!db) return USD
    const row = db.read((sqlite) => sqlite.prepare('SELECT value FROM meta WHERE key = ?').get(KEY))
    if (!row) return USD
    try {
      const parsed = DisplayCurrencySchema.safeParse(JSON.parse(RowSchema.parse(row).value))
      return parsed.success ? parsed.data : USD
    } catch {
      return USD
    }
  }
  app.get('/api/settings/currency', async () => read())
  app.put('/api/settings/currency', { preHandler: [humanGuard(app.pairing)] }, async (request) => {
    const body = DisplayCurrencySchema.parse(request.body)
    // USD is the base: its rate is always 1.
    const next = body.code === 'USD' ? USD : body
    if (db)
      db.tx((sqlite) =>
        sqlite
          .prepare(
            'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
          )
          .run(KEY, JSON.stringify(next)),
      )
    return next
  })
}
