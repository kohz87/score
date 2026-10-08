import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ReportRangeSchema, ReportsSchema } from '@score/contract'
import type { ScoreDb } from '../db/index.ts'
import { computeReports, readReportRows, reportWindow } from '../domain/reports.ts'
import type { HermesPort } from '../hermes/index.ts'

export function registerReportRoutes(
  app: FastifyInstance,
  port: HermesPort,
  db?: ScoreDb,
  clock = Date.now,
  tz?: string,
): void {
  app.get('/api/reports', async (request) => {
    const { range } = z.object({ range: ReportRangeSchema }).strict().parse(request.query)
    const now = clock()
    const window = reportWindow(range, now, tz)
    const agentIds = (await port.listAgents()).map((agent) => agent.id)
    const facts = await port.reportFacts({ from: window.from, to: now, agentIds })
    const rows = db
      ? db.read((sqlite) => readReportRows(sqlite, window.from, now))
      : { runs: [], approvals: [] }
    return ReportsSchema.parse(
      computeReports({ range, now, ...(tz ? { tz } : {}), agentIds, facts, ...rows }),
    )
  })
}
