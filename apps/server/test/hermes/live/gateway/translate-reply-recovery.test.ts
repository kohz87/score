import { expect, test } from 'vitest'
import { translateRunEvent } from '../../../../src/hermes/live/translate.ts'
import { admittedMessage, env, installTranslateHooks, replyMessage } from './translate-helpers.ts'

installTranslateHooks()

test('a reply cut short (restart, lost replay) is completed from the final output, and its hand-off still happens', async () => {
  const context = await admittedMessage()
  const base = { run_id: context.runId, timestamp: Date.now() / 1000 }
  const events = [
    { ...base, event: 'message.delta', delta: 'I have completed ', seq: 1 },
    // Deltas for "the work. @reviewer please check." never arrived (audit 2026-10-08).
    {
      ...base,
      event: 'run.completed',
      output: 'I have completed the work. @reviewer please check.',
      completed: true,
      partial: false,
      interrupted: false,
      seq: 9,
    },
  ]
  for (const event of events)
    await env.ingest.submit(translateRunEvent(context, event, { unknownEvents: 0 }))
  expect(replyMessage()).toMatchObject({
    streaming: false,
    parts: [{ kind: 'text', text: 'I have completed the work. @reviewer please check.' }],
  })
  const reviewer = env.db.sqlite
    .prepare("SELECT agent_id, hop FROM message_runs WHERE agent_id = 'reviewer'")
    .get()
  expect(reviewer).toMatchObject({ agent_id: 'reviewer', hop: 1 })
})

test('when the final output does not continue the streamed text, the streamed text is kept as is', async () => {
  const context = await admittedMessage()
  const base = { run_id: context.runId, timestamp: Date.now() / 1000 }
  for (const event of [
    { ...base, event: 'message.delta', delta: 'Working on it. ', seq: 1 },
    { ...base, event: 'run.completed', output: 'Different summary.', completed: true, seq: 2 },
  ])
    await env.ingest.submit(translateRunEvent(context, event, { unknownEvents: 0 }))
  expect(replyMessage().parts).toEqual([{ kind: 'text', text: 'Working on it. ' }])
})

test('a failed run leaves a visible notice with the sanitized error in the reply', async () => {
  const context = await admittedMessage()
  await env.ingest.submit(
    translateRunEvent(
      context,
      {
        run_id: context.runId,
        timestamp: 1791290587,
        event: 'run.failed',
        seq: 1,
        error: 'provider auth failed token=abc123secret',
      },
      { unknownEvents: 0 },
    ),
  )
  const text = JSON.stringify(replyMessage().parts)
  expect(text).toContain('This run failed: ')
  expect(text).not.toContain('abc123secret')
})

test('output that diverges after a restart lost held text replaces the streamed text and hands off', async () => {
  const context = await admittedMessage()
  const base = { run_id: context.runId, timestamp: Date.now() / 1000 }
  await env.ingest.submit(
    translateRunEvent(
      context,
      { ...base, event: 'message.delta', delta: 'Done. @rev', seq: 1 },
      { unknownEvents: 0 },
    ),
  )
  // The held "@rev" was sealed by the previous process: simulate it with an unreadable value.
  env.db.sqlite
    .prepare("UPDATE message_runs SET pending = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'")
    .run()
  const output = 'Done. @reviewer please review.'
  for (const event of [
    { ...base, event: 'message.delta', delta: 'iewer please review.', seq: 2 },
    { ...base, event: 'run.completed', output, seq: 3 },
  ])
    await env.ingest.submit(translateRunEvent(context, event, { unknownEvents: 0 }))
  expect(replyMessage().parts).toEqual([{ kind: 'text', text: output }])
  expect(
    env.db.sqlite.prepare("SELECT hop FROM message_runs WHERE agent_id = 'reviewer'").get(),
  ).toMatchObject({ hop: 1 })
})
