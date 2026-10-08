import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ReportRangeSchema, ReportsSchema } from '@score/contract'
import type { ScoreDb } from '../db/index.ts'
import { computeReports, readReportRows, reportWindow } from '../domain/reports.ts'
import { reportsToCsv } from '../domain/reports-csv.ts'
import type { HermesPort } from '../hermes/index.ts'

export function registerReportRoutes(
  app: FastifyInstance,
  port: HermesPort,
  db?: ScoreDb,
  clock = Date.now,
  tz?: string,
): void {
  const query = z.object({ range: ReportRangeSchema }).strict()

  async function load(range: z.infer<typeof ReportRangeSchema>) {
    const now = clock()
    const window = reportWindow(range, now, tz)
    const agents = await port.listAgents()
    const agentIds = agents.map((agent) => agent.id)
    const facts = await port.reportFacts({ from: window.from, to: now, agentIds })
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

  app.get('/api/reports', async (request) => (await load(query.parse(request.query).range)).report)

  // The same aggregation as the page, so the file's columns match the By agent table.
  app.get('/api/reports/export.csv', async (request, reply) => {
    const { range } = query.parse(request.query)
    const { report, agents, today } = await load(range)
    const names = Object.fromEntries(agents.map((agent) => [agent.id, agent.name]))
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="score-report-${range}-${today}.csv"`)
      .send(reportsToCsv(report, names))
  })
}
