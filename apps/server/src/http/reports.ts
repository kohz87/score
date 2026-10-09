import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { JourneySchema, ReportRangeSchema, ReportsSchema } from '@score/contract'
import type { ScoreDb } from '../db/index.ts'
import {
  computeReports,
  customRangeProblem,
  readReportRows,
  reportWindow,
  localTimeZone,
  type ReportRun,
  type CustomDays,
} from '../domain/reports.ts'
import { computeTrend, trendWindow } from '../domain/reports-trend.ts'
import { computeJourney, readAgentNotes, readTaskTitles } from '../domain/journey.ts'
import { reportsToCsv } from '../domain/reports-csv.ts'
import { codingSpendInWindow } from '../domain/coding-spend.ts'
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
    // Coding agents (PLAN 7.2): spend from their own runs, marked estimated or unknown. An unknown one is left out
    // of the total (never counted as zero) and listed in `spendExcluded`.
    const coding = db
      ? db.read((sqlite) => codingSpendInWindow(sqlite, window.from, window.to))
      : []
    for (const item of coding) facts.spendUsd[item.agentId] = item.costUsd ?? 0
    const own: ReturnType<typeof readReportRows> = db
      ? db.read((sqlite) => readReportRows(sqlite, window.from, window.to))
      : { runs: [], approvals: [] }
    const seeded = (await port.reportHistoryRows?.(now, agentIds)) ?? { runs: [], approvals: [] }
    // A removed coding agent leaves the numbers (its runs stay in its rooms and history).
    const removed = new Set(
      db
        ? db.read((sqlite) =>
            sqlite
              .prepare('SELECT id FROM coding_agents WHERE removed_at IS NOT NULL')
              .all()
              .map((row) => String(row.id)),
          )
        : [],
    )
    const rows = {
      runs: [...own.runs, ...seeded.runs].filter((run) => !removed.has(run.agentId)),
      approvals: [...own.approvals, ...seeded.approvals],
    }
    // The 30-day trend is independent of the range: its own window of runs and its own cost readings.
    const trendTz = tz ?? localTimeZone()
    const trend = trendWindow(now, trendTz)
    const trendOwn: Pick<ReturnType<typeof readReportRows>, 'runs' | 'attempts'> = db
      ? db.read((sqlite) => readReportRows(sqlite, trend.from, trend.to))
      : { runs: [] }
    // Attempts of a known agent are runs in the trend; unattributed ones are counted in the report's own bucket.
    const trendAttempts: ReportRun[] = (trendOwn.attempts ?? []).flatMap((attempt) =>
      attempt.agentId === null
        ? []
        : [{ agentId: attempt.agentId, startedAt: attempt.startedAt, endedAt: attempt.endedAt }],
    )
    const trendSeeded: { runs: ReportRun[]; trendSpendUsd?: number[] } =
      (await port.reportHistoryRows?.(now, agentIds)) ?? { runs: [] }
    let trendCosts: Awaited<ReturnType<NonNullable<typeof port.sessionCosts>>> | undefined
    if (db && port.sessionCosts)
      trendCosts = await port.sessionCosts({ sinceMs: trend.from, agentIds })
    const trendRows = db
      ? db.tx((sqlite) => {
          for (const [profile, sessions] of Object.entries(trendCosts ?? {}))
            recordSessionCosts(sqlite, profile, sessions, now)
          return computeTrend({
            now,
            tz: trendTz,
            runs: [...trendOwn.runs, ...trendAttempts, ...trendSeeded.runs].filter(
              (run) => !removed.has(run.agentId),
            ),
            ...(trendSeeded.trendSpendUsd ? { demoSpendUsd: trendSeeded.trendSpendUsd } : {}),
            ...(trendCosts ? { costs: trendCosts, agentIds, sqlite } : {}),
          })
        })
      : computeTrend({
          now,
          tz: trendTz,
          runs: trendSeeded.runs,
          ...(trendSeeded.trendSpendUsd ? { demoSpendUsd: trendSeeded.trendSpendUsd } : {}),
        })
    const computed = computeReports({
      range,
      ...(custom ? { custom } : {}),
      now,
      ...(tz ? { tz } : {}),
      agentIds,
      facts,
      ...rows,
      ...(own.attempts ? { attempts: own.attempts } : {}),
    })
    const codingById = new Map(coding.map((item) => [item.agentId, item]))
    const excluded = coding.filter((item) => item.costUsd === null).map((item) => item.agentId)
    const report = ReportsSchema.parse({
      ...computed,
      totals: {
        ...computed.totals,
        ...(coding.some((item) => item.costUsd !== null) ? { spendEstimated: true } : {}),
        ...(excluded.length ? { spendExcluded: excluded } : {}),
      },
      byAgent: computed.byAgent.map((row) => {
        const item = codingById.get(row.agentId)
        return item
          ? { ...row, spendUsd: item.costUsd, spendBasis: item.basis, runtime: item.runtime }
          : row
      }),
      trend: trendRows,
    })
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

  // 7.4c: read-only marks per agent; days are the viewer's (same rules as range=custom).
  const journeyQuery = z
    .object({
      from: z.string().max(10),
      to: z.string().max(10),
      tz: ZoneSchema.optional(),
    })
    .strict()
  app.get('/api/reports/journey', async (request) => {
    const q = journeyQuery.parse(request.query)
    const tz = q.tz ?? serverTz
    const now = clock()
    const problem = customRangeProblem({ from: q.from, to: q.to }, now, tz)
    if (problem) throw new HttpError(400, 'bad_request', problem)
    const window = reportWindow('custom', now, tz, { from: q.from, to: q.to })
    const agentIds = db ? db.read((sqlite) => readAgentNames(sqlite)).map((agent) => agent.id) : []
    const facts = await port.journeyFacts({ from: window.from, to: window.to, agentIds })
    const done = facts.tasks.filter((task) => task.at >= window.from && task.at <= window.to)
    const { titles, notes } = db
      ? db.read((sqlite) => ({
          titles: readTaskTitles(
            sqlite,
            done.filter((task) => task.title === undefined).map((task) => task.id),
          ),
          notes: readAgentNotes(sqlite, window.from, window.to),
        }))
      : { titles: new Map<string, string>(), notes: [] }
    return JourneySchema.parse(
      computeJourney({ from: q.from, to: q.to, window, agentIds, facts, titles, notes }),
    )
  })
}
