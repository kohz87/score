import { expect, test } from 'vitest'
import {
  db,
  headers,
  TRIGGER,
  ticket,
  createWebhookTestHelpers,
  setupWebhooksTest,
  type WebhooksTestState,
} from './webhooks-helpers.ts'

let app: WebhooksTestState['app']
let now: WebhooksTestState['now']
const testState: WebhooksTestState = {
  get app() {
    return app
  },
  set app(value) {
    app = value
  },
  get now() {
    return now
  },
  set now(value) {
    now = value
  },
}

const { call } = createWebhookTestHelpers(testState)
setupWebhooksTest(testState)

test('report-back is a constrained lead turn, reported back only on a matching tool-call record', async () => {
  const made = await app.inject({
    method: 'POST',
    url: '/api/triggers',
    headers,
    payload: {
      ...TRIGGER,
      reportBack: {
        mode: 'fixed',
        tool: 'add_comment',
        args: '{"ticket":"{{source.ref}}","text":"{{job.summary}}"}',
      },
    },
  })
  const { trigger, secret } = made.json() as { trigger: { id: string }; secret: string }
  const answer = (await call(trigger.id, secret, JSON.stringify(ticket))).json() as {
    jobId: string
  }
  const { listJobs } = await import('../../src/domain/exchanges/store.ts')
  const state = () =>
    listJobs(
      db.sqlite,
      db.sqlite.prepare("SELECT id FROM rooms WHERE role = 'team'").get()!.id as string,
    ).find((job) => job.id === answer.jobId)!.reportBack
  expect(state()).toEqual({ state: 'waiting', tool: 'add_comment', at: null })
  // The lead's opening turn answered; its reply is what the report carries.
  db.sqlite
    .prepare("UPDATE message_runs SET state = 'completed' WHERE job_id = ?")
    .run(answer.jobId)
  db.sqlite
    .prepare(
      `INSERT INTO messages (id, room_id, job_id, author_kind, author_agent_id, "to", parts, refs, streaming, created_at, updated_at)
       SELECT 'lead-reply', room_id, id, 'agent', 'lead', '[]', '[{"kind":"text","text":"Fixed: the session cookie expired early."}]', '[]', 0, ?, ?
       FROM jobs WHERE id = ?`,
    )
    .run(new Date(now + 1000).toISOString(), new Date(now + 1000).toISOString(), answer.jobId)
  now += 2000
  expect(
    (await app.inject({ method: 'POST', url: `/api/jobs/${answer.jobId}/report-back`, headers }))
      .statusCode,
  ).toBe(200)
  const turn = db.sqlite
    .prepare(
      "SELECT turn_id, input, created_at FROM message_runs WHERE job_id = ? AND input LIKE 'Report back%'",
    )
    .get(answer.jobId) as { turn_id: string; input: string; created_at: string }
  expect(turn.input).toContain(
    'Call exactly the tool `add_comment` once, with exactly these arguments',
  )
  expect(turn.input).toContain(
    '{"text":"Fixed: the session cookie expired early.","ticket":"TCK-142"}',
  )
  expect(state()?.state).toBe('sending')
  db.sqlite
    .prepare("UPDATE message_runs SET state = 'completed' WHERE turn_id = ?")
    .run(turn.turn_id)
  // The turn ended without the call: not confirmed.
  expect(state()?.state).toBe('not_confirmed')
  const { canonicalJson } = await import('../../src/domain/triggers/report-back.ts')
  const { createHash } = await import('node:crypto')
  const digest = (args: unknown) => createHash('sha256').update(canonicalJson(args)).digest('hex')
  const { sessionFor } = await import('../../src/domain/job-sessions.ts')
  const teamId = db.sqlite.prepare("SELECT id FROM rooms WHERE role = 'team'").get()!.id as string
  // The job's own session: a trigger's job is a new job of the team room.
  const session = sessionFor(db.sqlite, { roomId: teamId, jobId: answer.jobId, agentId: 'lead' })
  expect(session).toBe(`score-${teamId}-${answer.jobId}-lead`)
  const record = (id: string, args: unknown, status: string, startedAt: string) =>
    db.sqlite
      .prepare(
        `INSERT INTO session_tool_calls (profile, session_id, tool_call_id, tool, status, started_at, ended_at, args_digest)
         VALUES ('lead', ?, ?, 'add_comment', ?, ?, ?, ?)`,
      )
      .run(session, id, status, startedAt, startedAt, digest(args))
  // Other arguments, a failed call, or a call from before the turn don't count.
  record('c1', { ticket: 'TCK-142', text: 'something else' }, 'ok', turn.created_at)
  record(
    'c2',
    { ticket: 'TCK-142', text: 'Fixed: the session cookie expired early.' },
    'error',
    turn.created_at,
  )
  record(
    'c3',
    { ticket: 'TCK-142', text: 'Fixed: the session cookie expired early.' },
    'ok',
    '2000-01-01T00:00:00.000Z',
  )
  expect(state()?.state).toBe('not_confirmed')
  record(
    'c4',
    { text: 'Fixed: the session cookie expired early.', ticket: 'TCK-142' },
    'ok',
    turn.created_at,
  )
  expect(state()?.state).toBe('confirmed')
})

// Security review (Sonnet, 11.1d).

test('report-back is refused while sending, and a failed turn is never confirmed', async () => {
  const made = await app.inject({
    method: 'POST',
    url: '/api/triggers',
    headers,
    payload: {
      ...TRIGGER,
      reportBack: { mode: 'fixed', tool: 'add_comment', args: '{"ticket":"{{source.ref}}"}' },
    },
  })
  const { trigger, secret } = made.json() as { trigger: { id: string }; secret: string }
  const answer = (await call(trigger.id, secret, JSON.stringify(ticket))).json() as {
    jobId: string
  }
  db.sqlite
    .prepare("UPDATE message_runs SET state = 'completed' WHERE job_id = ?")
    .run(answer.jobId)
  now += 1000
  const send = () =>
    app.inject({ method: 'POST', url: `/api/jobs/${answer.jobId}/report-back`, headers })
  expect((await send()).statusCode).toBe(200)
  expect((await send()).statusCode).toBe(409)
  db.sqlite
    .prepare(
      "UPDATE message_runs SET state = 'failed' WHERE job_id = ? AND input LIKE 'Report back%'",
    )
    .run(answer.jobId)
  const { reportBackOf } = await import('../../src/domain/triggers/report-back.ts')
  expect(reportBackOf(db.sqlite, answer.jobId)?.state).toBe('not_confirmed')
  // Try again is allowed once it wasn't confirmed.
  now += 1000
  expect((await send()).statusCode).toBe(200)
})

test('a report-back tool that does not look like reporting carries a warning; reporting tools do not', async () => {
  const warned = async (tool: string) => {
    const made = await app.inject({
      method: 'POST',
      url: '/api/triggers',
      headers,
      payload: {
        ...TRIGGER,
        name: tool,
        reportBack: { mode: 'fixed', tool, args: '{"id":"{{source.ref}}"}' },
      },
    })
    expect(made.statusCode).toBe(201)
    return made.json().trigger.warning as string | undefined
  }
  expect(await warned('tickets_add_comment')).toBeUndefined()
  expect(await warned('tickets_delete_ticket')).toContain('may change things')
  expect(await warned('tickets_frobnicate')).toContain('may change things')
  const list = await app.inject({ method: 'GET', url: '/api/triggers', headers })
  expect(list.json().items.filter((t: { warning?: string }) => t.warning)).toHaveLength(2)
})

test('a reporting word does not hide a changing one in the report-back tool name (3.5.0 review)', async () => {
  const { reportBackWarning } = await import('../../src/domain/triggers/report-back.ts')
  for (const tool of ['send_money', 'post_deploy', 'message_and_transfer', 'reply_then_publish'])
    expect(reportBackWarning(tool), tool).toMatch(/may change things/)
  for (const tool of [
    'add_comment',
    'post_status',
    'notify_channel',
    'send_reply',
    'create_comment',
    'createIssueComment',
    'github.create_issue_comment',
    'create_pull_request_review',
    'submit_review',
    'add_review',
    'leave_feedback',
    'add_reaction',
  ])
    expect(reportBackWarning(tool), tool).toBeUndefined()
  // Words outside the reporting vocabulary warn, whatever else the name says (an allowlist).
  for (const tool of [
    'dataset_status',
    'payload_report',
    'send_funds',
    'send_crypto',
    'send_command',
    'send_email',
    'post_tweet',
    'post_webhook',
    'reply_all',
    'post_pull_request',
    'post_job',
    'send_request',
  ])
    expect(reportBackWarning(tool), tool).toMatch(/may change things/)
  for (const tool of ['send_slack_message', 'post_to_channel', 'reply_in_thread'])
    expect(reportBackWarning(tool), tool).toBeUndefined()
  for (const tool of [
    'create_issue',
    'update_ticket',
    'set_owner',
    'post_message_and_create_issue',
    'notify_and_set_priority',
    'reply_and_create_ticket',
    'update_status',
    'update_issue_status',
    'create_issue_with_comment',
    'update_issue_with_comment',
  ])
    expect(reportBackWarning(tool), tool).toMatch(/may change things/)
})
