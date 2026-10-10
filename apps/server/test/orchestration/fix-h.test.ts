import { afterEach, expect, test } from 'vitest'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { runRecoveredObservation } from '../../src/hermes/live/translate.ts'
import { attemptOf, harness, type Harness } from './harness.ts'

let h: Harness
afterEach(async () => {
  await h?.close()
})
const status = (id: string) => h.orch.summary(id).status
const detail = (id: string) => h.orch.snapshot(id).orchestration

test('fix-h 1: a run recovered from session text (404 + matching reply) shows its text but is not termination evidence', async () => {
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', { agent: 'builder', instruction: '[fake:hold] write it' })
          await t.call('orch.assign', { agent: 'reviewer', instruction: 'check it', after: ['s1'] })
        },
      }),
    },
  })
  const id = await h.create({ gatePolicy: 'none' })
  await h.until(() => attemptOf(h, id, 'step', 's1').some((a) => a.state === 'running'))
  const attempt = attemptOf(h, id, 'step', 's1')[0]!
  // Hermes forgot the run; the live follower found a matching assistant reply in the session history.
  await h.ingest.submit(
    runRecoveredObservation(
      { profile: 'builder', runId: attempt.runId!, credentialGeneration: 1 },
      'Recovered answer text',
    ),
  )
  expect(
    h.rows<{ status: string; terminal_source: string }>(
      'SELECT status, terminal_source FROM runs WHERE id = ?',
      attempt.runId!,
    ),
  ).toEqual([{ status: 'completed', terminal_source: 'recovered' }])
  await h.settle(5000)
  const after = attemptOf(h, id, 'step', 's1')[0]!
  expect(after.state).toBe('unknown')
  expect(after.unknownReason).toBe('recovered_text_only')
  const d = detail(id)
  expect(d.stepsList.find((s) => s.id === 's1')!.status).toBe('unknown')
  expect(d.unconfirmed).toEqual([after.id])
  // No successor was admitted and the result was not accepted.
  expect(attemptOf(h, id, 'step', 's2')).toHaveLength(0)
  expect(
    h.rows('SELECT result FROM orc_steps WHERE id = ? AND result IS NOT NULL', 's1'),
  ).toHaveLength(0)
  expect(status(id)).not.toBe('succeeded')
  // The person still sees the text (chat behaviour is unchanged).
  expect(
    h.rows<{ output: string }>('SELECT output FROM runs WHERE id = ?', attempt.runId!)[0]!.output,
  ).toBe('Recovered answer text')
})

// ---------------------------------------------------------------------------------- item 2: journaled authorization

import { GlobalFenceStore } from '../../src/domain/orchestration/fence.ts'

const holdScript = {
  script: byTurn({
    1: async (t) => {
      await t.call('orch.assign', { agent: 'builder', instruction: '[fake:hold]' })
    },
  }),
}
/** A fresh fence store over the live database and journal: what the next Score start would run. */
const startup = () => {
  const store = new GlobalFenceStore(h.db, h.journal, () => h.scheduler.now())
  return { store, check: store.startupCheck() }
}
const running = async (overrides: Parameters<Harness['create']>[0]) => {
  const id = await h.create({ gatePolicy: 'none', ...overrides })
  await h.until(() => attemptOf(h, id, 'step', 's1').some((a) => a.state === 'running'))
  return id
}

test('fix-h 2: a rolled-back lower budget is detected with no further dispatch; an honest database is not fenced', async () => {
  h = await harness({ lead: holdScript })
  const id = await running({ budgetUsd: 50 })
  expect(startup().check.fenced).toBe(false)
  await h.orch.limits(id, { budgetUsd: 5, orchestrationRevision: detail(id).revision })
  expect(startup().check.fenced).toBe(false)
  // A database-only restore: the budget is back to 50, nothing else differs.
  h.db.sqlite.prepare('UPDATE orchestrations SET budget_usd = 50 WHERE id = ?').run(id)
  const { store, check } = startup()
  expect(check).toEqual({ fenced: true, reasons: ['journal_mismatch'] })
  expect(
    store
      .view()
      .items.map((i) => i.detail)
      .join('\n'),
  ).toContain('limits')
})

test('fix-h 2: raising a limit afterwards is journaled too, so the later honest state is not a doubt', async () => {
  h = await harness({ lead: holdScript })
  const id = await running({ budgetUsd: 50 })
  await h.orch.limits(id, { budgetUsd: 5, orchestrationRevision: detail(id).revision })
  await h.orch.limits(id, { budgetUsd: 80, orchestrationRevision: detail(id).revision })
  expect(startup().check.fenced).toBe(false)
  // The earlier, stricter database (budget 5) is stricter than the journal's latest: fine.
  h.db.sqlite.prepare('UPDATE orchestrations SET budget_usd = 5 WHERE id = ?').run(id)
  expect(startup().check.fenced).toBe(false)
})

test('fix-h 2: a rolled-back deadline (shortened, or set where there was none) is detected', async () => {
  h = await harness({ lead: holdScript })
  const id = await running({})
  const soon = new Date(h.scheduler.now() + 3_600_000).toISOString()
  await h.orch.limits(id, { deadlineAt: soon, orchestrationRevision: detail(id).revision })
  h.db.sqlite.prepare('UPDATE orchestrations SET deadline_at = NULL WHERE id = ?').run(id)
  expect(startup().check.fenced).toBe(true)
})

test('fix-h 2: a rolled-back shorter deadline is detected', async () => {
  h = await harness({ lead: holdScript })
  const later = new Date(h.scheduler.now() + 7_200_000).toISOString()
  const id = await running({ deadlineAt: later })
  const soon = new Date(h.scheduler.now() + 3_600_000).toISOString()
  await h.orch.limits(id, { deadlineAt: soon, orchestrationRevision: detail(id).revision })
  h.db.sqlite.prepare('UPDATE orchestrations SET deadline_at = ? WHERE id = ?').run(later, id)
  expect(startup().check.fenced).toBe(true)
})

test('fix-h 2: a rolled-back revocation of unknown-spend acceptance is detected', async () => {
  h = await harness({ lead: holdScript })
  const id = await running({ budgetUsd: 50 })
  await h.orch.limits(id, { acceptUnknownSpend: true, orchestrationRevision: detail(id).revision })
  await h.orch.limits(id, { acceptUnknownSpend: false, orchestrationRevision: detail(id).revision })
  expect(startup().check.fenced).toBe(false)
  h.db.sqlite.prepare('UPDATE orchestrations SET accepted_unknown_spend = 1 WHERE id = ?').run(id)
  expect(startup().check.fenced).toBe(true)
})

test('fix-h 2: team and agent pause holds are journaled; a database that lost one is fenced, a resumed one is not', async () => {
  h = await harness({ lead: holdScript })
  await running({})
  const recordHold = (target: Parameters<typeof h.orch.recordHold>[0], action: 'set' | 'lift') =>
    h.orch.recordHold(target, action)
  recordHold({ kind: 'team' }, 'set')
  expect(startup().check.fenced).toBe(true)
  h.db.sqlite
    .prepare('UPDATE team_state SET paused_at = ? WHERE id = 1')
    .run('2026-10-10T10:00:00.000Z')
  // Fenced already (sticky until a person lifts it): look at the verification alone.
  const { store } = startup()
  const lift = () => store.lift(store.view().revision, 'reviewed')
  lift()
  expect(startup().check.fenced).toBe(false)
  recordHold({ kind: 'team' }, 'lift')
  h.db.sqlite.prepare('UPDATE team_state SET paused_at = NULL WHERE id = 1').run()
  expect(startup().check.fenced).toBe(false)
  recordHold({ kind: 'agent', agentId: 'builder' }, 'set')
  expect(startup().check.fenced).toBe(true)
})

test('fix-h 2: the pause routes journal their hold before the database changes', async () => {
  const { buildApp } = await import('../../src/app.ts')
  const { loadConfig } = await import('../../src/config.ts')
  h = await harness({ lead: holdScript })
  const app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake', SCORE_HOME: `${h.dir}/home` }),
    logger: false,
    db: h.db,
    ingest: h.ingest,
    port: h.port,
    clock: () => h.scheduler.now(),
    orchestrator: h.orch,
  })
  const paired = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'x-score-client': 'web' },
    payload: { token: app.pairing.createToken() },
  })
  const headers = {
    'x-score-client': 'web',
    cookie: paired.headers['set-cookie']!.toString().split(';')[0]!,
  }
  try {
    expect((await app.inject({ method: 'POST', url: '/api/team/pause', headers })).statusCode).toBe(
      200,
    )
    expect(
      (await app.inject({ method: 'POST', url: '/api/agents/builder/pause', headers })).statusCode,
    ).toBe(200)
    const own = h.journal.readOwn()
    const holds = own.ok ? own.entries.filter((e) => e.kind === 'hold') : []
    expect(holds.map((e) => [e.target, e.action])).toEqual([
      ['team', 'set'],
      ['agent', 'set'],
    ])
    expect(startup().check.fenced).toBe(false)
    await app.inject({ method: 'POST', url: '/api/team/resume', headers })
    await app.inject({ method: 'POST', url: '/api/agents/builder/resume', headers })
    expect(startup().check.fenced).toBe(false)
    // The database loses both holds (a restore): the journal's last word was `lift`, so there is nothing to doubt.
    // Pause again, then lose the team hold only.
    await app.inject({ method: 'POST', url: '/api/team/pause', headers })
    h.db.sqlite.prepare('UPDATE team_state SET paused_at = NULL WHERE id = 1').run()
    expect(startup().check.fenced).toBe(true)
  } finally {
    await app.close()
  }
})
