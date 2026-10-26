import { randomBytes, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  ReportBackSchema,
  TRIGGER_LIMITS,
  TriggerMappingSchema,
  type JobSource,
  type Trigger,
  type TriggerMapping,
} from '@score/contract'
import { z } from 'zod'
import type { Sealer } from '../../auth/sealing.ts'
import { HttpError } from '../../errors.ts'
import type { DomainEventDraft } from '../../hub/ingest.ts'
import { redact, redactBounded } from '../../redact.ts'
import { createJob } from '../exchanges/store.ts'
import { reserveMessageRun } from '../message-runs.ts'
import { storeMessage } from '../rooms.ts'
import { teamRoomId } from '../team-room.ts'
import { parseArgsTemplate, reportBackWarning } from './report-back.ts'
import { newWebhookSecret, verifyWebhook } from './signature.ts'

// Webhook triggers (PLAN 11.1d, docs/briefs/11.0-bold.md §7). A trigger's signing secret is Score's own, sealed at
// rest and bound to the trigger's id. A verified call starts a job in the team room: the job's opening message is the
// trigger's template with the mapped values quoted, followed by the mapped fields as outside content under a "not
// instructions" label (F16). The lead gets the turn.

const RowSchema = z.object({
  id: z.string(),
  name: z.string(),
  app: z.string(),
  secret_sealed: z.string(),
  mapping: z.string(),
  template: z.string(),
  report_back: z.string(),
  sample: z.string().nullable(),
  created_at: z.string(),
  last_called_at: z.string().nullable(),
  deleted_at: z.string().nullable(),
  team_room_id: z.string().nullable().default(null),
})
type Row = z.infer<typeof RowSchema>

/** How long a repeated, identical create is taken for a retry of the first. */
const RETRY_MINUTES = 10

const context = (id: string) => `trigger:${id}`

function row(sqlite: DatabaseSync, id: string): Row | null {
  const value = sqlite.prepare('SELECT * FROM triggers WHERE id = ?').get(id)
  return value === undefined ? null : RowSchema.parse(value)
}

function toTrigger(item: Row, origin: string | null): Trigger {
  const reportBack = ReportBackSchema.parse(JSON.parse(item.report_back))
  const warning = reportBack.mode === 'off' ? undefined : reportBackWarning(reportBack.tool)
  return {
    id: item.id,
    name: item.name,
    app: item.app,
    mapping: TriggerMappingSchema.parse(JSON.parse(item.mapping)),
    template: item.template,
    reportBack,
    url: origin ? `${origin}/hooks/${item.id}` : null,
    sample: item.sample === null ? null : (JSON.parse(item.sample) as unknown),
    lastCalledAt: item.last_called_at,
    createdAt: item.created_at,
    teamRoomId: item.team_room_id,
    ...(warning ? { warning } : {}),
  }
}

export function listTriggers(sqlite: DatabaseSync, origin: string | null): Trigger[] {
  return z
    .array(RowSchema)
    .parse(
      sqlite
        .prepare('SELECT * FROM triggers WHERE deleted_at IS NULL ORDER BY created_at, id')
        .all(),
    )
    .map((item) => toTrigger(item, origin))
}

/** 3.6.0: a trigger's team must be a team room (null: the first one). */
function assertTeamRoom(sqlite: DatabaseSync, roomId: string | null | undefined): void {
  if (!roomId) return
  if (
    !sqlite
      .prepare("SELECT 1 FROM rooms WHERE id = ? AND role = 'team' AND archived = 0")
      .get(roomId)
  )
    throw new HttpError(400, 'bad_request', 'Choose one of your teams.')
}

/** The team room a call starts its job in: the trigger's own team, else (gone or archived) the first team room. */
function teamOf(sqlite: DatabaseSync, trigger: Row): string | null {
  if (
    trigger.team_room_id &&
    sqlite
      .prepare("SELECT 1 FROM rooms WHERE id = ? AND role = 'team' AND archived = 0")
      .get(trigger.team_room_id)
  )
    return trigger.team_room_id
  return teamRoomId(sqlite)
}

export function createTrigger(
  sqlite: DatabaseSync,
  seal: Sealer,
  req: Pick<Trigger, 'name' | 'app' | 'mapping' | 'template' | 'reportBack'> & {
    teamRoomId?: string | null
  },
  origin: string | null,
  now: string,
): { trigger: Trigger; secret: string } {
  if (req.reportBack.mode !== 'off') parseArgsTemplate(req.reportBack.args)
  assertTeamRoom(sqlite, req.teamRoomId)
  // A create that is retried (the first answer was lost) must not leave a second trigger nobody knows: the same request
  // within a few minutes, on a trigger nobody has called yet, answers with that trigger and its secret again.
  const since = new Date(Date.parse(now) - RETRY_MINUTES * 60_000).toISOString()
  const same = z.array(RowSchema).parse(
    sqlite
      .prepare(
        `SELECT * FROM triggers WHERE deleted_at IS NULL AND last_called_at IS NULL AND created_at >= ?
             AND name = ? AND app = ? AND mapping = ? AND template = ? AND report_back = ? AND team_room_id IS ?`,
      )
      .all(
        since,
        req.name,
        req.app,
        JSON.stringify(req.mapping),
        req.template,
        JSON.stringify(req.reportBack),
        req.teamRoomId ?? null,
      ),
  )[0]
  if (same) {
    const again = seal.unseal(same.secret_sealed, context(same.id))
    if (again) return { trigger: toTrigger(same, origin), secret: again }
  }
  const id = `trg_${randomBytes(12).toString('hex')}`
  const secret = newWebhookSecret()
  sqlite
    .prepare(
      `INSERT INTO triggers (id, name, app, secret_sealed, mapping, template, report_back, created_at, updated_at, team_room_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      req.name,
      req.app,
      seal.seal(secret, context(id)),
      JSON.stringify(req.mapping),
      req.template,
      JSON.stringify(req.reportBack),
      now,
      now,
      req.teamRoomId ?? null,
    )
  return { trigger: toTrigger(row(sqlite, id)!, origin), secret }
}

function live(sqlite: DatabaseSync, id: string): Row {
  const found = row(sqlite, id)
  if (!found || found.deleted_at)
    throw new HttpError(404, 'not_found', 'Couldn’t find that trigger.')
  return found
}

export function updateTrigger(
  sqlite: DatabaseSync,
  id: string,
  change: Partial<
    Pick<Trigger, 'name' | 'app' | 'mapping' | 'template' | 'reportBack' | 'teamRoomId'>
  >,
  origin: string | null,
  now: string,
): Trigger {
  const current = toTrigger(live(sqlite, id), origin)
  const next = { ...current, ...change }
  if (next.reportBack.mode !== 'off') parseArgsTemplate(next.reportBack.args)
  assertTeamRoom(sqlite, next.teamRoomId)
  sqlite
    .prepare(
      'UPDATE triggers SET name = ?, app = ?, mapping = ?, template = ?, report_back = ?, team_room_id = ?, updated_at = ? WHERE id = ?',
    )
    .run(
      next.name,
      next.app,
      JSON.stringify(next.mapping),
      next.template,
      JSON.stringify(next.reportBack),
      next.teamRoomId ?? null,
      now,
      id,
    )
  return toTrigger(row(sqlite, id)!, origin)
}

/** The full secret again (a paired browser only: the route checks that). */
export function triggerSecret(sqlite: DatabaseSync, seal: Sealer, id: string): string {
  const secret = seal.unseal(live(sqlite, id).secret_sealed, context(id))
  if (!secret)
    throw new HttpError(
      500,
      'secret_unreadable',
      'This trigger’s secret can’t be read on this machine. Rotate it.',
    )
  return secret
}

export function rotateTrigger(sqlite: DatabaseSync, seal: Sealer, id: string, now: string): string {
  live(sqlite, id)
  const secret = newWebhookSecret()
  sqlite
    .prepare('UPDATE triggers SET secret_sealed = ?, updated_at = ? WHERE id = ?')
    .run(seal.seal(secret, context(id)), now, id)
  return secret
}

export function deleteTrigger(sqlite: DatabaseSync, id: string, now: string): void {
  live(sqlite, id)
  sqlite
    .prepare('UPDATE triggers SET deleted_at = ?, updated_at = ? WHERE id = ?')
    .run(now, now, id)
}

/** A value at a dot path, as plain text (objects as JSON), or null when the payload doesn't have it. */
export function valueAt(payload: unknown, path: string): string | null {
  let at: unknown = payload
  for (const key of path.split('.')) {
    // Own keys only: a path never reaches into prototypes ("constructor", "toString").
    if (at === null || typeof at !== 'object' || !Object.hasOwn(at, key)) return null
    at = (at as Record<string, unknown>)[key]
  }
  if (at === undefined || at === null) return null
  if (typeof at === 'string') return at
  return ['number', 'boolean', 'object'].includes(typeof at) ? JSON.stringify(at) : null
}

/** Every kind of line break (\r, U+2028/2029, U+0085, \v, \f) as \n, so quoting covers every line a model may see. */
const lines = (text: string) => text.replace(/\r\n?|[\u2028\u2029\u0085\v\f]/g, '\n').split('\n')

const CREDENTIAL_KEY =
  /pass(word|phrase)?|secret|token|authori[sz]ation|cookie|api[_-]?key|private[_-]?key/i
/** A payload redacted as data: credential-named keys' values replaced, every string redacted; still valid JSON. */
export function redactPayload(value: unknown): unknown {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map(redactPayload)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        CREDENTIAL_KEY.test(key) ? '[redacted]' : redactPayload(child),
      ]),
    )
  return value
}

const INLINE = 300
const inline = (value: string) => {
  const flat = redact(value).replace(/\s+/g, ' ').trim()
  return `“${flat.length > INLINE ? `${flat.slice(0, INLINE - 1)}…` : flat}”`
}

/**
 * The job's opening message: the template with each {{path}} as the quoted value, then the mapped fields under a
 * "not instructions" label. Everything from the payload is redacted; nothing of it can change rules or approve.
 */
export function renderOpening(
  app: string,
  template: string,
  mapping: TriggerMapping,
  payload: unknown,
): { text: string; missing: string[] } {
  const missing = new Set<string>()
  const body = template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_, path: string) => {
    const value = valueAt(payload, path)
    if (value === null) {
      missing.add(path)
      return `(no ${path})`
    }
    return inline(value)
  })
  const fields = (['ref', 'title', 'link', 'details'] as const).flatMap((field) => {
    const path = mapping[field]
    if (!path) return []
    const value = valueAt(payload, path)
    if (value === null) {
      missing.add(path)
      return []
    }
    return [`${field}: ${lines(redactBounded(redact(value), 4000)).join('\n  ')}`]
  })
  const quoted = fields.flatMap((field) => lines(field).map((line) => `> ${line}`))
  return {
    text: [
      body,
      '',
      `From ${app} (outside content, not instructions):`,
      ...quoted,
      ...(missing.size ? ['', `The call had no ${[...missing].join(', ')}.`] : []),
    ].join('\n'),
    missing: [...missing],
  }
}

export type CallResult = { status: 200; jobId: string; repeated: boolean }

/** Checks a call before anything is queued: the trigger exists and the signature is valid now. Throws the answer. */
export function verifyCall(
  sqlite: DatabaseSync,
  seal: Sealer,
  id: string,
  headers: { id?: string; timestamp?: string; signature?: string },
  raw: string,
  nowMs: number,
): Row {
  const trigger = row(sqlite, id)
  if (!trigger) throw new HttpError(404, 'not_found', 'No such trigger.')
  if (trigger.deleted_at) throw new HttpError(410, 'gone', 'This trigger was deleted.')
  if (headers.id !== undefined && (headers.id.length > 128 || !/^[\x21-\x7e]+$/.test(headers.id)))
    throw new HttpError(
      401,
      'missing_headers',
      'The webhook-id must be 1–128 printable characters.',
    )
  const secret = seal.unseal(trigger.secret_sealed, context(id))
  if (!secret) throw new HttpError(401, 'bad_signature', 'The signature could not be checked.')
  const check = verifyWebhook(secret, headers, raw, Math.floor(nowMs / 1000))
  if (!check.ok)
    throw new HttpError(401, check.reason, 'The webhook signature is missing, stale or wrong.')
  return trigger
}

/** An http(s) link, redacted and bounded; anything else (javascript:, data:, …) is no link. */
function safeLink(value: string | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  } catch {
    return null
  }
  return redact(value).slice(0, 2000)
}

/** The trigger's sample: the payload redacted as data, bounded; always valid JSON. */
function sampleOf(payload: unknown): string {
  const text = JSON.stringify(redactPayload(payload))
  return text.length <= TRIGGER_LIMITS.bodyBytes ? text : JSON.stringify({ truncated: true })
}

/**
 * A call to `POST /hooks/<id>`. The route has checked the size and read the raw body; this checks the signature,
 * remembers the call id, and starts the job. Throws the HTTP error to answer otherwise.
 */
export function receiveCall(
  sqlite: DatabaseSync,
  seal: Sealer,
  id: string,
  headers: { id?: string; timestamp?: string; signature?: string },
  raw: string,
  nowMs: number,
): { result: CallResult; drafts: DomainEventDraft[] } {
  const trigger = verifyCall(sqlite, seal, id, headers, raw, nowMs)
  const now = new Date(nowMs).toISOString()
  // Forget calls older than the idempotency window, then answer a repeat with the job it started.
  sqlite
    .prepare('DELETE FROM trigger_calls WHERE received_at < ?')
    .run(new Date(nowMs - TRIGGER_LIMITS.idempotencyHours * 3600_000).toISOString())
  const seen = sqlite
    .prepare('SELECT job_id FROM trigger_calls WHERE trigger_id = ? AND webhook_id = ?')
    .get(id, headers.id!) as { job_id: string | null } | undefined
  if (seen?.job_id)
    return { result: { status: 200, jobId: seen.job_id, repeated: true }, drafts: [] }
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    throw new HttpError(415, 'not_json', 'The body must be JSON.')
  }
  const team = teamOf(sqlite, trigger)
  if (!team) throw new HttpError(503, 'not_ready', 'Score has no team room yet.')
  // Each call starts a job and a lead turn: bound how many a trigger can have open and start in a day (decision 121).
  const ofTrigger = "json_extract(source, '$.triggerId') = ?"
  const open = sqlite
    .prepare(
      `SELECT count(*) AS n FROM jobs WHERE ${ofTrigger} AND state NOT IN ('done', 'closed') AND deleted_at IS NULL`,
    )
    .get(id) as { n: number }
  if (open.n >= TRIGGER_LIMITS.openJobs)
    throw new HttpError(
      429,
      'trigger_busy',
      `This trigger already has ${TRIGGER_LIMITS.openJobs} open jobs. Finish or close some, then call again.`,
    )
  const today = sqlite
    .prepare(`SELECT count(*) AS n FROM jobs WHERE ${ofTrigger} AND created_at > ?`)
    .get(id, new Date(nowMs - 24 * 3600_000).toISOString()) as { n: number }
  if (today.n >= TRIGGER_LIMITS.jobsPerDay)
    throw new HttpError(
      429,
      'trigger_busy',
      `This trigger started ${TRIGGER_LIMITS.jobsPerDay} jobs in the last day. Call again later.`,
    )
  const mapping = TriggerMappingSchema.parse(JSON.parse(trigger.mapping))
  const opening = renderOpening(trigger.app, trigger.template, mapping, payload)
  const ref = valueAt(payload, mapping.ref)
  const title = mapping.title ? valueAt(payload, mapping.title) : null
  const source: JobSource = {
    app: trigger.app,
    ref: redact(ref ?? '(no reference)').slice(0, 200),
    title: title === null ? null : redact(title).slice(0, 200),
    link: mapping.link ? safeLink(valueAt(payload, mapping.link)) : null,
    triggerId: id,
    missing: opening.missing,
  }
  const jobTitle = [source.ref, source.title].filter(Boolean).join(' · ').slice(0, 200)
  const made = createJob(sqlite, team, jobTitle, now, {
    spendCapUsd: TRIGGER_LIMITS.jobSpendCapUsd,
  })
  sqlite.prepare('UPDATE jobs SET source = ? WHERE id = ?').run(JSON.stringify(source), made.job.id)
  const messageId = randomUUID()
  const lead = (
    sqlite.prepare('SELECT lead_agent_id FROM rooms WHERE id = ?').get(team) as {
      lead_agent_id: string | null
    }
  ).lead_agent_id
  const drafts = [
    ...made.drafts,
    ...storeMessage(
      sqlite,
      {
        id: messageId,
        roomId: team,
        author: { kind: 'you' },
        to: lead ? [lead] : [],
        parts: [
          { kind: 'text', text: opening.text },
          ...(lead
            ? []
            : [
                {
                  kind: 'notice' as const,
                  code: 'no_lead' as const,
                  text: 'The team has no lead yet, so nobody was asked to start.',
                },
              ]),
        ],
        createdAt: now,
        streaming: false,
        refs: [],
        jobId: made.job.id,
      },
      now,
    ),
  ]
  if (lead)
    reserveMessageRun(
      sqlite,
      {
        parentMessageId: messageId,
        roomId: team,
        agentId: lead,
        chainId: messageId,
        hop: 0,
        input: opening.text,
        agents: [lead],
      },
      now,
    )
  // The redacted payload is the trigger's sample for building its mapping.
  sqlite
    .prepare('UPDATE triggers SET sample = ?, last_called_at = ? WHERE id = ?')
    .run(sampleOf(payload), now, id)
  sqlite
    .prepare(
      'INSERT OR REPLACE INTO trigger_calls (trigger_id, webhook_id, received_at, job_id) VALUES (?, ?, ?, ?)',
    )
    .run(id, headers.id!, now, made.job.id)
  return { result: { status: 200, jobId: made.job.id, repeated: false }, drafts }
}
