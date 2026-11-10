import { rmSync } from 'node:fs'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { RunIntents } from '../../../../src/hermes/live/intents.ts'
import { setup } from './helpers.ts'

// Decision 178: a chat's effort reaches Hermes as the run's own `model_options`, never as the agent's config.
let env: ReturnType<typeof setup>
beforeEach(() => {
  env = setup()
})
afterEach(async () => {
  await env.ingest.close()
  env.db.close()
  rmSync(env.home, { recursive: true, force: true })
})

const intents = () => new RunIntents({ db: env.db, gateway: env.gateway, sink: env.ingest })
const lastBody = () =>
  env.fake.calls.findLast((call) => call.path.endsWith('/v1/runs'))!.body as Record<string, unknown>

test('a chat’s effort goes with the run, and only when set', async () => {
  await intents().startRunIntent(
    { profile: 'builder', input: 'Fix it', effort: 'high' },
    'turn-effort-1',
  )
  expect(lastBody().model_options).toEqual({ reasoning_effort: 'high' })
  await intents().startRunIntent({ profile: 'builder', input: 'Fix it' }, 'turn-effort-2')
  expect(lastBody()).not.toHaveProperty('model_options')
})

test('the same turn asked again at another effort is a different request', async () => {
  await intents().startRunIntent(
    { profile: 'builder', input: 'Fix it', effort: 'high' },
    'turn-effort-3',
  )
  await expect(
    intents().startRunIntent(
      { profile: 'builder', input: 'Fix it', effort: 'low' },
      'turn-effort-3',
    ),
  ).rejects.toThrow('different request')
})
