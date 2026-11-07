import { round, type Dist } from './metrics.ts'
import type { WebResult } from './web-check.ts'

function printReport(report: {
  machine: {
    cpus: number
    loadAverageAtStart: number[]
    loadAverageAtEnd: number[]
    maxLoadAverageDuringRun: number
  }
  phases: {
    name: string
    eventsPerMinute: number
    ingestMs: Dist
    queueWaitMs: Dist
    lagMs: Dist
  }[]
  resources: {
    maxRssMb: number
    cpuPercentAvg: number
    cpuPercentMax: number
    stalls: { at: string; loopMaxMs: number }[]
  }
  db: { growthMb: number; growthMbPer10MinAtRate: number; walMbAtEnd: number }
  retention: { events: number; deleted: number; pruneMs: number; retireMs: number }
  web: WebResult[]
  verdicts: Record<string, { value: number; budget: number }>
  failures: string[]
}): void {
  console.log(
    `\nmachine: ${report.machine.cpus} CPUs, load average start ${report.machine.loadAverageAtStart.join('/')}, end ${report.machine.loadAverageAtEnd.join('/')}, highest 1-min sample during run ${report.machine.maxLoadAverageDuringRun}`,
  )
  console.table(
    report.phases.map((phase) => ({
      phase: phase.name,
      'events/min': phase.eventsPerMinute,
      'ingest p50': phase.ingestMs.p50,
      'ingest p95': phase.ingestMs.p95,
      'ingest p99': phase.ingestMs.p99,
      'queue p95': phase.queueWaitMs.p95,
      'lag p50': phase.lagMs.p50,
      'lag p95': phase.lagMs.p95,
      'lag p99': phase.lagMs.p99,
    })),
  )
  console.log(
    `RSS max ${report.resources.maxRssMb} MB, CPU avg ${report.resources.cpuPercentAvg}% max ${report.resources.cpuPercentMax}%, DB growth ${report.db.growthMb} MB (${report.db.growthMbPer10MinAtRate} MB per 10 min at rate), WAL ${report.db.walMbAtEnd} MB`,
  )
  if (report.resources.stalls.length)
    console.log(
      `WARNING: the server process froze for over 1 s in ${report.resources.stalls.length} window(s) (longest ${Math.max(...report.resources.stalls.map((stall) => stall.loopMaxMs))} ms): the machine was starved. Rerun on a quieter machine.`,
    )
  console.log(
    `retention sweep: pruned ${report.retention.deleted}/${report.retention.events} events in ${round(report.retention.pruneMs)} ms, retired ingest keys in ${round(report.retention.retireMs)} ms`,
  )
  if (report.web.length) console.table(report.web)
  console.table(
    Object.entries(report.verdicts).map(([name, v]) => ({
      budget: name,
      value: v.value,
      limit: v.budget,
      result: v.value < v.budget ? 'ok' : 'FAIL',
    })),
  )
  console.log(
    report.failures.length === 0 ? 'ALL BUDGETS MET' : `FAILED:\n${report.failures.join('\n')}`,
  )
}

export { printReport }
