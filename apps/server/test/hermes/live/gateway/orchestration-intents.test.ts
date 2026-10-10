import { rmSync } from 'node:fs'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { setup } from './helpers.ts'

// Orchestration dispatches (PLAN 7.5a): the executor owns their recovery, and the per-turn capability reaches Hermes
// only in the wire payload, never in the stored intent.

let env: ReturnType<typeof setup>
beforeEach(() => {
  env = setup()
})
afterEach(async () => {
  await env.ingest.close()
  env.db.close()
  rmSync(env.home, { recursive: true, force: true })
})

const capability = `orc_${'Z'.repeat(43)}`
const stored = 'Lead turn. Capability: {{SCORE_ORCHESTRATION_CAPABILITY}}'

test('the rendered capability goes to Hermes, the stored intent keeps the placeholder', async () => {
  await env.intents.startRunIntent({ profile: 'builder', input: stored }, 'orc-turn-1', {
    owner: 'orchestration',
    render: (input) => input.replaceAll('{{SCORE_ORCHESTRATION_CAPABILITY}}', capability),
  })
  const create = env.fake.calls.find(
    (call) => call.path.endsWith('/v1/runs') && call.method === 'POST',
  )!
  expect((create.body as { input: string }).input).toContain(capability)
  const row = env.db.sqlite.prepare('SELECT payload, owner FROM command_intents').get() as {
    payload: string
    owner: string
  }
  expect(row.owner).toBe('orchestration')
  expect(row.payload).toContain('{{SCORE_ORCHESTRATION_CAPABILITY}}')
  expect(row.payload).not.toContain(capability)
  expect(JSON.stringify(env.db.sqlite.prepare('SELECT * FROM runs').all())).not.toContain(
    capability,
  )
})

test('generic intent recovery never resends an orchestration intent, even one left sent or unknown', async () => {
  env.fake.crashAfterAdmission = true
  await expect(
    env.intents.startRunIntent({ profile: 'builder', input: stored }, 'orc-turn-2', {
      owner: 'orchestration',
      render: (input) => input.replaceAll('{{SCORE_ORCHESTRATION_CAPABILITY}}', capability),
    }),
  ).rejects.toMatchObject({ code: 'transport_error' })
  expect(env.fake.creations).toBe(1)
  // An ordinary intent in the same state is recovered; the orchestration one is not.
  env.db.sqlite.prepare("UPDATE command_intents SET state = 'sent'").run()
  const before = env.fake.calls.length
  await env.intents.recoverIntents()
  expect(env.fake.calls).toHaveLength(before)
  expect(env.db.sqlite.prepare('SELECT state, attempts FROM command_intents').get()).toEqual({
    state: 'sent',
    attempts: 1,
  })
})
