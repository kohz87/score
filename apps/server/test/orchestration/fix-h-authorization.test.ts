import { expect, test } from 'vitest'
import { detail, holdScript, running, seedBuilder, startHarness, startup } from './fix-h-helpers.ts'

test('fix-h 2: a rolled-back lower budget is detected with no further dispatch; an honest database is not fenced', async () => {
  const h = await startHarness({ lead: holdScript })
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
  const h = await startHarness({ lead: holdScript })
  const id = await running({ budgetUsd: 50 })
  await h.orch.limits(id, { budgetUsd: 5, orchestrationRevision: detail(id).revision })
  await h.orch.limits(id, { budgetUsd: 80, orchestrationRevision: detail(id).revision })
  expect(startup().check.fenced).toBe(false)
  // The earlier, stricter database (budget 5) is stricter than the journal's latest: fine.
  h.db.sqlite.prepare('UPDATE orchestrations SET budget_usd = 5 WHERE id = ?').run(id)
  expect(startup().check.fenced).toBe(false)
})

test('fix-h 2: a rolled-back deadline (shortened, or set where there was none) is detected', async () => {
  const h = await startHarness({ lead: holdScript })
  const id = await running({})
  const soon = new Date(h.scheduler.now() + 3_600_000).toISOString()
  await h.orch.limits(id, { deadlineAt: soon, orchestrationRevision: detail(id).revision })
  h.db.sqlite.prepare('UPDATE orchestrations SET deadline_at = NULL WHERE id = ?').run(id)
  expect(startup().check.fenced).toBe(true)
})

test('fix-h 2: a rolled-back shorter deadline is detected', async () => {
  const h = await startHarness({ lead: holdScript })
  const later = new Date(h.scheduler.now() + 7_200_000).toISOString()
  const id = await running({ deadlineAt: later })
  const soon = new Date(h.scheduler.now() + 3_600_000).toISOString()
  await h.orch.limits(id, { deadlineAt: soon, orchestrationRevision: detail(id).revision })
  h.db.sqlite.prepare('UPDATE orchestrations SET deadline_at = ? WHERE id = ?').run(later, id)
  expect(startup().check.fenced).toBe(true)
})

test('fix-h 2: a rolled-back revocation of unknown-spend acceptance is detected', async () => {
  const h = await startHarness({ lead: holdScript })
  const id = await running({ budgetUsd: 50 })
  await h.orch.limits(id, { acceptUnknownSpend: true, orchestrationRevision: detail(id).revision })
  await h.orch.limits(id, { acceptUnknownSpend: false, orchestrationRevision: detail(id).revision })
  expect(startup().check.fenced).toBe(false)
  h.db.sqlite.prepare('UPDATE orchestrations SET accepted_unknown_spend = 1 WHERE id = ?').run(id)
  expect(startup().check.fenced).toBe(true)
})

test('fix-h 2: team and agent pause holds are journaled; a database that lost one is fenced, a resumed one is not', async () => {
  const h = await startHarness({ lead: holdScript })
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
  const h = await startHarness({ lead: holdScript })
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

test('fix-h 2: compaction keeps only the newest limits and hold entries, and the newest still protects', async () => {
  const h = await startHarness({ lead: holdScript })
  seedBuilder()
  const id = await running({ budgetUsd: 50 })
  await h.orch.limits(id, { budgetUsd: 20, orchestrationRevision: detail(id).revision })
  await h.orch.limits(id, { budgetUsd: 5, orchestrationRevision: detail(id).revision })
  h.orch.recordHold({ kind: 'team' }, 'set')
  h.orch.recordHold({ kind: 'team' }, 'lift')
  h.orch.maintenance()
  const own = h.journal.readOwn()
  const kept = own.ok
    ? own.entries.filter((e) => e.kind === 'authorization' || e.kind === 'hold')
    : []
  expect(kept.map((e) => e.kind)).toEqual(['authorization', 'hold'])
  h.db.sqlite.prepare('UPDATE orchestrations SET budget_usd = 20 WHERE id = ?').run(id)
  expect(startup().check.fenced).toBe(true)
})
