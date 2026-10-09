import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ReportRangeSchema, ReportsSchema } from '@score/contract'
import type { ScoreDb } from '../db/index.ts'
import {
  computeReports,
  customRangeProblem,
  readReportRows,
  reportWindow,
  type CustomDays,
} from '../domain/reports.ts'
import { reportsToCsv } from '../domain/reports-csv.ts'
import { profileSpendInWindow, recordSessionCosts } from '../domain/spend.ts'
import { readAgentNames } from '../domain/agents.ts'
import { HttpError } from '../errors.ts'
import type { HermesPort } from '../hermes/index.ts'

export function registerReportRoutes(
  app: FastifyInstance,
  port: HermesPort,
  db?: ScoreDb,
  clock = Date.now,
  serverTz?: string,
): void {
  // Days are the viewer's days: the browser sends its IANA time zone (the server's is often UTC).
  const ZoneSchema = z
    .string()
    .max(64)
    .refine((zone) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: zone })
        return true
      } catch {
        return false
      }
    })
  const query = z
    .object({
      range: ReportRangeSchema,
      tz: ZoneSchema.optional(),
      from: z.string().max(10).optional(),
      to: z.string().max(10).optional(),
    })
    .strict()

  type Query = z.infer<typeof query>
  /** Custom days are only for range=custom, and then both are required. */
  function customDays(q: Query, now: number, tz?: string): CustomDays | undefined {
    if (q.range !== 'custom') {
      if (q.from !== undefined || q.to !== undefined)
        throw new HttpError(400, 'bad_request', 'from and to only go with range=custom')
      return undefined
    }
    if (q.from === undefined || q.to === undefined)
      throw new HttpError(400, 'bad_request', 'range=custom needs from and to (YYYY-MM-DD)')
    const custom = { from: q.from, to: q.to }
    const problem = customRangeProblem(custom, now, tz)
    if (problem) throw new HttpError(400, 'bad_request', problem)
    return custom
  }

  async function load(q: Query) {
    const { range } = q
    const tz = q.tz ?? serverTz
    const now = clock()
    const custom = customDays(q, now, tz)
    const window = reportWindow(range, now, tz, custom)
    // Score's own projection: asking Hermes for its agents runs several CLI calls per profile (seconds).
    const agents = db ? db.read((sqlite) => readAgentNames(sqlite)) : []
    const agentIds = agents.map((agent) => agent.id)
    const facts = await port.reportFacts({ from: window.from, to: window.to, agentIds })
    if (db && port.sessionCosts) {
      // Snapshot first, so the window always holds a reading and each session's share is its delta.
      const costs = await port.sessionCosts({ sinceMs: window.from, agentIds })
      for (const [profile, sessions] of Object.entries(costs)) {
        facts.spendUsd[profile] = db.tx((sqlite) => {
          recordSessionCosts(sqlite, profile, sessions, now)
          return profileSpendInWindow(sqlite, profile, sessions, window.from, window.to)
        })
      }
    }
    const own = db
      ? db.read((sqlite) => readReportRows(sqlite, window.from, window.to))
      : { runs: [], approvals: [] }
    const seeded = (await port.reportHistoryRows?.(now, agentIds)) ?? { runs: [], approvals: [] }
    const rows = {
      runs: [...own.runs, ...seeded.runs],
      approvals: [...own.approvals, ...seeded.approvals],
    }
    const report = ReportsSchema.parse(
      computeReports({
        range,
        ...(custom ? { custom } : {}),
        now,
        ...(tz ? { tz } : {}),
        agentIds,
        facts,
        ...rows,
      }),
    )
    return { report, agents, today: window.days.at(-1) ?? new Date(now).toISOString().slice(0, 10) }
  }

  app.get('/api/reports', async (request) => {
    return (await load(query.parse(request.query))).report
  })

  // The same aggregation as the page, so the file's columns match the By agent table.
  app.get('/api/reports/export.csv', async (request, reply) => {
    const q = query.parse(request.query)
    const { report, agents, today } = await load(q)
    const label = q.range === 'custom' ? `${q.from}_${q.to}` : `${q.range}-${today}`
    const names = Object.fromEntries(agents.map((agent) => [agent.id, agent.name]))
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="score-report-${label}.csv"`)
      .send(reportsToCsv(report, names))
  })
}
