// Server half of the load test (spawned by scripts/load-test.ts): starts the real server in fake mode on
// the given SCORE_HOME and feeds synthetic observations through the real ingest path at a set rate.
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { loadConfig } from '../apps/server/src/config.ts'
import { stepToObservation } from '../apps/server/src/hermes/fake/fake-port.ts'
import { pruneEvents } from '../apps/server/src/hub/retention.ts'
import { retireIngestKeys } from '../apps/server/src/hub/retire.ts'
import { startServer } from '../apps/server/src/start-server.ts'
import { cycleSteps, roomSteps } from './load-steps.ts'
import type { ScenarioStep } from '../apps/server/src/hermes/fake/scenario.ts'

interface Phase {
  name: string
  eventsPerMinute: number
  seconds: number
}
type Command = { cmd: 'run'; phases: Phase[] } | { cmd: 'sweep' } | { cmd: 'stop' }

function send(message: Record<string, unknown>): void {
  process.send?.(message)
}

const server = await startServer(loadConfig(process.env), { logger: { level: 'error' } })
const { ingest, db } = server
const iso = () => new Date().toISOString()
const loopDelay = monitorEventLoopDelay({ resolution: 5 })
loopDelay.enable()

send({
  type: 'ready',
  token: server.pairingToken,
})

let overallLoopMax = 0
let submitted = 0
let failed = 0
let identity = 0
let cycle = 0

function submit(step: ScenarioStep, latencies: number[], waits: number[]): void {
  identity += 1
  const observation = stepToObservation(step, `load:${identity}`)
  const queuedAt = performance.now()
  const apply = observation.apply
  let startedAt = queuedAt
  // Time spent waiting for the single writer is reported apart from the transaction itself.
  observation.apply = (context) => {
    startedAt = performance.now()
    return apply(context)
  }
  submitted += 1
  ingest
    .submit(observation)
    .then(() => {
      const done = performance.now()
      latencies.push(done - queuedAt)
      waits.push(startedAt - queuedAt)
    })
    .catch((error: unknown) => {
      failed += 1
      process.stderr.write(`load submit failed: ${String(error)}\n`)
    })
}

async function run(phases: Phase[]): Promise<void> {
  for (const step of roomSteps()) submit(step, [], [])
  const active: ScenarioStep[][] = []
  const results: Record<string, unknown>[] = []
  const sampler = setInterval(() => {
    const usage = process.cpuUsage()
    // Longest event-loop stall in this window; a frozen process (starved CPU, swapping) shows up here
    // while the commit times themselves stay small.
    const loopMaxMs = loopDelay.max / 1e6
    overallLoopMax = Math.max(overallLoopMax, loopMaxMs)
    loopDelay.reset()
    send({
      loopMaxMs,
      type: 'sample',
      rssBytes: process.memoryUsage().rss,
      cpuMicros: usage.user + usage.system,
      at: Date.now(),
    })
  }, 5000)
  for (const phase of phases) {
    const latencies: number[] = []
    const waits: number[] = []
    const first = submitted
    send({ type: 'phase', name: phase.name, at: Date.now() })
    const started = performance.now()
    let last = started
    let owed = 0
    while (performance.now() - started < phase.seconds * 1000) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      const now = performance.now()
      owed += ((now - last) / 60_000) * phase.eventsPerMinute
      last = now
      while (owed >= 1) {
        owed -= 1
        // Keep a handful of runs in flight so their events interleave like a busy team's.
        if (active.length < 8) active.push(cycleSteps((cycle += 1), iso))
        const index = Math.floor(Math.random() * active.length)
        const steps = active[index]!
        submit(steps.shift()!, latencies, waits)
        if (steps.length === 0) active.splice(index, 1)
      }
    }
    await ingest.drain()
    results.push({
      name: phase.name,
      submitted: submitted - first,
      seconds: (performance.now() - started) / 1000,
      latencies,
      waits,
    })
  }
  clearInterval(sampler)
  await ingest.flushListeners()
  send({
    type: 'done',
    phases: results,
    failed,
    loopDelayMs: {
      p50: loopDelay.percentile(50) / 1e6,
      p99: loopDelay.percentile(99) / 1e6,
      max: Math.max(overallLoopMax, loopDelay.max / 1e6),
    },
  })
}

function sweep(): void {
  // Everything is "older than" a minute from now, so this measures deleting the whole run's events.
  const olderThan = new Date(Date.now() + 60_000).toISOString()
  const events = Number(db.sqlite.prepare('SELECT count(*) AS n FROM events').get()?.n ?? 0)
  const started = performance.now()
  const deleted = pruneEvents(db, { olderThan })
  const pruneMs = performance.now() - started
  const retireStarted = performance.now()
  const retired = retireIngestKeys(db, { keepPositions: 0 })
  send({
    type: 'swept',
    events,
    deleted,
    pruneMs,
    retired,
    retireMs: performance.now() - retireStarted,
  })
}

process.on('message', (message: Command) => {
  if (message.cmd === 'run')
    void run(message.phases).catch((error: unknown) => {
      send({ type: 'error', message: String(error) })
    })
  else if (message.cmd === 'sweep') sweep()
  else
    void server.close().then(() => {
      process.exit(0)
    })
})
