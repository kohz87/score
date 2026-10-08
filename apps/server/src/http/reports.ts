import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ReportRangeSchema, ReportsSchema } from '@score/contract'
import type { ScoreDb } from '../db/index.ts'
import { computeReports, readReportRows, reportWindow } from '../domain/reports.ts'
import { reportsToCsv } from '../domain/reports-csv.ts'
import { profileSpendInWindow, recordSessionCosts } from '../domain/spend.ts'
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
  const query = z.object({ range: ReportRangeSchema, tz: ZoneSchema.optional() }).strict()

  async function load(range: z.infer<typeof ReportRangeSchema>, viewerTz?: string) {
    const tz = viewerTz ?? serverTz
    const now = clock()
    const window = reportWindow(range, now, tz)
    const agents = await port.listAgents()
    const agentIds = agents.map((agent) => agent.id)
    const facts = await port.reportFacts({ from: window.from, to: now, agentIds })
    if (db && port.sessionCosts) {
      // Snapshot first, so the window always holds a reading and each session's share is its delta.
      const costs = await port.sessionCosts({ sinceMs: window.from, agentIds })
      for (const [profile, sessions] of Object.entries(costs)) {
        facts.spendUsd[profile] = db.tx((sqlite) => {
          recordSessionCosts(sqlite, profile, sessions, now)
          return profileSpendInWindow(sqlite, profile, sessions, window.from, now)
        })
      }
    }
    const own = db
      ? db.read((sqlite) => readReportRows(sqlite, window.from, now))
      : { runs: [], approvals: [] }
    const seeded = (await port.reportHistoryRows?.(now, agentIds)) ?? { runs: [], approvals: [] }
    const rows = {
      runs: [...own.runs, ...seeded.runs],
      approvals: [...own.approvals, ...seeded.approvals],
    }
    const report = ReportsSchema.parse(
      computeReports({ range, now, ...(tz ? { tz } : {}), agentIds, facts, ...rows }),
    )
    return { report, agents, today: window.days.at(-1) ?? new Date(now).toISOString().slice(0, 10) }
  }

  app.get('/api/reports', async (request) => {
    const { range, tz } = query.parse(request.query)
    return (await load(range, tz)).report
  })

  // The same aggregation as the page, so the file's columns match the By agent table.
  app.get('/api/reports/export.csv', async (request, reply) => {
    const { range, tz } = query.parse(request.query)
    const { report, agents, today } = await load(range, tz)
    const names = Object.fromEntries(agents.map((agent) => [agent.id, agent.name]))
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="score-report-${range}-${today}.csv"`)
      .send(reportsToCsv(report, names))
  })
}
