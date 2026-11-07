import { RulesPreviewResponseSchema, RulesWriteResponseSchema } from '@score/contract'
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

const { call, rules, permissions, team } = createRulesHelpers(current)

test('GET starts from the Hermes defaults: every known category asks, nothing drifts', async () => {
  const view = await rules()
  expect(view).toMatchObject({ mode: 'smart', goAhead: [], never: [] })
  expect(view.askMe.length).toBeGreaterThan(50)
  expect(view.askMe[0]).toMatchObject({ pattern: expect.any(String), readOnly: false })
  expect(view.drift.map((d) => d.agentId).sort()).toEqual([
    'builder',
    'designer',
    'lead',
    'reviewer',
  ])
  expect(view.drift.every((d) => !d.differs)).toBe(true)
})

test('PUT needs a paired human', async () => {
  const response = await call('PUT', '/api/settings/rules', team, { 'x-score-client': 'web' })
  expect(response.statusCode).toBe(401)
})

test('PUT applies the baseline to every profile, normalises globs and fills permissions', async () => {
  const response = await call('PUT', '/api/settings/rules', team)
  expect(response.statusCode).toBe(200)
  const written = RulesWriteResponseSchema.parse(response.json())
  expect(written.failed).toEqual([])
  expect(written.mode).toBe('manual')
  expect(written.goAhead.map((r) => r.id)).toEqual(['SQL DROP', 'recursive delete'])
  expect(written.never).toEqual([
    {
      id: 'never:*git* push* --force*',
      label: '*git* push* --force*',
      pattern: '*git* push* --force*',
      readOnly: false,
    },
  ])
  expect(written.askMe.map((r) => r.id)).not.toContain('SQL DROP')
  expect(written.drift.every((d) => !d.differs)).toBe(true)
  for (const id of ['lead', 'builder']) {
    expect(await permissions(id)).toEqual([
      { id: 'recursive delete', label: 'Recursive delete', level: 'allowed', inherited: true },
      { id: 'SQL DROP', label: 'SQL DROP', level: 'allowed', inherited: true },
      {
        id: 'never:*git* push* --force*',
        label: '*git* push* --force*',
        level: 'never',
        inherited: true,
      },
    ])
  }
})

test('PUT validates: unknown categories, bare wildcards, newlines and extra fields are 400', async () => {
  for (const body of [
    { ...team, goAhead: ['made up category'] },
    { ...team, never: ['*'] },
    { ...team, never: ['  ** ?? '] },
    { ...team, never: ['git\npush*'] },
    { ...team, mode: 'yolo' },
    { ...team, askMe: [] },
  ])
    expect((await call('PUT', '/api/settings/rules', body)).statusCode).toBe(400)
  expect((await rules()).mode).toBe('smart')
})

test('dryRun previews a diff and writes nothing', async () => {
  const response = await call('PUT', '/api/settings/rules?dryRun=1', team)
  expect(response.statusCode).toBe(200)
  const { preview } = RulesPreviewResponseSchema.parse(response.json())
  expect(preview).toContain('+mode: manual')
  expect(preview).toContain('+go ahead: SQL DROP')
  expect(preview).toContain('+never: *git* push* --force*')
  expect((await rules()).mode).toBe('smart')
  expect(await permissions('builder')).toEqual([])
})

test('commands Hermes always blocks are neither offered nor accepted as Go ahead', async () => {
  const view = await rules()
  expect(view.askMe.map((rule) => rule.pattern)).not.toContain('fork bomb')
  expect(view.askMe.map((rule) => rule.pattern)).not.toContain('kill all processes')
  const refused = await call('PUT', '/api/settings/rules', {
    mode: 'manual',
    goAhead: ['fork bomb'],
    never: [],
  })
  expect(refused.statusCode).toBe(400)
  expect(refused.json()).toMatchObject({ error: { code: 'always_blocked' } })
})
