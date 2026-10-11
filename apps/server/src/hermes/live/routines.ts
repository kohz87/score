import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { RoutineSummarySchema, type RoutineSummary } from '@score/contract'
import type { ScoreDb } from '../../db/index.ts'
import { HttpError } from '../../errors.ts'
import { redactBounded } from '../../redact.ts'
import { CreateRoutineSchema, PatchRoutineSchema } from '../port.ts'
import { runHermes, type HermesRunner } from './cli.ts'
import { ProfileNameSchema, resolveHermesHome } from './paths.ts'

// Hermes keeps each profile's cron jobs in <profile home>/cron/jobs.json (cron/jobs.py). The gateway's
// /api/jobs needs a served profile plus its key; the file works for every profile and never needs a
// credential, so reads open it read-only. Writes go through `hermes cron …` only.
const MAX_JOBS_BYTES = 8 * 1024 * 1024
const JobIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
// Hermes job ids are unique per profile, so Score's id carries the profile it belongs to.
export const RoutineIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}:[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
const JobSchema = z
  .object({
    id: JobIdSchema,
    name: z.string().nullish(),
    prompt: z.string().nullish(),
    schedule_display: z.string().nullish(),
    schedule: z.unknown().optional(),
    enabled: z.boolean().optional(),
    last_run_at: z.string().nullish(),
  })
  .passthrough()
const JobsFileSchema = z.union([z.object({ jobs: z.array(z.unknown()) }), z.array(z.unknown())])
type Job = z.infer<typeof JobSchema>

function directory(path: string): boolean {
  try {
    return fs.lstatSync(path).isDirectory()
  } catch {
    return false
  }
}
export function profileHome(hermesHome: string, profile: string): string | null {
  if (!directory(hermesHome)) return null
  if (profile === 'default') return hermesHome
  const parent = join(hermesHome, 'profiles')
  const path = join(parent, ProfileNameSchema.parse(profile))
  return directory(parent) && directory(path) ? path : null
}
function readJobs(home: string): Job[] {
  const path = join(home, 'cron', 'jobs.json')
  let text: string
  try {
    const stat = fs.lstatSync(path)
    if (!stat.isFile() || stat.size > MAX_JOBS_BYTES) throw new Error('unreadable jobs file')
    const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      const buffer = Buffer.alloc(stat.size + 1)
      const length = fs.readSync(fd, buffer, 0, buffer.length, 0)
      if (length > stat.size) throw new Error('unreadable jobs file')
      text = buffer.subarray(0, length).toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new HttpError(502, 'hermes_unavailable', 'Couldn’t read the routines from Hermes.')
  }
  try {
    const parsed = JobsFileSchema.parse(
      JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text),
    )
    const entries = Array.isArray(parsed) ? parsed : parsed.jobs
    return entries.flatMap((entry) => {
      const job = JobSchema.safeParse(entry)
      return job.success ? [job.data] : []
    })
  } catch {
    throw new HttpError(502, 'hermes_unavailable', 'Couldn’t read the routines from Hermes.')
  }
}
function scheduleText(job: Job): string {
  if (job.schedule_display) return job.schedule_display
  const nested = z
    .object({ display: z.string().optional(), expr: z.string().optional() })
    .safeParse(job.schedule)
  return nested.success ? (nested.data.display ?? nested.data.expr ?? '') : ''
}
function summary(profile: string, job: Job): RoutineSummary {
  const last = job.last_run_at ? new Date(job.last_run_at) : null
  const prompt = job.prompt ?? ''
  return RoutineSummarySchema.parse({
    id: `${profile}:${job.id}`,
    title: redactBounded(job.name?.trim() || prompt.trim().slice(0, 50) || 'Routine', 400),
    schedule: redactBounded(scheduleText(job), 200),
    description: redactBounded(prompt, 600),
    lastRunAt: last && !Number.isNaN(last.getTime()) ? last.toISOString() : null,
    enabled: job.enabled !== false,
  })
}

/** Used by the profile reader; never throws so a broken jobs file cannot hide the agent. */
export function readRoutines(hermesHome: string, profile: string): RoutineSummary[] {
  try {
    const home = profileHome(hermesHome, profile)
    return home ? readJobs(home).map((job) => summary(profile, job)) : []
  } catch {
    return []
  }
}

export function splitRoutineId(id: string): { profile: string; jobId: string } {
  const parsed = RoutineIdSchema.safeParse(id)
  if (!parsed.success) throw new HttpError(404, 'not_found', 'Couldn’t find that routine.')
  const [profile, jobId] = parsed.data.split(':') as [string, string]
  return { profile, jobId }
}

const IntentRowSchema = z.object({
  state: z.string(),
  result: z.string().nullable(),
  payload: z.string(),
})
const IntentPayloadSchema = z.object({ requestHash: z.string(), before: z.array(z.string()) })

export class LiveRoutines {
  private tail: Promise<unknown> = Promise.resolve()
  private readonly hermesHome: string
  constructor(
    hermesHome: string | undefined,
    private readonly runner: HermesRunner = runHermes,
  ) {
    this.hermesHome = resolveHermesHome(hermesHome)
  }

  // Creates diff the job list before and after, so they never overlap inside this process.
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work)
    this.tail = result.catch(() => undefined)
    return result
  }
  private home(profile: string): string {
    const home = profileHome(this.hermesHome, profile)
    if (!home) throw new HttpError(404, 'not_found', 'Couldn’t find that agent.')
    return home
  }
  private jobs(profile: string): Job[] {
    return readJobs(this.home(profile))
  }
  private find(id: string): { profile: string; job: Job } {
    const { profile, jobId } = splitRoutineId(id)
    const job = this.jobs(profile).find((candidate) => candidate.id === jobId)
    if (!job) throw new HttpError(404, 'not_found', 'Couldn’t find that routine.')
    return { profile, job }
  }
  private async cron(profile: string, args: string[]): Promise<number> {
    const result = await this.runner(['-p', profile, 'cron', ...args], {
      timeoutMs: 15000,
      hermesHome: this.hermesHome,
    }).catch(() => ({ exitCode: -1 }))
    return result.exitCode
  }
  private async mutate(profile: string, args: string[]): Promise<void> {
    const exitCode = await this.cron(profile, args)
    if (exitCode !== 0)
      throw new HttpError(
        exitCode < 0 ? 502 : 409,
        exitCode < 0 ? 'hermes_unavailable' : 'conflict',
        'Hermes didn’t accept the routine change.',
      )
  }

  list(agentId: string): RoutineSummary[] {
    const profile = ProfileNameSchema.safeParse(agentId)
    if (!profile.success) throw new HttpError(404, 'not_found', 'Couldn’t find that agent.')
    return this.jobs(profile.data).map((job) => summary(profile.data, job))
  }

  create(
    agentId: string,
    input: z.infer<typeof CreateRoutineSchema>,
    key: string,
    db: ScoreDb,
  ): Promise<RoutineSummary> {
    const req = CreateRoutineSchema.parse(input)
    z.string()
      .regex(/^[\x21-\x7e]{1,256}$/)
      .parse(key)
    const profile = ProfileNameSchema.safeParse(agentId)
    if (!profile.success) throw new HttpError(404, 'not_found', 'Couldn’t find that agent.')
    return this.serial(() => this.createLocked(profile.data, req, key, db))
  }
  private async createLocked(
    profile: string,
    req: z.infer<typeof CreateRoutineSchema>,
    key: string,
    db: ScoreDb,
  ): Promise<RoutineSummary> {
    const before = this.jobs(profile).map((job) => job.id)
    // Hermes has no idempotency key for cron create, so Score records the intent and, on a retry,
    // looks for the job the earlier attempt may already have made (same name and prompt, id not seen before).
    const args = ['create', `--name=${req.title}`, '--', req.schedule, req.prompt]
    const requestHash = createHash('sha256')
      .update(JSON.stringify([profile, args]))
      .digest('hex')
    const intentId = `routine-create:${profile}:${key}`
    const fresh = (job: Job, known: readonly string[]) =>
      !known.includes(job.id) && job.name === req.title && (job.prompt ?? '') === req.prompt
    const accept = (jobId: string) => {
      db.tx((sqlite) =>
        sqlite
          .prepare(
            "UPDATE command_intents SET state = 'accepted', result = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?",
          )
          .run(jobId, new Date().toISOString(), intentId),
      )
    }
    const row = db.sqlite
      .prepare('SELECT state, result, payload FROM command_intents WHERE id = ?')
      .get(intentId)
    if (row) {
      const intent = IntentRowSchema.parse(row)
      const payload = IntentPayloadSchema.parse(JSON.parse(intent.payload))
      if (payload.requestHash !== requestHash)
        throw new HttpError(
          409,
          'idempotency_conflict',
          'That request was already used for a different routine.',
        )
      if (intent.state === 'accepted' && intent.result) {
        const job = this.jobs(profile).find((candidate) => candidate.id === intent.result)
        if (!job)
          throw new HttpError(
            409,
            'conflict',
            'The routine created by that request has since been removed.',
          )
        return summary(profile, job)
      }
      if (intent.state === 'failed')
        throw new HttpError(409, 'conflict', 'Hermes rejected this routine earlier.')
      const existing = this.jobs(profile).find((job) => fresh(job, payload.before))
      if (existing) {
        accept(existing.id)
        return summary(profile, existing)
      }
      db.tx((sqlite) =>
        sqlite
          .prepare(
            "UPDATE command_intents SET payload = ?, state = 'pending', updated_at = ? WHERE id = ?",
          )
          .run(JSON.stringify({ requestHash, before }), new Date().toISOString(), intentId),
      )
    } else {
      const now = new Date().toISOString()
      db.tx((sqlite) =>
        sqlite
          .prepare(
            `INSERT INTO command_intents (id, kind, idempotency_key, payload, state, created_at, updated_at)
             VALUES (?, 'routine-create', ?, ?, 'pending', ?, ?)`,
          )
          .run(intentId, intentId, JSON.stringify({ requestHash, before }), now, now),
      )
    }
    const exitCode = await this.cron(profile, args)
    const created =
      exitCode === 0 ? this.jobs(profile).find((job) => fresh(job, before)) : undefined
    if (created) {
      accept(created.id)
      return summary(profile, created)
    }
    db.tx((sqlite) =>
      sqlite
        .prepare(
          'UPDATE command_intents SET state = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?',
        )
        .run(exitCode > 0 ? 'failed' : 'unknown', new Date().toISOString(), intentId),
    )
    if (exitCode > 0)
      throw new HttpError(409, 'conflict', 'Hermes didn’t accept the routine change.')
    throw new HttpError(
      502,
      'hermes_unavailable',
      exitCode === 0
        ? 'Couldn’t confirm that Hermes created the routine.'
        : 'Hermes isn’t reachable. Try again in a moment.',
    )
  }

  async patch(id: string, input: z.infer<typeof PatchRoutineSchema>): Promise<RoutineSummary> {
    const req = PatchRoutineSchema.parse(input)
    const { profile, job } = this.find(id)
    // Separate upstream verbs: everything is validated and looked up before the first mutation.
    if (req.schedule !== undefined || req.prompt !== undefined)
      await this.mutate(profile, [
        'edit',
        ...(req.schedule !== undefined ? [`--schedule=${req.schedule}`] : []),
        ...(req.prompt !== undefined ? [`--prompt=${req.prompt}`] : []),
        '--',
        job.id,
      ])
    if (req.enabled !== undefined && req.enabled !== (job.enabled !== false))
      await this.mutate(profile, [req.enabled ? 'resume' : 'pause', '--', job.id])
    return summary(profile, this.find(id).job)
  }
  async remove(id: string): Promise<void> {
    const { profile, job } = this.find(id)
    await this.mutate(profile, ['remove', '--', job.id])
  }
  async run(id: string): Promise<void> {
    const { profile, job } = this.find(id)
    await this.mutate(profile, ['run', '--', job.id])
  }
}
