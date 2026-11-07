import { join } from 'node:path'
import { openDatabase } from '../../../../src/db/index.ts'
import { createIngest } from '../../../../src/hub/ingest.ts'
import { GatewayClient } from '../../../../src/hermes/live/gateway.ts'
import { RunIntents } from '../../../../src/hermes/live/intents.ts'
import { expect, test } from 'vitest'
import { readRun } from '../../../../src/hermes/live/translate.ts'
import { context, env, follow, installRecoveryHooks } from './recovery-helpers.ts'

installRecoveryHooks()

test('crash after gateway admission replays a sent intent with no second creation', async () => {
  env.fake.crashAfterAdmission = true
  await expect(
    env.intents.startRunIntent({ profile: 'builder', input: 'fixture' }, 'recovery-turn'),
  ).rejects.toMatchObject({ code: 'transport_error' })
  expect(env.fake.creations).toBe(1)
  expect(env.db.sqlite.prepare('SELECT state, attempts FROM command_intents').get()).toEqual({
    state: 'unknown',
    attempts: 1,
  })
  env.db.sqlite.prepare("UPDATE command_intents SET state = 'sent'").run()
  await env.ingest.close()
  env.db.close()
  env.db = openDatabase(join(env.home, 'score.db'))
  env.ingest = createIngest(env.db)
  env.gateway = new GatewayClient({ scoreHome: env.home, db: env.db, fetch: env.fake.fetch })
  env.intents = new RunIntents({ db: env.db, gateway: env.gateway, sink: env.ingest })
  await env.intents.recoverIntents()
  expect(env.fake.creations).toBe(1)
  expect(
    env.db.sqlite.prepare('SELECT state, result, attempts FROM command_intents').get(),
  ).toEqual({ state: 'accepted', result: 'run_builder_1', attempts: 2 })
  expect(readRun(env.db.sqlite, 'run_builder_1')).toMatchObject({
    score_turn_id: 'recovery-turn',
    credential_generation: 1,
  })
  expect(
    await env.gateway.startRun({ profile: 'builder', input: 'fixture' }, 'recovery-turn'),
  ).toEqual({ runId: 'run_builder_1', replayed: true })
  await follow({ profile: 'builder', runId: 'run_builder_1', credentialGeneration: 1 })
  expect(readRun(env.db.sqlite, 'run_builder_1').status).toBe('completed')
})

test('accepted intent with no projection is attached after a crash without resending', async () => {
  const runContext = await context()
  env.db.sqlite.prepare('DELETE FROM runs').run()
  env.db.sqlite.prepare("DELETE FROM ingest_keys WHERE source = 'score-dispatch'").run()
  const before = env.fake.calls.length
  await env.intents.recoverIntents()
  expect(readRun(env.db.sqlite, runContext.runId).status).toBe('queued')
  expect(env.fake.calls).toHaveLength(before)
})

test('concurrent admissions share one run, conflicting inputs are refused', async () => {
  const request = { profile: 'builder', input: 'one' }
  const first = env.intents.startRunIntent(request, 'concurrent-turn')
  const second = env.intents.startRunIntent(request, 'concurrent-turn')
  await expect(
    env.intents.startRunIntent({ ...request, input: 'two' }, 'concurrent-turn'),
  ).rejects.toThrow('different request')
  expect(await second).toEqual(await first)
  expect(env.fake.creations).toBe(1)
})

test('pending intent is sent at startup and definite rejection is marked failed', async () => {
  await context()
  env.db.sqlite.prepare("UPDATE command_intents SET state = 'pending'").run()
  await env.intents.recoverIntents()
  expect(env.fake.creations).toBe(1)
  env.fake.keys.set('builder', 'different-fixture-key')
  await expect(
    env.intents.startRunIntent({ profile: 'builder', input: 'new' }, 'rejected-turn'),
  ).rejects.toMatchObject({ status: 401 })
  expect(
    env.db.sqlite
      .prepare('SELECT state FROM command_intents WHERE idempotency_key = ?')
      .get('rejected-turn')?.state,
  ).toBe('failed')
  const before = env.fake.calls.length
  await env.intents.recoverIntents()
  expect(env.fake.calls).toHaveLength(before)
})

test.each(['sent', 'unknown'] as const)(
  'gate #4 %s admission beyond replay window never resubmits after Hermes drops its record',
  async (state) => {
    env.fake.crashAfterAdmission = true
    await expect(
      env.intents.startRunIntent({ profile: 'builder', input: 'fixture' }, 'old-turn'),
    ).rejects.toThrow()
    const firstSent = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    env.db.sqlite
      .prepare('UPDATE command_intents SET state = ?, first_sent_at = ?')
      .run(state, firstSent)
    env.fake.admissions.clear()
    const before = env.fake.calls.length
    await env.intents.recoverIntents()
    await env.intents.recoverIntents()
    expect(env.fake.calls).toHaveLength(before)
    expect(env.fake.creations).toBe(1)
    expect(
      env.db.sqlite
        .prepare('SELECT state, last_error, attempts, first_sent_at FROM command_intents')
        .get(),
    ).toEqual({
      state: 'unknown',
      last_error: 'replay_window_passed',
      attempts: 1,
      first_sent_at: firstSent,
    })
  },
)

test('gate #4 uncertain admission inside 23 hours replays and preserves first-send time', async () => {
  env.fake.crashAfterAdmission = true
  await expect(
    env.intents.startRunIntent({ profile: 'builder', input: 'fixture' }, 'young-turn'),
  ).rejects.toThrow()
  const firstSent = new Date(Date.now() - 22 * 60 * 60 * 1000).toISOString()
  env.db.sqlite.prepare('UPDATE command_intents SET first_sent_at = ?').run(firstSent)
  await env.intents.recoverIntents()
  expect(env.fake.creations).toBe(1)
  expect(env.db.sqlite.prepare('SELECT state, first_sent_at FROM command_intents').get()).toEqual({
    state: 'accepted',
    first_sent_at: firstSent,
  })
})
