import fs from 'node:fs'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { JOURNEY_MAX_EVENTS_PER_AGENT, JourneySchema } from '@score/contract'
import { reconcileAgents } from '../../src/domain/agents.ts'
import { computeJourney } from '../../src/domain/journey.ts'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { setup } from '../hermes/live/gateway/helpers.ts'

let env: ReturnType<typeof setup>
let app: ReturnType<typeof buildApp>
let port: FakePort
const now = Date.parse('2026-03-10T10:00:00Z')

beforeEach(async () => {
  env = setup()
  port = new FakePort(1, { db: env.db }, false, undefined, true)
  await port.start(env.ingest)
  await reconcileAgents(env.ingest, await port.listAgentDetails())
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake' }),
    logger: false,
    port,
    db: env.db,
    ingest: env.ingest,
    clock: () => now,
  })
})
afterEach(async () => {
  await app.close()
  await port.stop()
  await env.ingest.close()
  env.db.close()
  fs.rmSync(env.home, { recursive: true, force: true })
})

test('the journey has one row per agent, newest first, with the four kinds of marks', async () => {
  const response = await app.inject('/api/reports/journey?from=2026-02-09&to=2026-03-10&tz=UTC')
  expect(response.statusCode).toBe(200)
  const journey = JourneySchema.parse(response.json())
  expect(journey.agents.map((agent) => agent.id)).toEqual([
    'builder',
    'designer',
    'lead',
    'reviewer',
  ])
  const kinds = new Set(journey.agents.flatMap((agent) => agent.events.map((event) => event.kind)))
  expect(kinds).toEqual(new Set(['task_done', 'note_written', 'skill_changed', 'memory_changed']))
  for (const agent of journey.agents) {
    const times = agent.events.map((event) => event.at)
    expect(times).toEqual([...times].sort().reverse())
    for (const event of agent.events) {
      expect(Date.parse(event.at)).toBeLessThanOrEqual(now)
      if (event.kind === 'memory_changed') expect(event.label).toBe('Memory file changed')
    }
  }
})

test('notes whose latest author is an agent become marks; the window limits them', async () => {
  const insert = env.db.sqlite.prepare(
    `INSERT INTO knowledge_notes (path, title, mtime_ms, size, hash, frontmatter_json, last_author)
     VALUES (?, ?, ?, 1, 'h', '{}', ?)`,
  )
  insert.run('a.md', 'Agent note', Date.parse('2026-03-09T12:00:00Z'), 'agent:builder')
  insert.run('b.md', 'Your note', Date.parse('2026-03-09T12:00:00Z'), 'you')
  insert.run('c.md', 'Old note', Date.parse('2026-01-01T12:00:00Z'), 'agent:builder')
  const journey = JourneySchema.parse(
    (await app.inject('/api/reports/journey?from=2026-03-09&to=2026-03-10&tz=UTC')).json(),
  )
  const notes = journey.agents.flatMap((agent) =>
    agent.events.filter((event) => event.label.endsWith('note')),
  )
  expect(notes).toEqual([
    { at: '2026-03-09T12:00:00.000Z', kind: 'note_written', label: 'Agent note', ref: 'a.md' },
  ])
})

test.each([
  '',
  '?from=2026-03-10',
  '?from=2026-03-11&to=2026-03-12',
  '?from=2026-03-10&to=2026-03-09',
  '?from=2025-01-01&to=2026-03-10',
  '?from=2026-03-09&to=2026-03-10&x=1',
  '?from=2026-03-09&to=2026-03-10&tz=Nowhere/Land',
])('a bad journey query %s is a 400', async (query) => {
  expect((await app.inject(`/api/reports/journey${query}`)).statusCode).toBe(400)
})

test('bounds: 500 events per agent and 2,000 in all, newest kept, so a busy agent cannot hide the others', () => {
  const window = { from: 0, to: 10_000_000 }
  const tasks = (agentId: string, count: number) =>
    Array.from({ length: count }, (_, i) => ({
      agentId,
      at: (agentId === 'e' ? 9000 : 1000) + i,
      id: `${agentId}-${i}`,
    }))
  const journey = computeJourney({
    from: '2026-03-09',
    to: '2026-03-10',
    window,
    agentIds: ['a', 'b', 'c', 'd', 'e'],
    facts: {
      tasks: [
        ...tasks('a', 900),
        ...tasks('b', 600),
        ...tasks('c', 500),
        ...tasks('d', 500),
        ...tasks('e', 3),
      ],
      skills: [],
      memory: [],
    },
    titles: new Map(),
    notes: [],
  })
  expect(journey.truncated).toBe(true)
  const sizes = journey.agents.map((agent) => agent.events.length)
  expect(Math.max(...sizes)).toBeLessThanOrEqual(JOURNEY_MAX_EVENTS_PER_AGENT)
  expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(2000)
  expect(journey.agents.find((agent) => agent.id === 'e')!.events).toHaveLength(3)
  expect(journey.agents[0]!.events[0]!.ref).toBe('a-899')
})
