import { expect, test } from 'vitest'
import { translateRunEvent } from '../../../../src/hermes/live/translate.ts'
import {
  admitted,
  admittedMessage,
  env,
  installTranslateHooks,
  replyMessage,
} from './translate-helpers.ts'

installTranslateHooks()

test('Hermes 0.22.5 authority approvals: prompt_id is the request id, timeout_s the expiry, approval.settled is known', async () => {
  const context = await admitted()
  const metrics = { unknownEvents: 0 }
  const base = { run_id: context.runId, timestamp: 1791290587 }
  await env.ingest.submit(
    translateRunEvent(
      context,
      {
        ...base,
        seq: 0,
        event: 'approval.request',
        kind: 'approval',
        prompt_id: 'prompt-authority-1',
        execution_generation: 2,
        command: 'rm -rf /tmp/x',
        description: 'recursive delete',
        choices: ['once', 'session', 'always', 'deny'],
        timeout_s: 300,
      },
      metrics,
    ),
  )
  const approval = env.db.sqlite
    .prepare('SELECT request_id, expires_at FROM approvals WHERE run_id = ?')
    .get(context.runId) as { request_id: string; expires_at: string }
  expect(approval.request_id).toBe('prompt-authority-1')
  expect(approval.expires_at).toBe(new Date((1791290587 + 300) * 1000).toISOString())
  await env.ingest.submit(
    translateRunEvent(
      context,
      {
        ...base,
        seq: 1,
        event: 'approval.settled',
        prompt_id: 'prompt-authority-1',
        execution_generation: 2,
      },
      metrics,
    ),
  )
  expect(metrics.unknownEvents).toBe(0)
  // Neither id: still refused, as before.
  expect(() =>
    translateRunEvent(
      context,
      {
        ...base,
        seq: 2,
        event: 'approval.request',
        command: 'x',
        description: 'y',
        choices: ['deny'],
      },
      metrics,
    ),
  ).toThrow()
})

test('Hermes 0.22.5 clarify (decision 128): a question is recorded once, settled when Hermes stops waiting, and closed with the run', async () => {
  const context = await admitted()
  const metrics = { unknownEvents: 0 }
  const base = { run_id: context.runId, timestamp: 1791290587 }
  const send = (seq: number, body: object) =>
    env.ingest.submit(translateRunEvent(context, { ...base, seq, ...body }, metrics))
  const question = {
    event: 'clarify.request',
    kind: 'clarify',
    prompt_id: 'clarify-1',
    execution_generation: 3,
    question: 'Which branch?',
    choices: ['main', 'dev'],
    multi_select: false,
    timeout_s: 600,
  }
  await send(0, question)
  await send(1, question)
  const rows = () =>
    env.db.sqlite
      .prepare(
        'SELECT prompt_id, generation, options, status, answered_by, expires_at FROM agent_questions',
      )
      .all()
  expect(rows()).toEqual([
    {
      prompt_id: 'clarify-1',
      generation: 3,
      options: '["main","dev"]',
      status: 'pending',
      answered_by: null,
      expires_at: new Date((1791290587 + 600) * 1000).toISOString(),
    },
  ])
  await send(2, { event: 'clarify.settled', prompt_id: 'clarify-1', execution_generation: 3 })
  expect(rows()).toMatchObject([{ status: 'withdrawn', answered_by: 'elsewhere' }])
  await send(3, { ...question, prompt_id: 'clarify-2' })
  for (const [seq, event] of [
    [4, 'run.queued'],
    [5, 'run.steered'],
    [6, 'tool.progress'],
  ] as const)
    await send(seq, { event })
  expect(metrics.unknownEvents).toBe(0)
  await send(7, { event: 'run.completed', output: 'done' })
  expect(rows()).toMatchObject([{ status: 'withdrawn' }, { status: 'withdrawn' }])
})

test('Hermes 0.22.5: a turn that used up its steps keeps its summary and says so (decision 128)', async () => {
  const context = await admittedMessage()
  await env.ingest.submit(
    translateRunEvent(
      context,
      {
        run_id: context.runId,
        timestamp: 1791290587,
        seq: 0,
        event: 'run.failed',
        output: 'Summary so far: half the files are migrated.',
        completed: false,
        partial: false,
        turn_exit_reason: 'max_iterations_reached(90/90)',
      },
      { unknownEvents: 0 },
    ),
  )
  const text = JSON.stringify(replyMessage().parts)
  expect(text).toContain('Summary so far')
  expect(text).toContain('ran out of steps for this turn (90 tool calls)')
  expect(text).not.toContain('This run failed')
})
