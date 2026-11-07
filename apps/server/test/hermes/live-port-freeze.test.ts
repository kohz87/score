import { expect, test } from 'vitest'
import type { LivePortOptions } from '../../src/hermes/live/live-port.ts'
import { readRun } from '../../src/hermes/live/translate.ts'
import { createLivePort, installLivePortHooks, type LivePortEnv } from './live-port-helpers.ts'

let env: LivePortEnv
let port: ReturnType<typeof createLivePort> | undefined

installLivePortHooks(
  (state) => {
    env = state.env
    port = state.port
  },
  () => ({ env, port }),
)

function create(runner?: LivePortOptions['runner'], frozen?: () => string | null) {
  return (port = createLivePort(env, runner, frozen))
}

test('FU #3: a frozen home refuses every outgoing execution and control call at the port, with the freeze sentence', async () => {
  let holding: string | null = null
  const live = create(undefined, () => holding)
  await live.start(env.ingest)
  const started = await live.startRun({ agentId: 'builder', input: 'hello', turnId: 'before' })
  await expect.poll(() => readRun(env.db.sqlite, started.runId).status).toBe('completed')
  holding = 'Score is holding all agent work: this folder is a copy.'
  expect(live.executionHold()).toBe(holding)
  const calls = env.fake.calls.length
  const refused = { status: 423, code: 'execution_frozen', message: holding }
  await expect(
    live.startRun({ agentId: 'builder', input: 'hello', turnId: 'during' }),
  ).rejects.toMatchObject(refused)
  // The probe of re-review 5: a browser Stop reached the gateway through a copied handle.
  await expect(live.stopRun({ agentId: 'builder', runId: started.runId })).rejects.toMatchObject(
    refused,
  )
  await expect(
    live.deliverDecision({
      approvalId: 'approval',
      origin: 'score-run',
      profile: 'builder',
      runId: started.runId,
      requestId: 'exact-request',
      choice: 'once',
    }),
  ).rejects.toMatchObject({ code: 'execution_frozen', maybeApplied: false })
  expect(env.fake.calls).toHaveLength(calls)
  holding = null
  await live.stopRun({ agentId: 'builder', runId: started.runId })
  expect(env.fake.calls.length).toBeGreaterThan(calls)
})

test('FT #5: a frozen home refuses routine runs and task actions that start work, but not a comment', async () => {
  let holding: string | null = null
  const live = create(undefined, () => holding)
  await live.start(env.ingest)
  holding = 'Score is holding all agent work: this folder is a copy.'
  const refused = { status: 423, code: 'execution_frozen', message: holding }
  await expect(live.runRoutine('builder:r1')).rejects.toMatchObject(refused)
  for (const action of [
    'start',
    'unblock',
    'schedule',
    'request_review',
    'request_changes',
  ] as const)
    await expect(live.taskAction({ taskId: 't_x', action })).rejects.toMatchObject(refused)
  // Not execution: this one reaches the (missing) task and fails for that reason, not with the freeze.
  await expect(
    live.taskAction({ taskId: 't_x', action: 'comment', text: 'hi' }),
  ).rejects.not.toMatchObject({ code: 'execution_frozen' })
})
