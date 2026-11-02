import { randomUUID } from 'node:crypto'
import type {
  HermesCheck,
  HermesUpdateChannel,
  HermesUpdateCheck,
  HermesUpdateJob,
  HermesUpdateStatus,
} from '@score/contract'
import { HttpError } from '../../errors.ts'
import { redact } from '../../redact.ts'
import type { HermesUpdateCommand, HermesUpdateSpawner } from './cli.ts'

// 3.15.0 (owner, 2026-11-02): update Hermes from Settings › System. One job at a time, in memory (a Score restart
// forgets it; Hermes's own update keeps running and Score's version check still reports the result). The steps:
// wait until no Score run is active, `hermes update --backup --yes` (Hermes backs itself up, waits for its own
// in-flight turns, restarts its gateway), Score's compatibility check, one short test message to an agent the person
// picks. Score never reads Hermes's files for the backup and never rolls Hermes's code back itself.

export interface HermesUpdatesDeps {
  hermesHome?: string | undefined
  spawn: HermesUpdateSpawner
  clock?: () => number
  /** Score has no active turn or run; `note` says what is still going. */
  idle: () => { idle: boolean; note: string }
  /** `hermes --version`'s first line, e.g. "Hermes Agent v0.22.5+3257.g557254f (…)"; null when unknown. */
  version: () => Promise<string | null>
  check: () => Promise<HermesCheck>
  accept: (hash: string) => Promise<void>
  startTestRun: (agentId: string, input: string) => Promise<{ runId: string }>
  readRun: (
    runId: string,
  ) => { status: string; output: string | null; error: string | null } | undefined
  /** Stops the test run when it never ends (e.g. waiting for an approval). */
  stopTestRun?: (agentId: string, runId: string) => Promise<void>
  diskFreeBytes: () => Promise<number | null>
  backupNeedsBytes: () => Promise<number | null>
  /**
   * Where a running update is recorded, so a Score restart while Hermes is still updating refuses a second update
   * (review: the update runs detached and outlives Score).
   */
  marker?: {
    read(): { pid: number; startedAt: string } | null
    write(value: { pid: number; startedAt: string }): void
    clear(): void
    alive(pid: number): boolean
  }
  sleep?: (ms: number) => Promise<void>
  /** Limits, overridable in tests. */
  limits?: Partial<typeof LIMITS>
}

const LIMITS = {
  waitMs: 30 * 60_000,
  waitPollMs: 5_000,
  updateMs: 45 * 60_000,
  checkTries: 9,
  checkPollMs: 10_000,
  testMs: 4 * 60_000,
  testPollMs: 3_000,
}
const MAX_LOG = 200
const TERMINAL = ['completed', 'failed', 'cancelled', 'interrupted']
export const TEST_MESSAGE =
  'Score is checking a Hermes update: reply with the single word PONG and nothing else.'

/** What `hermes update --check` printed: a channel tip ahead of the install, or nothing newer. */
export function parseCheck(lines: string[]): {
  available: boolean
  behind: number | null
  summary: string
} {
  const text = lines.map((line) => line.trim()).filter(Boolean)
  const behindLine = text.find((line) => /\b(\d[\d,]*)\s+commits?\s+behind\b/i.test(line))
  if (behindLine) {
    const behind = Number(
      behindLine.match(/\b(\d[\d,]*)\s+commits?\s+behind\b/i)![1]!.replace(/,/g, ''),
    )
    return { available: behind > 0, behind, summary: clean(behindLine) }
  }
  const newer = text.find((line) => /update available|newer release available/i.test(line))
  if (newer) return { available: true, behind: null, summary: clean(newer) }
  const answer =
    text.find((line) => /no newer|up to date|already/i.test(line)) ??
    text.at(-1) ??
    'No answer from Hermes.'
  return { available: false, behind: null, summary: clean(answer) }
}

/** The services `hermes update --plan` says it restarts ("gateway [default]"). */
export function parsePlan(lines: string[]): string[] {
  return lines
    .map((line) => line.trim())
    .filter((line) => /^[•*-]\s+\S/.test(line))
    .map((line) => clean(line.replace(/^[•*-]\s+/, '').replace(/\s+pid\s+\d+.*$/, '')))
    .filter(Boolean)
    .slice(0, 10)
}

function clean(line: string): string {
  // Hermes decorates its lines with symbols; the words are what the person reads.
  return redact(line.replace(/^[^\p{L}\p{N}]+/u, '').trim()).slice(0, 300)
}

export class HermesUpdates {
  #job: HermesUpdateJob | null = null
  #lastCheck: HermesUpdateCheck | null = null
  #checking: Promise<HermesUpdateCheck> | null = null
  readonly #limits: typeof LIMITS
  readonly #clock: () => number
  readonly #sleep: (ms: number) => Promise<void>

  constructor(private readonly deps: HermesUpdatesDeps) {
    this.#limits = { ...LIMITS, ...deps.limits }
    this.#clock = deps.clock ?? Date.now
    this.#sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()))
  }

  async status(): Promise<HermesUpdateStatus> {
    const [diskFreeBytes, backupNeedsBytes, version] = await Promise.all([
      this.deps.diskFreeBytes().catch(() => null),
      this.deps.backupNeedsBytes().catch(() => null),
      this.#version(),
    ])
    const orphan = this.#orphan()
    return {
      available: true,
      version,
      lastCheck: this.#lastCheck,
      job: this.#job ?? (orphan ? this.#orphanJob(orphan) : null),
      diskFreeBytes,
      backupNeedsBytes,
    }
  }

  /** Read-only: `hermes update --check` and `--plan` for the channel. One at a time. */
  async check(channel: HermesUpdateChannel): Promise<HermesUpdateCheck> {
    if (this.#job?.state === 'running' || this.#starting || this.#orphan())
      throw new HttpError(409, 'update_running', 'Hermes is being updated right now.')
    if (this.#checking) return this.#checking
    this.#checking = (async () => {
      const checked = await this.#runToEnd('check', channel, 120_000)
      // A check that didn't run (no `hermes`, a timeout, an error) never reads as "nothing newer" (review).
      if (checked.code !== 0)
        throw new HttpError(
          502,
          'hermes_unavailable',
          `Hermes couldn't check for updates (${checked.code === -2 ? 'it took too long' : `exit code ${checked.code}`}).`,
        )
      const planned = await this.#runToEnd('plan', channel, 120_000)
      const result: HermesUpdateCheck = {
        channel,
        ...parseCheck(checked.lines),
        restarts: parsePlan(planned.lines),
        checkedAt: new Date(this.#clock()).toISOString(),
      }
      this.#lastCheck = result
      return result
    })().finally(() => {
      this.#checking = null
    })
    return this.#checking
  }

  /** Starts the update job (the HTTP layer has checked the security password). */
  async start(req: {
    channel: HermesUpdateChannel
    testAgentId: string | null
  }): Promise<HermesUpdateJob> {
    // Claimed before the first await: two quick starts can never both pass the check.
    if (this.#job?.state === 'running' || this.#starting || this.#orphan())
      throw new HttpError(409, 'update_running', 'Hermes is already being updated.')
    if (this.#checking)
      throw new HttpError(
        409,
        'check_running',
        'Score is still checking for updates. Try again in a moment.',
      )
    this.#starting = true
    try {
      const [free, needs] = await Promise.all([
        this.deps.diskFreeBytes().catch(() => null),
        this.deps.backupNeedsBytes().catch(() => null),
      ])
      if (free !== null && needs !== null && free < needs)
        throw new HttpError(
          409,
          'disk_full',
          `Not enough disk space for Hermes's backup: about ${gb(needs)} needed, ${gb(free)} free.`,
        )
      return await this.#begin(req)
    } finally {
      this.#starting = false
    }
  }

  #starting = false

  /** An update recorded by an earlier Score process whose `hermes update` is still running. */
  #orphan(): { pid: number; startedAt: string } | null {
    const marker = this.deps.marker
    const recorded = marker?.read() ?? null
    if (!recorded || this.#job?.state === 'running') return null
    if (marker!.alive(recorded.pid)) return recorded
    marker!.clear()
    return null
  }

  #orphanJob(orphan: { pid: number; startedAt: string }): HermesUpdateJob {
    return {
      id: `earlier-${orphan.pid}`,
      state: 'running',
      channel: 'stable',
      testAgentId: null,
      startedAt: orphan.startedAt,
      endedAt: null,
      steps: [
        { id: 'wait', state: 'done', note: null },
        { id: 'update', state: 'running', note: 'started before Score restarted' },
        { id: 'check', state: 'pending', note: null },
        { id: 'test', state: 'skipped', note: null },
      ],
      fromVersion: null,
      toVersion: null,
      outcome: null,
      check: null,
      test: null,
      backup: null,
      error: null,
      log: [],
    }
  }

  async #begin(req: {
    channel: HermesUpdateChannel
    testAgentId: string | null
  }): Promise<HermesUpdateJob> {
    const job: HermesUpdateJob = {
      id: randomUUID(),
      state: 'running',
      channel: req.channel,
      testAgentId: req.testAgentId,
      startedAt: new Date(this.#clock()).toISOString(),
      endedAt: null,
      steps: [
        { id: 'wait', state: 'running', note: null },
        { id: 'update', state: 'pending', note: null },
        { id: 'check', state: 'pending', note: null },
        { id: 'test', state: req.testAgentId ? 'pending' : 'skipped', note: null },
      ],
      fromVersion: await this.#version(),
      toVersion: null,
      outcome: null,
      check: null,
      test: null,
      backup: null,
      error: null,
      log: [],
    }
    this.#job = job
    void this.#run(job).catch((error: unknown) => {
      this.#finish(
        job,
        'failed',
        error instanceof Error ? redact(error.message) : 'The update stopped.',
      )
    })
    return job
  }

  // Cached for a minute; dropped when a job ends so the new version shows at once.
  #versionCache: { at: number; value: Promise<string | null> } | null = null
  #version(): Promise<string | null> {
    const now = this.#clock()
    if (!this.#versionCache || now - this.#versionCache.at > 60_000)
      this.#versionCache = {
        at: now,
        value: this.deps
          .version()
          .then((value) => (value ? clean(value).replace(/^Hermes Agent\s+/i, '') : null))
          .catch(() => null),
      }
    return this.#versionCache.value
  }

  async #run(job: HermesUpdateJob): Promise<void> {
    // 1. No Score run in flight (Hermes's own updater also drains its gateway's turns).
    const waitUntil = this.#clock() + this.#limits.waitMs
    for (;;) {
      const state = this.deps.idle()
      if (state.idle) break
      this.#step(job, 'wait', 'running', state.note)
      if (this.#clock() >= waitUntil) {
        this.#step(job, 'wait', 'failed', state.note)
        return this.#finish(
          job,
          'failed',
          'Agents were still working after 30 minutes. Nothing was changed.',
        )
      }
      await this.#sleep(this.#limits.waitPollMs)
    }
    this.#step(job, 'wait', 'done', 'nothing running')

    // 2. Hermes backs itself up, updates and restarts its gateway.
    this.#step(job, 'update', 'running', null)
    const updated = await this.#runToEnd('run', job.channel, this.#limits.updateMs, (line) => {
      const kept = clean(line)
      if (!kept) return
      job.log = [...job.log, kept].slice(-MAX_LOG)
      const backup = line.match(/(hermes-backup-[^\s'"`]+\.zip)/)
      if (backup) job.backup = clean(backup[1]!)
      const done = line.match(/Update complete!.*\((.+?)\s*(?:→|->)\s*(.+?)\)/)
      if (done) {
        job.fromVersion = clean(done[1]!)
        job.toVersion = clean(done[2]!)
      }
    })
    if (updated.code !== 0) {
      this.#step(
        job,
        'update',
        'failed',
        updated.code === -2 ? 'timed out' : `exit ${updated.code}`,
      )
      return this.#finish(
        job,
        'failed',
        `Hermes's update did not finish (${updated.code === -2 ? 'it took over 45 minutes' : `exit code ${updated.code}`}). ` +
          'See its output below.',
      )
    }
    this.#step(job, 'update', 'done', job.toVersion ? `now ${job.toVersion}` : 'already up to date')

    // 3. Score's own check; the gateway may still be coming back, so a check that can't read it is tried again.
    this.#step(job, 'check', 'running', null)
    // A check that throws while the gateway restarts is tried again too (review).
    const attempt = () =>
      this.deps.check().then(
        (value) => ({ value, error: null as string | null }),
        (error: unknown) => ({
          value: null,
          error: error instanceof Error ? redact(error.message) : 'the check failed',
        }),
      )
    let checked = await attempt()
    for (
      let tries = 1;
      tries < this.#limits.checkTries && (checked.value === null || unreadable(checked.value));
      tries += 1
    ) {
      await this.#sleep(this.#limits.checkPollMs)
      checked = await attempt()
    }
    if (checked.value === null) {
      this.#step(job, 'check', 'failed', checked.error)
      return this.#finish(
        job,
        'broken',
        `Hermes was updated, but Score couldn't check it: ${checked.error}`,
      )
    }
    const check = checked.value
    job.check = check
    const differing = check.parts.filter((part) => part.status !== 'same').length
    this.#step(
      job,
      'check',
      check.compatible ? 'done' : 'failed',
      check.compatible ? 'nothing Score relies on changed' : `${differing} parts differ`,
    )

    // 4. One short test message through the new Hermes.
    let testOk = true
    if (job.testAgentId) {
      this.#step(job, 'test', 'running', null)
      job.test = await this.#test(job.testAgentId)
      testOk = job.test.ok
      this.#step(job, 'test', testOk ? 'done' : 'failed', job.test.detail)
    }

    if (check.compatible && testOk) {
      await this.deps.accept(check.hash)
      return this.#finish(job, 'clear', null)
    }
    return this.#finish(job, testOk && check.overridable ? 'differs' : 'broken', null)
  }

  async #test(agentId: string): Promise<{ agentId: string; ok: boolean; detail: string }> {
    let runId: string
    try {
      runId = (await this.deps.startTestRun(agentId, TEST_MESSAGE)).runId
    } catch (error) {
      return {
        agentId,
        ok: false,
        detail: `Couldn't start: ${error instanceof Error ? redact(error.message).slice(0, 200) : 'unknown error'}`,
      }
    }
    const until = this.#clock() + this.#limits.testMs
    for (;;) {
      const run = this.deps.readRun(runId)
      if (run && TERMINAL.includes(run.status)) {
        if (run.status === 'completed')
          return {
            agentId,
            ok: true,
            detail: `answered: ${clean(run.output ?? '').slice(0, 80) || '(empty)'}`,
          }
        return {
          agentId,
          ok: false,
          detail: clean(run.error ?? run.status).slice(0, 200) || run.status,
        }
      }
      if (this.#clock() >= until) {
        // A run that never ends (waiting for an approval) is stopped, not left behind (review).
        await this.deps.stopTestRun?.(agentId, runId).catch(() => undefined)
        return { agentId, ok: false, detail: 'no answer within 4 minutes' }
      }
      await this.#sleep(this.#limits.testPollMs)
    }
  }

  #runToEnd(
    command: HermesUpdateCommand,
    channel: HermesUpdateChannel,
    timeoutMs: number,
    onLine?: (line: string) => void,
  ): Promise<{ code: number; lines: string[] }> {
    const lines: string[] = []
    const child = this.deps.spawn(command, channel, {
      hermesHome: this.deps.hermesHome,
      onLine: (line) => {
        if (lines.length < 2000) lines.push(line)
        onLine?.(line)
      },
    })
    if (command === 'run' && child.pid !== undefined)
      this.deps.marker?.write({ pid: child.pid, startedAt: new Date(this.#clock()).toISOString() })
    let timer: NodeJS.Timeout | undefined
    let timedOutFlag = false
    const timedOut = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOutFlag = true
        child.kill()
        resolve()
      }, timeoutMs)
      timer.unref?.()
    })
    // After a timeout the job still waits for the process to be gone (the kill escalates), so nothing overlaps it.
    return Promise.race([child.exited, timedOut])
      .then(() => child.exited)
      .then((code) => {
        clearTimeout(timer)
        if (command === 'run') this.deps.marker?.clear()
        return { code: timedOutFlag ? -2 : code, lines }
      })
  }

  #step(
    job: HermesUpdateJob,
    id: HermesUpdateJob['steps'][number]['id'],
    state: HermesUpdateJob['steps'][number]['state'],
    note: string | null,
  ): void {
    job.steps = job.steps.map((step) => (step.id === id ? { ...step, state, note } : step))
  }

  #finish(
    job: HermesUpdateJob,
    outcome: NonNullable<HermesUpdateJob['outcome']>,
    error: string | null,
  ): void {
    this.#versionCache = null
    job.state = 'finished'
    job.outcome = outcome
    job.error = error
    job.endedAt = new Date(this.#clock()).toISOString()
    // Steps never reached stay pending; one still running when the job ends has failed.
    job.steps = job.steps.map((step) =>
      step.state === 'running' ? { ...step, state: 'failed' } : step,
    )
  }
}

function unreadable(check: HermesCheck): boolean {
  return check.parts.some((part) => /could not be read/i.test(part.detail))
}

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}
