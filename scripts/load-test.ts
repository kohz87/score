// Repeatable load test (`pnpm load-test`, not part of `pnpm check`): a real server in fake mode on a
// throwaway SCORE_HOME takes synthetic traffic through the real ingest path while three SSE clients and a
// Playwright page check measure it. Prints a table, writes $SCORE_HOME/load-report.json, exits 1 on a missed budget.
//
// Knobs (env): LOAD_RATE events/min (1000), LOAD_MINUTES sustained minutes (10), LOAD_BURST_MINUTES burst
// minutes at 5x (1), LOAD_HOME (a fresh temp dir), SCORE_PORT (8893), SCORE_WEB_PORT (5593), LOAD_WEB=0 skips
// the browser check.
import { type ChildProcess, fork, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { cpus, loadavg } from 'node:os'
import { join } from 'node:path'
import {
  BUDGETS,
  burstFactor,
  burstMinutes,
  home,
  rate,
  root,
  serverPort,
  sustainedMinutes,
  webOrigin,
  webPort,
  withWeb,
} from './load-test/config.ts'
import { dbBytes, dist, fileSize, maxOf, round, sleep } from './load-test/metrics.ts'
import { run, waitFor } from './load-test/process.ts'
import { printReport } from './load-test/report.ts'
import { openClient, pairCookie } from './load-test/stream-client.ts'
import { webCheck, type WebResult } from './load-test/web-check.ts'

let phaseName = 'idle'

function sumBefore(phases: { name: string; seconds: number }[], name: string): number {
  let total = 0
  for (const phase of phases) {
    if (phase.name === name) return total
    total += phase.seconds
  }
  return total
}

interface DonePhase {
  name: string
  submitted: number
  seconds: number
  latencies: number[]
  waits: number[]
}

async function main(): Promise<number> {
  mkdirSync(home, { recursive: true })
  console.log(`load test home: ${home}`)
  const children: ChildProcess[] = []
  const abort = new AbortController()
  try {
    if (withWeb) {
      const dist = join(home, 'web-dist')
      const vite = join(root, 'apps/web/node_modules/.bin/vite')
      await run(vite, ['build', '--outDir', dist, '--emptyOutDir'], {
        cwd: join(root, 'apps/web'),
        env: { ...process.env, SCORE_PORT: String(serverPort) },
      })
      children.push(
        spawn(
          vite,
          [
            'preview',
            '--outDir',
            dist,
            '--host',
            '127.0.0.1',
            '--port',
            String(webPort),
            '--strictPort',
          ],
          {
            cwd: join(root, 'apps/web'),
            env: {
              ...process.env,
              SCORE_PORT: String(serverPort),
              SCORE_WEB_PORT: String(webPort),
            },
            stdio: 'ignore',
          },
        ),
      )
    }
    const server = fork(join(root, 'scripts/load-server.ts'), [], {
      cwd: join(root, 'apps/server'),
      execArgv: ['--import', 'tsx'],
      env: {
        ...process.env,
        SCORE_HOME: home,
        SCORE_MODE: 'fake',
        SCORE_PORT: String(serverPort),
        SCORE_WEB_ORIGIN: webOrigin,
      },
    })
    children.push(server)
    const ready = await waitFor<{ token: string }>(server, 'ready', 60_000)
    // A pairing token is single-use; the browser check shares the session with the stream clients.
    const cookie = await pairCookie(ready.token)
    const clients = await Promise.all(
      [0, 1, 2].map(() => openClient(cookie, abort.signal, () => phaseName)),
    )

    const phases = [
      { name: 'sustained', eventsPerMinute: rate, seconds: sustainedMinutes * 60 },
      { name: 'burst', eventsPerMinute: rate * burstFactor, seconds: burstMinutes * 60 },
    ].filter((phase) => phase.seconds > 0)

    const startLoad = loadavg()
    const baseBytes = dbBytes()
    const samples: { at: number; rssBytes: number; cpuMicros: number; loopMaxMs: number }[] = []
    const growth: { at: number; bytes: number; phase: string }[] = []
    server.on(
      'message',
      (message: {
        type: string
        name?: string
        at?: number
        rssBytes?: number
        cpuMicros?: number
        loopMaxMs?: number
      }) => {
        if (message.type === 'sample')
          samples.push({
            at: message.at!,
            rssBytes: message.rssBytes!,
            cpuMicros: message.cpuMicros!,
            loopMaxMs: message.loopMaxMs!,
          })
        if (message.type === 'phase') {
          phaseName = message.name!
          console.log(`phase ${phaseName} started`)
        }
      },
    )
    const growthTimer = setInterval(
      () => growth.push({ at: Date.now(), bytes: dbBytes() - baseBytes, phase: phaseName }),
      15_000,
    )
    const loadSamples: number[] = []
    const loadTimer = setInterval(() => loadSamples.push(loadavg()[0]!), 15_000)

    // Browser checks run mid-phase so the page sees a busy server.
    const webRuns: Promise<{ label: string; ok: boolean; output: string }>[] = []
    const timers = phases.map((phase) =>
      setTimeout(
        () => {
          if (!withWeb) return
          webRuns.push(
            webCheck(phase.name, cookie).then((result) => ({
              label: phase.name,
              ...result,
            })),
          )
        },
        (sumBefore(phases, phase.name) + phase.seconds / 2) * 1000,
      ),
    )

    const startedAt = Date.now()
    const done = waitFor<{
      phases: DonePhase[]
      failed: number
      loopDelayMs: { p50: number; p99: number; max: number }
    }>(server, 'done', (phases.reduce((total, p) => total + p.seconds, 0) + 600) * 1000)
    server.send({ cmd: 'run', phases })
    const result = await done
    for (const timer of timers) clearTimeout(timer)
    const webResults = await Promise.all(webRuns)
    clearInterval(growthTimer)
    clearInterval(loadTimer)
    await sleep(2000)
    const wallSeconds = (Date.now() - startedAt) / 1000
    const finalBytes = dbBytes() - baseBytes

    // Completeness: every stored event after the client's hello reached it, once, in order.
    const check = new DatabaseSync(join(home, 'score.db'), { readOnly: true })
    const problems: string[] = []
    clients.forEach((client, index) => {
      const stored = (
        check.prepare('SELECT seq FROM events WHERE seq > ? ORDER BY seq').all(client.headSeq) as {
          seq: number
        }[]
      ).map((row) => row.seq)
      if (client.closed) problems.push(`client ${index} was disconnected`)
      for (let i = 1; i < client.seqs.length; i += 1)
        if (client.seqs[i]! <= client.seqs[i - 1]!) {
          problems.push(`client ${index} saw seq ${client.seqs[i]} after ${client.seqs[i - 1]}`)
          break
        }
      if (client.seqs.length !== stored.length || client.seqs.some((seq, i) => seq !== stored[i]))
        problems.push(
          `client ${index} received ${client.seqs.length} events, database holds ${stored.length}`,
        )
    })
    const totalEvents = Number(
      (check.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n,
    )
    check.close()
    if (result.failed > 0) problems.push(`${result.failed} observations failed`)

    const sweepDone = waitFor<{
      events: number
      deleted: number
      pruneMs: number
      retired: { retired: number; floors: number }
      retireMs: number
    }>(server, 'swept', 120_000)
    server.send({ cmd: 'sweep' })
    const swept = await sweepDone

    const phaseReports = result.phases.map((phase) => ({
      name: phase.name,
      submitted: phase.submitted,
      seconds: round(phase.seconds),
      eventsPerMinute: round((phase.submitted / phase.seconds) * 60, 0),
      ingestMs: dist(phase.latencies),
      queueWaitMs: dist(phase.waits),
      commitMs: dist(phase.latencies.map((value, i) => value - (phase.waits[i] ?? 0))),
      lagMs: dist(clients.flatMap((client) => client.lagByPhase.get(phase.name) ?? [])),
    }))

    const cpuPercent: number[] = []
    for (let i = 1; i < samples.length; i += 1) {
      const dt = (samples[i]!.at - samples[i - 1]!.at) * 1000
      if (dt > 0) cpuPercent.push(((samples[i]!.cpuMicros - samples[i - 1]!.cpuMicros) / dt) * 100)
    }
    const maxRssMb = maxOf(samples.map((s) => s.rssBytes)) / 1048576
    const bytesPerEvent = totalEvents > 0 ? finalBytes / totalEvents : 0
    // DB growth at the sustained rate, per 10 minutes: bytes per stored event times events in 10 minutes.
    const growthMbPer10Min = (bytesPerEvent * rate * 10) / 1048576

    let webRows: WebResult[] = []
    if (withWeb) {
      try {
        webRows = readFileSync(join(home, 'web-perf.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as WebResult)
      } catch {
        problems.push('no browser results were written')
      }
      for (const entry of webResults)
        if (!entry.ok)
          problems.push(`browser check failed during ${entry.label}:\n${entry.output.slice(-1500)}`)
      if (webRows.length < webResults.length * 3) problems.push('browser results are incomplete')
    }

    const sustained = phaseReports.find((phase) => phase.name === 'sustained') ?? phaseReports[0]
    const burst = phaseReports.find((phase) => phase.name === 'burst')
    const verdicts: Record<string, { value: number; budget: number }> = {
      ingestP95: { value: sustained?.ingestMs.p95 ?? 0, budget: BUDGETS.ingestP95Ms },
      lagP95: { value: sustained?.lagMs.p95 ?? 0, budget: BUDGETS.lagP95Ms },
      rssMb: { value: round(maxRssMb), budget: BUDGETS.rssMb },
      dbGrowthMbPer10Min: { value: round(growthMbPer10Min, 2), budget: BUDGETS.dbGrowthMbPer10Min },
      ...(burst
        ? {
            ingestP95Burst: { value: burst.ingestMs.p95, budget: BUDGETS.ingestP95Ms },
            lagP95Burst: { value: burst.lagMs.p95, budget: BUDGETS.lagP95Ms },
          }
        : {}),
      ...(withWeb
        ? {
            renderMs: {
              value: maxOf(webRows.map((row) => row.renderMs)),
              budget: BUDGETS.renderMs,
            },
            longTaskMs: {
              value: maxOf(webRows.map((row) => row.maxLongTaskMs)),
              budget: BUDGETS.longTaskMs,
            },
          }
        : {}),
    }
    const failures = Object.entries(verdicts)
      .filter(([, v]) => v.value >= v.budget)
      .map(([name, v]) => `${name}: ${v.value} >= ${v.budget}`)
    failures.push(...problems)

    const report = {
      finishedAt: new Date().toISOString(),
      machine: {
        cpus: cpus().length,
        model: cpus()[0]?.model,
        loadAverageAtStart: startLoad.map((v) => round(v, 2)),
        loadAverageAtEnd: loadavg().map((v) => round(v, 2)),
        maxLoadAverageDuringRun: round(maxOf(loadSamples), 2),
        node: process.version,
      },
      config: {
        rate,
        sustainedMinutes,
        burstMinutes,
        burstFactor,
        wallSeconds: round(wallSeconds),
      },
      totalEvents,
      phases: phaseReports,
      overall: {
        ingestMs: dist(result.phases.flatMap((phase) => phase.latencies)),
        lagMs: dist(clients.flatMap((client) => client.lags)),
      },
      resources: {
        maxRssMb: round(maxRssMb),
        cpuPercentAvg: round(cpuPercent.reduce((a, b) => a + b, 0) / (cpuPercent.length || 1)),
        cpuPercentMax: round(maxOf(cpuPercent)),
        eventLoopDelayMs: result.loopDelayMs,
        // Windows (5 s) in which the server process froze for over a second: external CPU/memory
        // starvation, not commit time. Read these before blaming a latency miss on the code.
        stalls: samples
          .filter((sample) => sample.loopMaxMs > 1000)
          .map((sample) => ({
            at: new Date(sample.at).toISOString(),
            loopMaxMs: round(sample.loopMaxMs, 0),
          })),
      },
      db: {
        growthMb: round(finalBytes / 1048576, 2),
        bytesPerEvent: round(bytesPerEvent, 0),
        growthMbPer10MinAtRate: round(growthMbPer10Min, 2),
        walMbAtEnd: round(fileSize(join(home, 'score.db-wal')) / 1048576, 2),
        series: growth,
      },
      retention: swept,
      web: webRows,
      budgets: BUDGETS,
      verdicts,
      failures,
    }
    writeFileSync(join(home, 'load-report.json'), `${JSON.stringify(report, null, 2)}\n`)
    printReport(report)

    abort.abort()
    server.send({ cmd: 'stop' })
    await new Promise((resolve) => server.once('exit', resolve))
    return failures.length === 0 ? 0 : 1
  } finally {
    abort.abort()
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
  }
}

try {
  process.exitCode = await main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
