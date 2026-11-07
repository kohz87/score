import { RunIntents } from '../../../../src/hermes/live/intents.ts'
import { expect, test } from 'vitest'
import { env, installRecoveryHooks } from './recovery-helpers.ts'

installRecoveryHooks()

// audit5-e: a reply cancelled while Hermes admitted its run must be stopped, however many tries that takes.
function cancelTurn(turnId: string) {
  env.db.sqlite.exec('PRAGMA foreign_keys = OFF')
  env.db.sqlite
    .prepare(
      `INSERT INTO message_runs (message_id, run_id, room_id, agent_id, chain_id, hop, turn_id, parent_message_id, input, agents, state, created_at)
       VALUES ('m1', NULL, 'room', 'builder', 'm0', 0, ?, 'm0', 'hi', '[]', 'failed', '2026-10-09T10:00:00.000Z')`,
    )
    .run(turnId)
}
const stops = () => env.fake.calls.filter((call) => call.path.endsWith('/stop')).length

test('a stop for a cancelled reply that failed is retried by recovery and by an explicit retry, until it succeeds', async () => {
  cancelTurn('cancel-turn')
  env.fake.stopFails = 1
  const request = { profile: 'builder', input: 'fixture' }
  await env.intents.startRunIntent(request, 'cancel-turn')
  expect(stops()).toBe(1)
  // Restart recovery: the accepted intent has its run row, but the stop is still owed.
  env.fake.stopFails = 1
  await env.intents.recoverIntents()
  expect(stops()).toBe(2)
  // An explicit admission retry (the ingest key is already used) still notices the cancellation.
  await env.intents.startRunIntent(request, 'cancel-turn')
  expect(stops()).toBe(3)
  // Confirmed: nothing more is sent.
  await env.intents.recoverIntents()
  await env.intents.startRunIntent(request, 'cancel-turn')
  expect(stops()).toBe(3)
})

test('FV #1: a frozen home delivers no owed Stop and resends no start from recovery; unfrozen, it does', async () => {
  cancelTurn('cancel-frozen')
  env.fake.stopFails = 1
  const request = { profile: 'builder', input: 'fixture' }
  await env.intents.startRunIntent(request, 'cancel-frozen')
  expect(stops()).toBe(1)
  // An accepted start_run intent whose Stop is still owed (the probe of re-review 4, finding 3).
  expect(env.db.sqlite.prepare('SELECT state, stop_state FROM command_intents').get()).toEqual({
    state: 'accepted',
    stop_state: 'pending',
  })
  // And a start that never got an answer.
  env.db.sqlite
    .prepare(
      `INSERT INTO command_intents (id, kind, idempotency_key, payload, state, created_at, updated_at)
       SELECT 'ci-open', kind, 'open-turn', payload, 'sent', created_at, updated_at FROM command_intents LIMIT 1`,
    )
    .run()
  const calls = env.fake.calls.length
  let holding: string | null = 'Score is holding all agent work: this folder is a copy.'
  const frozen = new RunIntents({
    db: env.db,
    gateway: env.gateway,
    sink: env.ingest,
    frozen: () => holding,
  })
  await frozen.recoverIntents()
  expect(stops()).toBe(1)
  expect(env.fake.calls.length).toBe(calls)
  holding = null
  await frozen.recoverIntents()
  expect(stops()).toBe(2)
})

test('FU #3: a frozen home sends no start and no cancellation Stop through normal dispatch either; refusals are 423', async () => {
  let holding: string | null = 'Score is holding all agent work: this folder is a copy.'
  const frozen = new RunIntents({
    db: env.db,
    gateway: env.gateway,
    sink: env.ingest,
    frozen: () => holding,
  })
  const request = { profile: 'builder', input: 'fixture' }
  // The probe of re-review 5: a fresh dispatch reached the gateway. Now it is refused and no intent is recorded.
  await expect(frozen.startRunIntent(request, 'fresh-turn')).rejects.toMatchObject({
    status: 423,
    code: 'execution_frozen',
  })
  expect(env.fake.creations).toBe(0)
  expect(env.db.sqlite.prepare('SELECT count(*) AS n FROM command_intents').get()).toEqual({ n: 0 })
  // An inherited cancelled reply whose start was accepted by the source: the owed Stop is not delivered.
  cancelTurn('inherited')
  env.fake.stopFails = 1
  await env.intents.startRunIntent(request, 'inherited')
  expect(stops()).toBe(1)
  await frozen.startRunIntent(request, 'inherited')
  expect(stops()).toBe(1)
  // An unfinished intent replayed through the normal path is refused too.
  env.db.sqlite
    .prepare(
      `INSERT INTO command_intents (id, kind, idempotency_key, payload, state, created_at, updated_at)
       SELECT 'ci-open', kind, 'open-turn', payload, 'sent', created_at, updated_at FROM command_intents LIMIT 1`,
    )
    .run()
  const creations = env.fake.creations
  await expect(frozen.startRunIntent(request, 'open-turn')).rejects.toMatchObject({ status: 423 })
  expect(env.fake.creations).toBe(creations)
  holding = null
  await frozen.startRunIntent(request, 'fresh-turn')
  expect(env.fake.creations).toBe(creations + 1)
})
