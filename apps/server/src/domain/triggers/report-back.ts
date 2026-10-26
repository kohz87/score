import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  JobSourceSchema,
  ReportBackSchema,
  type JobReportBack,
  type ReportBack,
} from '@score/contract'
import { z } from 'zod'
import { HttpError } from '../../errors.ts'
import { redact } from '../../redact.ts'
import { sessionFor } from '../job-sessions.ts'
import { reserveMessageRun } from '../message-runs.ts'
import { roomMembers } from '../exchanges/actions.ts'
import { latestMessage } from '../exchanges/store.ts'

// Report-back (PLAN 11.1d, docs/briefs/11.0-bold.md §7, F8). Score never holds the app's credential: the app's tool is
// one of the lead's Hermes tools. Score renders the exact arguments, asks the lead in a constrained turn to call exactly
// that tool with exactly them, and calls it reported back only when the bridge's record of that turn's session has the
// tool with the same argument digest and success. Anything else is "not confirmed" with Try again.

const StoredSchema = z.object({
  state: z.literal('sending'),
  tool: z.string(),
  digest: z.string(),
  turnId: z.string(),
  at: z.string(),
})

// Whole words of the tool name (snake_case, kebab-case, dotted or camelCase), so `dataset_info` holds no "set".
const list = (words: string) => new Set(words.split(' '))
const REPORTING = list(
  'comment comments report reply post note notes message messages notify notification status respond send review feedback reaction',
)
// Words that change things whatever else the name says.
const CHANGING = list(
  'delete remove close merge assign transition drop destroy archive write exec execute run pay payment money transfer charge refund buy order deploy publish release edit move rename approve reject invite grant revoke kick ban',
)
// Verbs that only make the reporting thing itself when their phrase ends in one (`create_comment`, `add_review`); with
// anything else (`create_issue`, `update_issue_status`, `create_issue_with_comment`) they may change things. A status is
// not one of those things: updating it changes state.
const SOFT = list('create add update set submit leave')
const MADE_TO_REPORT = list(
  'comment comments note notes message messages reply replies report reports review reviews feedback reaction reactions',
)
const PHRASE_END = list('and then with on in for')
// Every other word must be one of these places a report goes (3.5.0 review): an allowlist, since no list of risky
// words is ever complete (`send_funds`, `post_tweet`, `reply_all` warn).
const PLACES = list(
  'issue issues pull pulls request requests pr prs ticket tickets thread threads channel channels chat room conversation discussion task card job result results back progress to the a slack github gitlab linear jira discord telegram teams mcp score',
)
const ALLOWED = new Set([...REPORTING, ...MADE_TO_REPORT, ...SOFT, ...PHRASE_END, ...PLACES])

function words(tool: string): string[] {
  return tool
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/**
 * A warning when a report-back tool's name doesn't look like a reporting tool (any name is still accepted). A name check
 * only: no warning doesn't prove a tool is harmless.
 */
export function reportBackWarning(tool: string): string | undefined {
  const parts = words(tool)
  if (parts.length === 0 || parts.some((word) => !ALLOWED.has(word)))
    return 'This tool may change things, not just report.'
  const reports = parts.some((word) => REPORTING.has(word))
  // A soft verb is excused only when its own phrase (the words after it, up to and/then/with/on/in/for or the end)
  // ends in a reporting thing: `create_issue_comment` yes, `post_message_and_create_issue` no.
  const phraseEnd = (from: number) => {
    const end = parts.findIndex((word, i) => i > from && PHRASE_END.has(word))
    return parts.slice(from + 1, end === -1 ? undefined : end).at(-1)
  }
  const changes = parts.some((word, i) => {
    if (CHANGING.has(word)) return true
    if (!SOFT.has(word)) return false
    const last = phraseEnd(i)
    return last === undefined || !MADE_TO_REPORT.has(last)
  })
  return reports && !changes ? undefined : 'This tool may change things, not just report.'
}

/** JSON with sorted keys and no spaces: the form the plugin digests a tool call's arguments in. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`
  return JSON.stringify(value)
}

/**
 * The arguments: the trigger's JSON template with {{source.ref}}, {{source.title}}, {{source.link}}, {{job.title}} and
 * {{job.summary}} filled in. Holes are filled only inside the template's string values (never keys, never raw JSON), so
 * a value can't change the arguments' shape. Throws when the template isn't a JSON object.
 */
export function renderArgs(
  template: string,
  values: Record<string, string>,
): Record<string, unknown> {
  const parsed = parseArgsTemplate(template)
  const fill = (value: unknown): unknown => {
    if (typeof value === 'string')
      return value.replace(/\{\{\s*([a-z]+\.[a-z]+)\s*\}\}/g, (_, key: string) => values[key] ?? '')
    if (Array.isArray(value)) return value.map(fill)
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, fill(child)]))
    return value
  }
  return fill(parsed) as Record<string, unknown>
}

/** A report-back template must be a JSON object whose holes sit inside string values (checked when it is saved). */
export function parseArgsTemplate(template: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(template)
  } catch {
    throw new HttpError(
      400,
      'bad_template',
      'The report-back arguments must be JSON, with each {{…}} inside a quoted string.',
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new HttpError(400, 'bad_template', 'The report-back arguments must be a JSON object.')
  const keys = (value: unknown): string[] =>
    value !== null && typeof value === 'object'
      ? Object.entries(value).flatMap(([key, child]) => [key, ...keys(child)])
      : []
  if (keys(parsed).some((key) => key.includes('{{')))
    throw new HttpError(400, 'bad_template', 'A {{…}} can’t be part of a key.')
  return parsed as Record<string, unknown>
}

function triggerOf(sqlite: DatabaseSync, jobId: string) {
  const row = sqlite
    .prepare(
      `SELECT j.id, j.room_id, j.title, j.source, j.report_back, t.report_back AS mode FROM jobs j
       JOIN triggers t ON t.id = json_extract(j.source, '$.triggerId') WHERE j.id = ?`,
    )
    .get(jobId) as
    | {
        id: string
        room_id: string
        title: string
        source: string
        report_back: string | null
        mode: string
      }
    | undefined
  if (!row) return null
  return {
    ...row,
    source: JobSourceSchema.parse(JSON.parse(row.source)),
    mode: ReportBackSchema.parse(JSON.parse(row.mode)),
  }
}

/** Asks the room lead to report back now (the person's "Send the result back", or Try again). */
export function startReportBack(sqlite: DatabaseSync, jobId: string, now: string): void {
  const job = triggerOf(sqlite, jobId)
  if (!job) throw new HttpError(404, 'not_found', 'This job didn’t come from a trigger.')
  if (job.mode.mode === 'off')
    throw new HttpError(409, 'conflict', 'This trigger doesn’t report back.')
  // Never twice at once, never again once confirmed: a repeat click would post to the app twice.
  const current = reportBackOf(sqlite, jobId)?.state
  if (current === 'sending' || current === 'confirmed')
    throw new HttpError(
      409,
      'conflict',
      current === 'sending' ? 'It is being sent now.' : 'It was already reported back.',
    )
  const mode: Exclude<ReportBack, { mode: 'off' }> = job.mode
  const lead = (
    sqlite.prepare('SELECT lead_agent_id FROM rooms WHERE id = ?').get(job.room_id) as {
      lead_agent_id: string | null
    }
  ).lead_agent_id
  if (!lead) throw new HttpError(409, 'no_lead', 'The team has no lead to report back.')
  const summary = (
    sqlite
      .prepare(
        "SELECT parts FROM messages WHERE job_id = ? AND author_kind = 'agent' AND deleted_at IS NULL AND streaming = 0 ORDER BY created_at DESC, id DESC LIMIT 1",
      )
      .get(jobId) as { parts: string } | undefined
  )?.parts
  const lastReply = summary
    ? z
        .array(z.object({ kind: z.string(), text: z.string().optional() }).loose())
        .parse(JSON.parse(summary))
        .filter((part) => part.kind === 'text')
        .map((part) => part.text ?? '')
        .join('\n')
    : ''
  const args = renderArgs(mode.args, {
    'source.ref': job.source.ref,
    'source.title': job.source.title ?? '',
    'source.link': job.source.link ?? '',
    'job.title': job.title,
    'job.summary': redact(lastReply).slice(0, 4000),
  })
  const json = canonicalJson(args)
  const parent = latestMessage(sqlite, jobId)
  const id = reserveMessageRun(
    sqlite,
    {
      parentMessageId: parent,
      roomId: job.room_id,
      agentId: lead,
      chainId: parent,
      hop: 0,
      input: [
        `Report back to ${job.source.app} about ${job.source.ref}.`,
        `Call exactly the tool \`${mode.tool}\` once, with exactly these arguments and nothing else:`,
        json,
        'Do nothing else in this turn. Score checks the call.',
      ].join('\n'),
      agents: roomMembers(sqlite, job.room_id),
      retryNonce: `report-back:${now}`,
    },
    now,
  )
  sqlite.prepare('UPDATE jobs SET report_back = ? WHERE id = ?').run(
    JSON.stringify({
      state: 'sending',
      tool: mode.tool,
      digest: createHash('sha256').update(json, 'utf8').digest('hex'),
      turnId: id.slice('reply:'.length),
      at: now,
    }),
    jobId,
  )
}

/**
 * Where a job's report-back stands, derived on read: `sending` while the lead's turn runs; then `confirmed` only if
 * the bridge recorded that tool, in the lead's session for this job, with the same argument digest and success, after
 * the turn began; otherwise `not_confirmed`.
 */
export function reportBackOf(sqlite: DatabaseSync, jobId: string): JobReportBack | null {
  const job = triggerOf(sqlite, jobId)
  if (!job) return null
  if (job.mode.mode === 'off') return { state: 'off', tool: null, at: null }
  const stored = job.report_back ? StoredSchema.safeParse(JSON.parse(job.report_back)) : null
  if (!stored?.success) {
    // "Lead decides" asks the person before the trigger's first report-back.
    const first =
      job.mode.mode === 'lead_decides' &&
      !sqlite
        .prepare(
          "SELECT 1 FROM jobs WHERE json_extract(source, '$.triggerId') = ? AND report_back IS NOT NULL AND id != ?",
        )
        .get(job.source.triggerId, jobId)
    return { state: first ? 'needs_ok' : 'waiting', tool: job.mode.tool, at: null }
  }
  const turn = sqlite
    .prepare(
      'SELECT r.agent_id, r.state, r.created_at, r.room_id, r.job_id, x.session_id FROM message_runs r LEFT JOIN runs x ON x.id = r.run_id WHERE r.turn_id = ?',
    )
    .get(stored.data.turnId) as
    | {
        agent_id: string
        state: string
        created_at: string
        room_id: string
        job_id: string | null
        session_id: string | null
      }
    | undefined
  if (!turn) return { state: 'not_confirmed', tool: stored.data.tool, at: stored.data.at }
  if (turn.state === 'pending' || turn.state === 'active')
    return { state: 'sending', tool: stored.data.tool, at: stored.data.at }
  // A turn that failed or was stopped reported nothing, whatever it may have called.
  if (turn.state !== 'completed')
    return { state: 'not_confirmed', tool: stored.data.tool, at: stored.data.at }
  // The session the turn ran in (a later successor of a deleted session holds none of its calls, decision 128).
  const session =
    turn.session_id ??
    sessionFor(sqlite, {
      roomId: turn.room_id,
      jobId: turn.job_id,
      agentId: turn.agent_id,
    })
  const call = sqlite
    .prepare(
      `SELECT ended_at FROM session_tool_calls
       WHERE profile = ? AND session_id = ? AND tool = ? AND args_digest = ? AND status = 'ok' AND started_at >= ?
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(turn.agent_id, session, stored.data.tool, stored.data.digest, turn.created_at) as
    { ended_at: string | null } | undefined
  return call
    ? { state: 'confirmed', tool: stored.data.tool, at: call.ended_at ?? stored.data.at }
    : { state: 'not_confirmed', tool: stored.data.tool, at: stored.data.at }
}
