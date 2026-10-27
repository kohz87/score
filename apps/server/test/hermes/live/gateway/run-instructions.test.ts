import { rmSync } from 'node:fs'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { SCORE_RENDERING_NOTE } from '../../../../src/hermes/live/gateway.ts'
import { setup } from './helpers.ts'

// 3.7.11 (decision 141): every new run tells the agent Score renders Markdown; the note is frozen in the intent, so a
// start recovered after an upgrade sends the body it first sent (Hermes fingerprints the body for the idempotency key).

let env: ReturnType<typeof setup>
beforeEach(() => {
  env = setup()
})
afterEach(async () => {
  await env.ingest.close()
  env.db.close()
  rmSync(env.home, { recursive: true, force: true })
})
const runPosts = () => env.fake.calls.filter((call) => call.path.endsWith('/v1/runs'))
const payload = () =>
  JSON.parse(
    (env.db.sqlite.prepare('SELECT payload FROM command_intents').get() as { payload: string })
      .payload,
  ) as Record<string, unknown>

test('a new run carries the Markdown note, and its intent keeps it', async () => {
  await env.intents.startRunIntent({ profile: 'builder', input: 'hello' }, 'markdown-turn')
  expect(runPosts().at(-1)?.body).toMatchObject({
    input: 'hello',
    instructions: SCORE_RENDERING_NOTE,
  })
  expect(payload().instructions).toBe(SCORE_RENDERING_NOTE)
})

test('a start stored before the note existed is re-sent without it, so Hermes replays it', async () => {
  await env.intents.startRunIntent({ profile: 'builder', input: 'hello' }, 'old-turn')
  const old = payload()
  delete old.instructions
  env.db.sqlite
    .prepare("UPDATE command_intents SET payload = ?, state = 'sent'")
    .run(JSON.stringify(old))
  const before = runPosts().length
  await env.intents.recoverIntents()
  expect(runPosts().length).toBeGreaterThan(before)
  expect(runPosts().at(-1)?.body).not.toHaveProperty('instructions')
  expect(runPosts().at(-1)?.body).toMatchObject({ input: 'hello' })
})
