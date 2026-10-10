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

// ------------------------------------------------------------------------------------ item 3: frozen agent mapping

import type { OrchReceipt } from '@score/contract'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const replaceBuilder = () =>
  h.db.sqlite
    .prepare("UPDATE agent_lifecycle SET incarnation_id = ? WHERE agent_id = 'builder'")
    .run(B)
const seedBuilder = () =>
  h.db.sqlite
    .prepare(
      "INSERT INTO agent_lifecycle (agent_id, incarnation_id, state) VALUES ('builder', ?, 'ready')",
    )
    .run(A)

test('fix-h 3: an agent replaced after Start and before the assignment is refused until the person remaps, then the lead continues', async () => {
  const receipts: OrchReceipt[] = []
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.ask', { question: 'ready?' })
        },
        2: async (t) => {
          receipts.push(
            (await t.call('orch.assign', {
              agent: 'builder',
              instruction: 'first try',
            })) as OrchReceipt,
          )
        },
        3: async (t) => {
          receipts.push(
            (await t.call('orch.assign', {
              agent: 'builder',
              instruction: 'after remap',
            })) as OrchReceipt,
          )
        },
      }),
    },
  })
  seedBuilder()
  const id = await h.create({ gatePolicy: 'none' })
  await h.until(() => detail(id).inquiries.length === 1)
  expect(h.rows('SELECT incarnation FROM orc_agent_map WHERE agent_id = ?', 'builder')).toEqual([
    { incarnation: A },
  ])
  replaceBuilder()
  await h.orch.inquiryAnswer(id, 'q1', {
    answer: 'yes',
    expectedRevision: 1,
    orchestrationRevision: detail(id).revision,
  })
  await h.until(() => receipts.length === 1)
  expect(receipts[0]).toMatchObject({ status: 'refused', code: 'agent_changed' })
  expect(detail(id).stepsList).toHaveLength(0)
  expect(h.orch.summary(id).needsYou).toContainEqual({
    kind: 'remap',
    agentId: 'builder',
    role: 'agent',
    frozenIncarnation: A,
    currentIncarnation: B,
  })
  // A decision paired with the wrong incarnations is a conflict and changes nothing.
  await expect(
    h.orch.remap(id, {
      agentId: 'builder',
      frozenIncarnation: B,
      currentIncarnation: B,
      orchestrationRevision: detail(id).revision,
      acknowledge: true,
    }),
  ).rejects.toMatchObject({ status: 409 })
  await expect(
    h.orch.remap(id, {
      agentId: 'builder',
      frozenIncarnation: A,
      currentIncarnation: B,
      orchestrationRevision: detail(id).revision - 1,
      acknowledge: true,
    }),
  ).rejects.toMatchObject({ status: 409 })
  await h.orch.remap(id, {
    agentId: 'builder',
    frozenIncarnation: A,
    currentIncarnation: B,
    orchestrationRevision: detail(id).revision,
    acknowledge: true,
  })
  expect(h.orch.summary(id).needsYou.some((n) => n.kind === 'remap')).toBe(false)
  // The journal holds it, so a database that loses it is fenced; the honest one is not.
  expect(startup().check.fenced).toBe(false)
  await h.until(() => receipts.length === 2)
  expect(receipts[1]).toMatchObject({ status: 'ok' })
  await h.until(() => detail(id).stepsList[0]?.status === 'succeeded')
  h.db.sqlite.prepare("UPDATE orc_agent_map SET incarnation = ? WHERE agent_id = 'builder'").run(A)
  expect(startup().check.fenced).toBe(true)
})

test('fix-h 3: an agent replaced between the assignment and the send blocks the step and asks for a remap', async () => {
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', { agent: 'builder', instruction: 'x' })
        },
      }),
    },
  })
  seedBuilder()
  const id = await h.create({ gatePolicy: 'every-step' })
  await h.until(() => detail(id).gates.length === 1)
  replaceBuilder()
  await h.orch.gateDecision(id, 'g1', {
    decision: 'approve',
    expectedRevision: 1,
    orchestrationRevision: detail(id).revision,
  })
  await h.until(() => detail(id).stepsList[0]!.status === 'blocked')
  expect(attemptOf(h, id, 'step')).toHaveLength(0)
  expect(h.orch.summary(id).needsYou.map((n) => n.kind)).toContain('remap')
})

test('fix-h 3: a step whose incarnation is not the frozen mapping is blocked before the send, even when the agent is current', async () => {
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', { agent: 'builder', instruction: 'x' })
        },
      }),
    },
  })
  seedBuilder()
  const id = await h.create({ gatePolicy: 'every-step' })
  await h.until(() => detail(id).gates.length === 1)
  // Replaced and put back (A -> B -> A) while the person remapped to B: the step carries A, the mapping says B.
  h.db.sqlite.prepare("UPDATE orc_agent_map SET incarnation = ? WHERE agent_id = 'builder'").run(B)
  await h.orch.gateDecision(id, 'g1', {
    decision: 'approve',
    expectedRevision: 1,
    orchestrationRevision: detail(id).revision,
  })
  await h.until(() => detail(id).stepsList[0]!.status === 'blocked')
  expect(detail(id).stepsList[0]!.disposition).toContain('agent_changed')
  expect(attemptOf(h, id, 'step')).toHaveLength(0)
})

test('fix-h 3: a replaced lead pauses the run and the remap decision resumes it', async () => {
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.ask', { question: 'ready?' })
        },
      }),
    },
  })
  h.db.sqlite
    .prepare(
      "INSERT INTO agent_lifecycle (agent_id, incarnation_id, state) VALUES ('lead', ?, 'ready')",
    )
    .run(A)
  const id = await h.create()
  await h.until(() => detail(id).inquiries.length === 1)
  await h.until(() => attemptOf(h, id, 'lead')[0]!.state === 'terminated')
  h.db.sqlite
    .prepare("UPDATE agent_lifecycle SET incarnation_id = ? WHERE agent_id = 'lead'")
    .run(B)
  await h.orch.inquiryAnswer(id, 'q1', {
    answer: 'yes',
    expectedRevision: 1,
    orchestrationRevision: detail(id).revision,
  })
  await h.until(() => status(id) === 'paused')
  expect(h.orch.summary(id).needsYou).toContainEqual(
    expect.objectContaining({ kind: 'remap', agentId: 'lead', role: 'lead' }),
  )
  await h.orch.remap(id, {
    agentId: 'lead',
    frozenIncarnation: A,
    currentIncarnation: B,
    orchestrationRevision: detail(id).revision,
    acknowledge: true,
  })
  expect(h.rows('SELECT lead_incarnation FROM orchestrations WHERE id = ?', id)).toEqual([
    { lead_incarnation: B },
  ])
  await h.until(() => attemptOf(h, id, 'lead').length === 2)
  expect(status(id)).not.toBe('paused')
})

test('fix-h 2: compaction keeps only the newest limits and hold entries, and the newest still protects', async () => {
  h = await harness({ lead: holdScript })
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
