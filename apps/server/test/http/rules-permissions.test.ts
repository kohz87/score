import {
  AgentPermissionsResponseSchema,
  RulesResponseSchema,
  RulesWriteResponseSchema,
} from '@score/contract'
import { expect, test } from 'vitest'

import { createRulesHelpers, rulesTestSuite, type RulesTestState } from './rules-helpers.ts'

let env: RulesTestState['env']
let app: RulesTestState['app']
let cookie: RulesTestState['cookie']
let extraHome: RulesTestState['extraHome']
const current = (): RulesTestState => ({ env, app, cookie, extraHome })
rulesTestSuite((next) => {
  env = next.env
  app = next.app
  cookie = next.cookie
  extraHome = next.extraHome
}, current)

const { call, rules, permissions, team, del } = createRulesHelpers(current)

test('PATCH may only make an agent stricter than the team', async () => {
  await call('PUT', '/api/settings/rules', team)
  const patch = (agent: string, id: string, level: string) =>
    call('PATCH', `/api/agents/${agent}/permissions/${encodeURIComponent(id)}`, { level })

  // Stricter: take a Go-ahead back, add a Never.
  const asks = await patch('builder', 'SQL DROP', 'asks')
  expect(asks.statusCode).toBe(200)
  expect(asks.json()).toMatchObject({ id: 'SQL DROP', level: 'asks' })
  const added = await patch('builder', 'never:rm -rf /tmp/*', 'never')
  expect(added.statusCode).toBe(200)
  expect(added.json()).toMatchObject({
    id: 'never:rm -rf /tmp/*',
    level: 'never',
    inherited: false,
  })
  const builder = await permissions('builder')
  expect(builder.map((p) => p.id)).not.toContain('SQL DROP')
  expect(builder.find((p) => p.id === 'never:rm -rf /tmp/*')).toMatchObject({ inherited: false })
  expect(builder.find((p) => p.id === 'recursive delete')).toMatchObject({ inherited: true })
  expect((await permissions('lead')).map((p) => p.id)).toContain('SQL DROP')

  // Loosening is rejected, and nothing changes.
  for (const [agent, id, level] of [
    ['builder', 'SQL DROP', 'allowed'], // re-adding a Go-ahead
    ['lead', 'git force push (rewrites remote history)', 'allowed'], // adding a Go-ahead
    ['lead', 'never:*git* push* --force*', 'asks'], // removing a team Never
    ['lead', 'never:*git* push* --force*', 'allowed'],
    ['builder', 'never:rm -rf /tmp/*', 'asks'], // removing an agent Never
  ] as const) {
    const response = await patch(agent, id, level)
    expect(response.statusCode, `${agent} ${id} ${level}`).toBe(400)
    expect(response.json().error.code).toBe('not_stricter')
  }
  expect((await permissions('lead')).map((p) => p.id)).toContain('never:*git* push* --force*')
  expect((await permissions('builder')).map((p) => p.id)).not.toContain('SQL DROP')

  // Other bad input.
  expect((await patch('builder', 'no such category', 'asks')).statusCode).toBe(400)
  expect((await patch('builder', 'SQL DROP', 'never')).statusCode).toBe(400)
  expect((await patch('builder', 'never:*', 'never')).statusCode).toBe(400)
  expect((await patch('nobody', 'SQL DROP', 'asks')).statusCode).toBe(404)
  expect(
    (
      await call(
        'PATCH',
        '/api/agents/builder/permissions/SQL%20DROP',
        { level: 'asks' },
        { 'x-score-client': 'web' },
      )
    ).statusCode,
  ).toBe(401)
})

test('per-agent stricter choices survive a later team change; drift shows up and apply fixes it', async () => {
  await call('PUT', '/api/settings/rules', team)
  await call('PATCH', '/api/agents/builder/permissions/SQL%20DROP', { level: 'asks' })
  // The team adds a category and removes its Never; builder keeps its own SQL DROP choice.
  const next = { mode: 'manual', goAhead: ['SQL DROP', 'SQL TRUNCATE'], never: [] }
  const written = RulesWriteResponseSchema.parse(
    (await call('PUT', '/api/settings/rules', next)).json(),
  )
  expect(written.drift.every((d) => !d.differs)).toBe(true)
  expect((await permissions('builder')).map((p) => p.id)).toEqual(['SQL TRUNCATE'])
  expect((await permissions('lead')).map((p) => p.id)).toEqual(['SQL DROP', 'SQL TRUNCATE'])
  expect((await call('POST', '/api/settings/rules/apply/nobody')).statusCode).toBe(404)
  const applied = await call('POST', '/api/settings/rules/apply/builder')
  expect(applied.statusCode).toBe(200)
  expect(RulesResponseSchema.parse(applied.json()).drift.every((d) => !d.differs)).toBe(true)
})

test('DELETE gives an agent back to the team rule, never looser than the team', async () => {
  await call('PUT', '/api/settings/rules', team)
  await call('PATCH', '/api/agents/builder/permissions/SQL%20DROP', { level: 'asks' })
  await call('PATCH', '/api/agents/builder/permissions/never%3Arm%20-rf%20%2Ftmp%2F*', {
    level: 'never',
  })
  const before = (await permissions('builder')).map((p) => p.id)
  expect(before).not.toContain('SQL DROP')
  expect(before).toContain('never:rm -rf /tmp/*')

  // A taken-back Go-ahead returns to the team's.
  const back = await del('builder', 'SQL DROP')
  expect(back.statusCode).toBe(200)
  const restored = AgentPermissionsResponseSchema.parse(back.json()).items
  expect(restored.find((p) => p.id === 'SQL DROP')).toMatchObject({
    level: 'allowed',
    inherited: true,
  })
  // The other override stays; the team's Never stays.
  expect(restored.map((p) => p.id)).toContain('never:rm -rf /tmp/*')
  expect(restored.map((p) => p.id)).toContain('never:*git* push* --force*')

  // An agent-only Never goes away, the team's remains.
  const gone = AgentPermissionsResponseSchema.parse(
    (await del('builder', 'never:rm -rf /tmp/*')).json(),
  ).items
  expect(gone.map((p) => p.id)).not.toContain('never:rm -rf /tmp/*')
  expect(gone.map((p) => p.id)).toContain('never:*git* push* --force*')
  expect((await permissions('builder')).map((p) => p.id)).toEqual(
    (await permissions('lead')).map((p) => p.id),
  )
  expect((await rules()).drift.every((d) => !d.differs)).toBe(true)

  // Each override can only be removed once; team rules are not overrides.
  expect((await del('builder', 'SQL DROP')).statusCode).toBe(400) // now a plain team rule
  expect((await del('builder', 'SQL DROP')).json().error.code).toBe('not_an_override')
  const teamNever = await del('lead', 'never:*git* push* --force*')
  expect(teamNever.statusCode).toBe(400)
  expect(teamNever.json().error.code).toBe('not_an_override')
  expect((await permissions('lead')).map((p) => p.id)).toContain('never:*git* push* --force*')
  expect((await del('builder', 'never:rm -rf /tmp/*')).statusCode).toBe(404)
  expect((await del('builder', 'recursive delete')).statusCode).toBe(400)
  expect((await del('builder', 'SQL TRUNCATE')).statusCode).toBe(404)
  expect((await del('nobody', 'SQL DROP')).statusCode).toBe(404)
  expect((await del('builder', 'SQL DROP', { 'x-score-client': 'web' })).statusCode).toBe(401)
})
