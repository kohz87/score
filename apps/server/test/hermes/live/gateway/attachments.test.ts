import { rmSync } from 'node:fs'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { IMAGE_BUDGET_BYTES } from '../../../../src/hermes/live/attachments.ts'
import { RunIntents } from '../../../../src/hermes/live/intents.ts'
import { setup } from './helpers.ts'

let env: ReturnType<typeof setup>
beforeEach(() => {
  env = setup()
})
afterEach(async () => {
  await env.ingest.close()
  env.db.close()
  rmSync(env.home, { recursive: true, force: true })
})

const store = new Map<string, Uint8Array>()
function intents() {
  return new RunIntents({
    db: env.db,
    gateway: env.gateway,
    sink: env.ingest,
    imageReader: (id) => {
      const bytes = store.get(id)
      return bytes ? { contentType: 'image/png', bytes } : null
    },
  })
}
const lastBody = () =>
  env.fake.calls.findLast((call) => call.path.endsWith('/v1/runs'))!.body as {
    input: unknown
  }

test('images are sent as a user message with image_url data parts; the intent holds ids only', async () => {
  store.set('m1', Buffer.from('first'))
  store.set('m2', Buffer.from('second'))
  await intents().startRunIntent(
    { profile: 'builder', input: 'look', images: ['m1', 'm2'] },
    'img-turn',
  )
  expect(lastBody().input).toEqual([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${Buffer.from('first').toString('base64')}` },
        },
        {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${Buffer.from('second').toString('base64')}` },
        },
      ],
    },
  ])
  const payload = (
    env.db.sqlite.prepare('SELECT payload FROM command_intents').get() as { payload: string }
  ).payload
  expect(JSON.parse(payload).images).toEqual(['m1', 'm2'])
  expect(payload).not.toContain(Buffer.from('first').toString('base64'))
})

test('no images keeps the plain string input', async () => {
  await intents().startRunIntent({ profile: 'builder', input: 'plain' }, 'plain-turn')
  expect(lastBody().input).toBe('plain')
})

test('an over-budget set sends what fits plus a note; a missing item is skipped with a note', async () => {
  store.set('big1', Buffer.alloc(IMAGE_BUDGET_BYTES - 10))
  store.set('big2', Buffer.alloc(100))
  await intents().startRunIntent(
    { profile: 'builder', input: 'look', images: ['big1', 'big2', 'gone'] },
    'budget-turn',
  )
  const content = (lastBody().input as { content: { type: string; text?: string }[] }[])[0]!.content
  expect(content.filter((part) => part.type === 'image_url')).toHaveLength(1)
  expect(content[0]!.text).toBe(
    'look\n\n(1 attached image could not be sent: too large; 1 attached image could not be sent: no longer available)',
  )
})

test('only unavailable images leaves text plus a note', async () => {
  await intents().startRunIntent(
    { profile: 'builder', input: 'look', images: ['gone'] },
    'gone-turn',
  )
  expect(lastBody().input).toBe('look\n\n(1 attached image could not be sent: no longer available)')
})

test('a crash retry re-reads the bytes from the media store', async () => {
  store.set('r1', Buffer.from('retry-bytes'))
  env.fake.crashAfterAdmission = true
  await expect(
    intents().startRunIntent({ profile: 'builder', input: 'look', images: ['r1'] }, 'retry-turn'),
  ).rejects.toThrow()
  env.db.sqlite.prepare("UPDATE command_intents SET state = 'sent'").run()
  const before = env.fake.calls.length
  env.fake.crashAfterAdmission = false
  await intents().recoverIntents()
  const retry = env.fake.calls.slice(before).find((call) => call.path.endsWith('/v1/runs'))!
  expect(JSON.stringify(retry.body)).toContain(Buffer.from('retry-bytes').toString('base64'))
  // Changing the image set under the same turn id is a different request.
  await expect(
    intents().startRunIntent({ profile: 'builder', input: 'look', images: ['r2'] }, 'retry-turn'),
  ).rejects.toThrow('different request')
})

test('a rendered capability reaches Hermes in the text part of an image turn too (11.1b review)', async () => {
  store.set('m1', Buffer.from('first'))
  const capability = `xtc_${'Q'.repeat(43)}`
  await intents().startRunIntent(
    { profile: 'builder', input: 'look {{SCORE_EXCHANGE_CAPABILITY}}', images: ['m1'] },
    'img-xtc-turn',
    { render: (input) => input.replaceAll('{{SCORE_EXCHANGE_CAPABILITY}}', capability) },
  )
  const [message] = lastBody().input as { content: { type: string; text?: string }[] }[]
  expect(message!.content[0]).toEqual({ type: 'text', text: `look ${capability}` })
  const payload = (
    env.db.sqlite.prepare('SELECT payload FROM command_intents').get() as { payload: string }
  ).payload
  expect(payload).not.toContain(capability)
})
