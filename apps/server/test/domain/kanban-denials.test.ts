import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { closeKanbanDenials } from '../../src/domain/kanban-denials.ts'
import { sweepKanbanDenials } from '../../src/hermes/live/kanban-denials.ts'
import { buildFixture, insertTask } from '../fixtures/hermes/sqlite-fixture.ts'
import { event, setup } from '../hermes/bridge/helpers.ts'

let env: ReturnType<typeof setup>
beforeEach(() => {
  env = setup()
})
afterEach(async () => {
  await env.close()
})
const denial = (runId: number | null = 3, digest = 'a'.repeat(64)) =>
  event(1, 'post_tool_call', {
    tool_name: 'terminal',
    status: 'error',
    args: { command: 'rm -rf /tmp/example token=planted-secret' },
    result: JSON.stringify({ status: 'blocked', error: 'BLOCKED: Command flagged as dangerous' }),
    kanbanDenial: { patternKey: 'delete', commandDigest: digest, taskId: 'task-1', runId },
  })

test.each([3, null])(
  'dedupes task/run/digest (%s), exposes a redacted task-linked view-only card, rejects decisions',
  async (run) => {
    const token = await env.token()
    const item = denial(run)
    expect((await env.send(token, [item])).statusCode).toBe(200)
    await env.send(token, [item, { ...item, counter: 2 }])
    const rows = env.db.sqlite.prepare('SELECT * FROM approvals').all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      origin: 'kanban',
      stage: 'human',
      target_kind: 'none',
      visible: 1,
      surface: 'kanban',
      kanban_task_id: 'task-1',
      kanban_run_id: run,
      expires_at: null,
      choices: '[]',
      pattern_keys: '["delete"]',
    })
    const cards = (await env.app.inject('/api/approvals')).json().items
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      actionable: false,
      choices: [],
      refs: [{ kind: 'task', taskId: 'task-1' }],
      blocking: 'Task task-1 is blocked',
    })
    expect(JSON.stringify(cards)).not.toContain('planted-secret')
    const pair = await env.app.inject({
      method: 'POST',
      url: '/api/session/pair',
      headers: { 'x-score-client': 'web' },
      payload: { token: env.app.pairing.createToken() },
    })
    const response = await env.app.inject({
      method: 'POST',
      url: `/api/approvals/${cards[0].id}/decision`,
      headers: {
        'x-score-client': 'web',
        cookie: pair.headers['set-cookie']!.toString().split(';')[0]!,
      },
      payload: { choice: 'once' },
    })
    expect(response.statusCode).toBe(409)
    expect(env.db.sqlite.prepare('SELECT * FROM approval_deliveries').all()).toEqual([])
    expect(
      Buffer.concat(
        ['score.db', 'score.db-wal'].map((name) => readFileSync(join(env.home, name))),
      ).toString(),
    ).not.toContain('planted-secret')
  },
)

test('different runs and digests each receive a card', async () => {
  const token = await env.token()
  await env.send(token, [
    denial(3),
    { ...denial(4), counter: 2 },
    { ...denial(3, 'b'.repeat(64)), counter: 3 },
  ])
  expect(env.db.sqlite.prepare('SELECT * FROM approvals').all()).toHaveLength(3)
})

test('mismatched producer task and invalid fields are ignored', async () => {
  const token = await env.token()
  const item = denial()
  const field = item.payload.kanbanDenial as object
  await env.send(token, [
    { ...item, payload: { ...item.payload, kanbanDenial: { ...field, taskId: 'task-other' } } },
    {
      ...item,
      counter: 2,
      payload: { ...item.payload, kanbanDenial: { ...field, commandDigest: 'invalid' } },
    },
  ])
  expect(env.db.sqlite.prepare('SELECT * FROM approvals').all()).toEqual([])
  expect(env.metrics).toMatchObject({ mismatchedKanbanTasks: 1 })
})

test.each([
  ['done', 3, true],
  ['archived', 3, true],
  ['triage', 3, true],
  ['running', 4, true],
  ['ready', 4, true],
  // Not evidence: the worker reports the denial before Hermes marks the task blocked.
  ['running', 3, false],
  ['running', 2, false],
  ['ready', null, false],
  ['scheduled', 3, false],
  ['review', null, false],
] as const)(
  'read-only sweep: task %s with current run %s closes the card: %s',
  async (status, currentRun, closes) => {
    const fixture = buildFixture(join(env.home, 'kanban.db'), 'kanban')
    try {
      insertTask(fixture)
      fixture
        .prepare("UPDATE tasks SET status = 'blocked', current_run_id = 3 WHERE id = 'task-1'")
        .run()
      const token = await env.token()
      await env.send(token, [denial()])
      await sweepKanbanDenials(env.db, env.ingest, { hermesHome: env.home })
      expect(env.db.sqlite.prepare('SELECT status FROM approvals').get()).toMatchObject({
        status: 'pending',
      })
      fixture
        .prepare('UPDATE tasks SET status = ?, current_run_id = ? WHERE id = ?')
        .run(status, currentRun, 'task-1')
      await sweepKanbanDenials(env.db, env.ingest, { hermesHome: env.home })
      if (!closes) {
        expect(
          env.db.sqlite
            .prepare("SELECT count(*) AS n FROM ingest_keys WHERE source = 'kanban-denial-sweep'")
            .get()?.n,
        ).toBe(0)
        expect(env.db.sqlite.prepare('SELECT status, closed_reason FROM approvals').get()).toEqual({
          status: 'pending',
          closed_reason: null,
        })
        return
      }
      expect(
        env.db.sqlite.prepare('SELECT status, phase, closed_reason FROM approvals').get(),
      ).toMatchObject({ status: 'withdrawn', phase: 'withdrawn', closed_reason: 'task_moved' })
      expect((await env.app.inject('/api/approvals')).json().items).toEqual([])
      expect((await env.app.inject('/api/approvals?status=all')).json().items).toHaveLength(1)
      await env.send(token, [{ ...denial(), counter: 2 }])
      expect(env.db.sqlite.prepare('SELECT status FROM approvals').get()).toMatchObject({
        status: 'withdrawn',
      })
    } finally {
      fixture.close()
    }
  },
)

test('missing task or database never proves closure', async () => {
  const token = await env.token()
  await env.send(token, [denial()])
  await expect(sweepKanbanDenials(env.db, env.ingest, { hermesHome: env.home })).rejects.toThrow()
  const fixture = buildFixture(join(env.home, 'kanban.db'), 'kanban')
  try {
    await sweepKanbanDenials(env.db, env.ingest, { hermesHome: env.home })
    expect(env.db.sqlite.prepare('SELECT status FROM approvals').get()).toMatchObject({
      status: 'pending',
    })
  } finally {
    fixture.close()
  }
})

test("Score's own unblock closes a still-blocked task's open cards", async () => {
  const token = await env.token()
  await env.send(token, [denial()])
  env.db.tx((sqlite) => closeKanbanDenials(sqlite, ['task-1'], new Date().toISOString()))
  expect(env.db.sqlite.prepare('SELECT status, closed_reason FROM approvals').get()).toEqual({
    status: 'withdrawn',
    closed_reason: 'task_moved',
  })
})
