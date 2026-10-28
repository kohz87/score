import { expect, test } from 'vitest'
import { agents, events, fullRun, plainRun } from './job-map-fixtures.ts'
import { buildJobMap, formatTokens, logFor } from './job-map-model.ts'

test('a plain job draws only you, the lead and its workers', () => {
  const model = buildJobMap(plainRun, [], agents)
  expect(model.layers).toEqual(['you', 'lead', 'workers'])
  expect(model.advisor).toBeNull()
  expect(model.votes).toBeNull()
  expect(model.swarm).toBeNull()
  expect(model.check).toBeNull()
})

test('a full job draws every layer', () => {
  const model = buildJobMap(fullRun, events, agents)
  expect(model.layers).toEqual(['you', 'lead', 'advisor', 'votes', 'swarm', 'workers', 'check'])
})

test('the lead shows its turn, plan progress and the latest thing it did', () => {
  const { lead } = buildJobMap(fullRun, events, agents)
  expect(lead).toMatchObject({ turn: 9, maxTurns: 30, working: true, doing: 'assigning s5' })
  expect(lead.progress).toBe('4 plan lines · 2 of 5 steps done')
})

test('helper steps are the swarm, one node per helper agent, never the workers', () => {
  const model = buildJobMap(fullRun, events, agents)
  expect(model.swarm?.map((node) => [node.name, node.role, node.tone])).toEqual([
    ['designer', 'audit', 'run'],
    ['reviewer', 'grep', 'done'],
  ])
  expect(model.workers.map((node) => node.name)).toEqual(['builder', 'reviewer'])
  expect(model.workers[0]?.chips.map((chip) => chip.label)).toEqual([
    's1 ✓',
    's2 ✓',
    's3 stopped',
    's5 running',
  ])
})

test('the advisor counts its checkpoint consults and the workers asks, and the tokens read', () => {
  const model = buildJobMap(fullRun, events, agents)
  expect(model.advisor).toMatchObject({ consults: 3, tokens: 18000, mode: 'on_call' })
  expect(model.advisor?.marks.map((mark) => mark.used)).toEqual([true, false, false])
  expect(model.workers[0]?.asked).toEqual({
    count: 2,
    tokens: 18000,
    questions: ['which file?', 'retry how?'],
  })
  expect(model.workers[1]?.asked).toBeNull()
  expect(formatTokens(18000)).toBe('18k')
  expect(formatTokens(900)).toBe('900')
})

test('the votes layer shows the last three votes', () => {
  const model = buildJobMap(fullRun, events, agents)
  expect(model.votes?.rows.map((row) => [row.id, row.label])).toEqual([
    ['q2', 'sharp'],
    ['q3', 'split'],
    ['q4', 'voting'],
  ])
  expect(model.votes?.voting).toBe(true)
})

test('work flows into the layers that are active right now', () => {
  expect([...buildJobMap(fullRun, events, agents).active].sort()).toEqual(
    ['lead', 'swarm', 'votes', 'workers'].sort(),
  )
})

test('the log carries the worker asks and filters by layer', () => {
  const model = buildJobMap(fullRun, events, agents)
  expect(logFor(model, null).length).toBe(8)
  expect(logFor(model, 'advisor').map((line) => line.text)).toContain(
    'builder asked the advisor: which file?',
  )
  expect(logFor(model, 'swarm').map((line) => line.text)).toEqual(['designer audits the diff'])
  expect(logFor(model, 'check').map((line) => line.text)).toEqual(['run the check'])
  expect(logFor(model, 'workers').map((line) => line.text)).toEqual(['builder finished s1'])
  // The phone has no advisor node, so the lead's click covers both.
  expect(logFor(model, 'lead', { phone: true }).length).toBeGreaterThan(
    logFor(model, 'lead').length,
  )
})
