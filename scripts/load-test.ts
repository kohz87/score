// Repeatable load test (`pnpm load-test`, not part of `pnpm check`): a real server in fake mode on a
// throwaway SCORE_HOME takes synthetic traffic through the real ingest path while three SSE clients and a
// Playwright page check measure it. Prints a table, writes $SCORE_HOME/load-report.json, exits 1 on a missed budget.
//
// Knobs (env): LOAD_RATE events/min (1000), LOAD_MINUTES sustained minutes (10), LOAD_BURST_MINUTES burst
// minutes at 5x (1), LOAD_HOME (a fresh temp dir), SCORE_PORT (8893), SCORE_WEB_PORT (5593), LOAD_WEB=0 skips
// the browser check.
import { type ChildProcess, execFile, fork, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { cpus, loadavg, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const num = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`)
  return value
}

const rate = num('LOAD_RATE', 1000)
const sustainedMinutes = num('LOAD_MINUTES', 10)
const burstMinutes = num('LOAD_BURST_MINUTES', 1)
const burstFactor = 5
const serverPort = num('SCORE_PORT', 8893)
const webPort = num('SCORE_WEB_PORT', 5593)
const withWeb = process.env.LOAD_WEB !== '0'
const home = process.env.LOAD_HOME ?? mkdtempSync(join(tmpdir(), 'score-load-'))
const origin = `http://127.0.0.1:${serverPort}`
const webOrigin = `http://127.0.0.1:${webPort}`

const BUDGETS = {
  ingestP95Ms: 25,
  lagP95Ms: 250,
  rssMb: 400,
  dbGrowthMbPer10Min: 50,
  renderMs: 2000,
  longTaskMs: 200,
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!
}
const round = (value: number, digits = 1) => Number(value.toFixed(digits))
const dist = (values: number[]) => ({
  count: values.length,
  p50: round(percentile(values, 50), 2),
  p95: round(percentile(values, 95), 2),
  p99: round(percentile(values, 99), 2),
  max: round(
    values.reduce((a, b) => Math.max(a, b), 0),
    2,
  ),
})
type Dist = ReturnType<typeof dist>
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const fileSize = (path: string) => {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}
const dbBytes = () => fileSize(join(home, 'score.db')) + fileSize(join(home, 'score.db-wal'))
const maxOf = (values: number[]) => values.reduce((a, b) => Math.max(a, b), 0)

interface Client {
  headSeq: number
  seqs: number[]
  lags: number[]
  lagByPhase: Map<string, number[]>
  closed: boolean
}

let phaseName = 'idle'

async function openClient(cookie: string, abort: AbortSignal): Promise<Client> {
  const client: Client = { headSeq: -1, seqs: [], lags: [], lagByPhase: new Map(), closed: false }
  const response = await fetch(`${origin}/api/stream`, { headers: { cookie }, signal: abort })
  if (!response.ok || !response.body) throw new Error(`stream refused: ${response.status}`)
  const hello = Promise.withResolvers<void>()
  void (async () => {
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        const received = Date.now()
        buffer += decoder.decode(chunk, { stream: true })
        let end: number
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          const data = /^data: (.*)$/m.exec(frame)?.[1]
          if (!data) continue
          const message = JSON.parse(data) as {
            type: string
            seq?: number
            ts?: string
            data?: { headSeq?: number }
          }
          if (message.type === 'stream.hello') {
            client.headSeq = message.data!.headSeq!
            hello.resolve()
          } else if (message.seq !== undefined && message.ts !== undefined) {
            client.seqs.push(message.seq)
            const lag = received - Date.parse(message.ts)
            client.lags.push(lag)
            const list = client.lagByPhase.get(phaseName) ?? []
            list.push(lag)
            client.lagByPhase.set(phaseName, list)
          }
        }
      }
    } catch {
      // Aborted at the end of the run.
    }
    client.closed = true
  })()
  await hello.promise
  return client
}

async function pairCookie(token: string): Promise<string> {
  const response = await fetch(`${origin}/api/session/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: webOrigin, 'x-score-client': 'web' },
    body: JSON.stringify({ token }),
  })
  const cookie = response.headers.getSetCookie()[0]?.split(';')[0]
  if (response.status !== 204 || !cookie) throw new Error(`pairing failed: ${response.status}`)
  return cookie
}

interface WebResult {
  label: string
  route: string
  renderMs: number
  longTasks: number
  maxLongTaskMs: number
}

async function webCheck(label: string, cookie: string): Promise<{ ok: boolean; output: string }> {
  const [name, value] = cookie.split('=') as [string, string]
  try {
    const { stdout } = await run(
      join(root, 'node_modules/.bin/playwright'),
      ['test', '-c', 'scripts/perf/playwright.config.ts'],
      {
        cwd: root,
        env: {
          ...process.env,
          PERF_BASE_URL: webOrigin,
          PERF_COOKIE_NAME: name,
          PERF_COOKIE_VALUE: value,
          PERF_LABEL: label,
          PERF_OUT: join(home, 'web-perf.jsonl'),
        },
        maxBuffer: 10 * 1024 * 1024,
      },
    )
    return { ok: true, output: stdout }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string }
    return { ok: false, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
  }
}

function waitFor<T>(child: ChildProcess, type: string, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer)
      child.off('message', onMessage)
      child.off('exit', onExit)
    }
    const timer = setTimeout(() => {
      finish()
      reject(new Error(`timed out waiting for ${type}`))
    }, timeoutMs)
    const onMessage = (message: { type: string; message?: string }) => {
      if (message.type === 'error') {
        finish()
        reject(new Error(message.message))
      } else if (message.type === type) {
        finish()
        resolve(message as T)
      }
    }
    const onExit = () => {
      finish()
      reject(new Error(`server exited before ${type}`))
    }
    child.on('message', onMessage)
    child.once('exit', onExit)
  })
}

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
    const clients = await Promise.all([0, 1, 2].map(() => openClient(cookie, abort.signal)))

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

try {
  process.exitCode = await main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
