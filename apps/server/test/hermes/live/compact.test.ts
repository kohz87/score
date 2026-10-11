import type { SessionContextReading } from '@score/contract'
import { mkdirSync } from 'node:fs'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { RewindBroker } from '../../../src/hermes/bridge/rewind-broker.ts'
import { compactSession, sessionContext, sessionTip } from '../../../src/hermes/live/compact.ts'
import { createFixtureHome } from '../../fixtures/hermes/sqlite-fixture.ts'

let hermes: ReturnType<typeof createFixtureHome>
beforeEach(() => {
  hermes = createFixtureHome()
  mkdirSync(`${hermes.home}/profiles/builder`, { recursive: true })
  const { db } = hermes.build('state', 'profiles/builder/state.db')
  db.prepare(
    `INSERT INTO sessions (id, source, profile_name, model, started_at, end_reason) VALUES ('score-r-builder', 'api_server', 'builder', 'm', 1, 'compression')`,
  ).run()
  db.prepare(
    `INSERT INTO sessions (id, source, profile_name, model, started_at, parent_session_id) VALUES ('score-r-builder-2', 'api_server', 'builder', 'm', 5, 'score-r-builder')`,
  ).run()
})
afterEach(() => hermes.close())

/** A broker whose plugin answers the next command with `answer` (or stays silent). */
function brokerAnswering(answer: Parameters<RewindBroker['complete']>[2] | null) {
  const broker = new RewindBroker()
  const asked: unknown[] = []
  void (async () => {
    // Listening, then claim and answer.
    await broker.claim('builder', 0, new AbortController().signal)
    const ask = broker.ask.bind(broker)
    broker.ask = async (profile, request, timeout) => {
      const promise = ask(profile, request, timeout)
      asked.push(request)
      const [command] = await broker.claim(profile, 50, new AbortController().signal)
      if (answer && command) broker.complete(profile, command.commandId, answer)
      return promise
    }
  })()
  return { broker, asked }
}

test('the tip of the compression lineage is compacted, and a missing session is refused', async () => {
  expect(sessionTip({ profile: 'builder', sessionId: 'score-r-builder' }, hermes.home)).toBe(
    'score-r-builder-2',
  )
  expect(sessionTip({ profile: 'builder', sessionId: 'nope' }, hermes.home)).toBeNull()
  expect(sessionTip({ profile: '../x', sessionId: 'score-r-builder' }, hermes.home)).toBeNull()
  const { broker, asked } = brokerAnswering({
    outcome: 'done',
    before: { messages: 10, tokens: 5000 },
    after: { messages: 4, tokens: 900 },
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(
    await compactSession(
      { agentId: 'builder', sessionId: 'score-r-builder', keepRecent: 2 },
      { broker, hermesHome: hermes.home },
    ),
  ).toEqual({
    status: 'compacted',
    before: { messages: 10, tokens: 5000 },
    after: { messages: 4, tokens: 900 },
  })
  expect(asked).toEqual([{ kind: 'compact', sessionId: 'score-r-builder-2', keepRecent: 2 }])
  expect(
    await compactSession(
      { agentId: 'builder', sessionId: 'nope' },
      { broker, hermesHome: hermes.home },
    ),
  ).toEqual({ status: 'failed', reason: 'no_session' })
})

test('refusals map to the contract reasons', async () => {
  const none = { broker: new RewindBroker(), hermesHome: hermes.home }
  expect(await compactSession({ agentId: 'builder', sessionId: 'score-r-builder' }, none)).toEqual({
    status: 'failed',
    reason: 'bridge_unavailable',
  })
  expect(
    await sessionContext({ agentId: 'builder', sessionId: 'score-r-builder' }, none),
  ).toBeNull()
  for (const [answer, expected] of [
    [{ outcome: 'nothing' }, { status: 'nothing' }],
    [
      { outcome: 'failed', error: 'lock_held' },
      { status: 'failed', reason: 'session_busy' },
    ],
    [
      { outcome: 'failed', error: 'compact_failed' },
      { status: 'failed', reason: 'compact_failed' },
    ],
    [{ outcome: 'expired' }, { status: 'failed', reason: 'no_answer' }],
    [{ outcome: 'done' }, { status: 'failed', reason: 'compact_failed' }],
  ] as const) {
    const { broker } = brokerAnswering(answer)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(
      await compactSession(
        { agentId: 'builder', sessionId: 'score-r-builder' },
        { broker, hermesHome: hermes.home },
      ),
    ).toEqual(expected)
  }
})

test('the context query returns the plugin reading and null when it fails', async () => {
  const reading: SessionContextReading = {
    window: 1000,
    used: 10,
    model: 'm',
    source: 'local_estimate',
    autoCompactAt: null,
    parts: [],
  }
  let { broker } = brokerAnswering({ outcome: 'done', context: reading })
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(
    await sessionContext(
      { agentId: 'builder', sessionId: 'score-r-builder' },
      { broker, hermesHome: hermes.home },
    ),
  ).toEqual(reading)
  ;({ broker } = brokerAnswering({ outcome: 'failed', error: 'context_failed' }))
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(
    await sessionContext(
      { agentId: 'builder', sessionId: 'score-r-builder' },
      { broker, hermesHome: hermes.home },
    ),
  ).toBeNull()
})
