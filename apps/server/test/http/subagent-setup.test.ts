import { SubagentSetupSchema } from '@score/contract'
import { afterEach, expect, test } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { createHermesPort } from '../../src/hermes/index.ts'

const apps: ReturnType<typeof buildApp>[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
})

function start() {
  const config = loadConfig({ SCORE_MODE: 'fake', SCORE_FAKE_LOOP: 'false' })
  const app = buildApp({ config, port: createHermesPort(config) })
  apps.push(app)
  return app
}

test('anyone can read the setup; every Hermes agent is listed', async () => {
  const response = await start().inject({ method: 'GET', url: '/api/subagent-setup' })
  expect(response.statusCode).toBe(200)
  const { agents } = SubagentSetupSchema.parse(response.json())
  expect(agents.map((agent) => agent.agentId)).toContain('builder')
  expect(agents.every((agent) => agent.inline && agent.guard)).toBe(true)
})

test('applying needs a paired browser', async () => {
  const response = await start().inject({
    method: 'POST',
    url: '/api/subagent-setup/apply',
    headers: { 'x-score-client': 'web' },
    payload: { agentIds: ['builder'] },
  })
  expect(response.statusCode).toBe(401)
})
