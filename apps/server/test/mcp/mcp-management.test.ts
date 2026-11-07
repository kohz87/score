import { McpAccessSchema, McpTokenIssuedSchema } from '@score/contract'
import { expect, test } from 'vitest'
import { mcpAddCommand } from '../../src/hermes/index.ts'
import { access, browser, setupMcpTest, type McpTestState } from './mcp-helpers.ts'

let now: number
let failTaskAction = false
const state: McpTestState = {
  get now() {
    return now
  },
  set now(value) {
    now = value
  },
  get failTaskAction() {
    return failTaskAction
  },
  set failTaskAction(value) {
    failTaskAction = value
  },
}
setupMcpTest(state)

test('management routes: need a paired browser; token shown once; command shape; switches', async () => {
  const url = '/api/agents/builder/mcp'
  const initial = McpAccessSchema.parse((await browser.inject({ url })).json())
  expect(initial).toMatchObject({
    enabled: false,
    writesEnabled: false,
    hasToken: false,
    available: false,
    command: null,
  })
  const paired = await browser.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'x-score-client': 'web' },
    payload: { token: browser.pairing.createToken() },
  })
  const headers = {
    'x-score-client': 'web',
    cookie: paired.headers['set-cookie']!.toString().split(';')[0]!,
  }
  expect(
    (await browser.inject({ method: 'PUT', url, payload: { enabled: true } })).statusCode,
  ).toBe(403)
  expect((await browser.inject({ method: 'POST', url: `${url}/token` })).statusCode).toBe(403)
  const on = McpAccessSchema.parse(
    (await browser.inject({ method: 'PUT', url, headers, payload: { enabled: true } })).json(),
  )
  expect(on).toMatchObject({ enabled: true, writesEnabled: false })
  expect(
    (await browser.inject({ method: 'PUT', url, headers, payload: { writesEnabled: 'yes' } }))
      .statusCode,
  ).toBe(400)
  expect((await browser.inject({ method: 'PUT', url, headers, payload: {} })).statusCode).toBe(400)
  const issued = McpTokenIssuedSchema.parse(
    (await browser.inject({ method: 'POST', url: `${url}/token`, headers })).json(),
  )
  expect(issued.access.hasToken).toBe(true)
  expect(JSON.stringify((await browser.inject({ url })).json())).not.toContain(issued.token)
  expect(access.agentForToken(issued.token)).toEqual({ agentId: 'builder' })
  const rotated = McpTokenIssuedSchema.parse(
    (await browser.inject({ method: 'POST', url: `${url}/token`, headers })).json(),
  )
  expect(access.agentForToken(issued.token)).toBeUndefined()
  expect(access.agentForToken(rotated.token)).toEqual({ agentId: 'builder' })
  const revoked = McpAccessSchema.parse(
    (await browser.inject({ method: 'DELETE', url: `${url}/token`, headers })).json(),
  )
  expect(revoked.hasToken).toBe(false)
})

test('the add command is shown as text with no token in it, and refuses unsafe profile names', () => {
  expect(mcpAddCommand('builder', 'http://127.0.0.1:8740/bridge/mcp')).toBe(
    'hermes --profile builder mcp add score --url http://127.0.0.1:8740/bridge/mcp --auth header',
  )
  for (const bad of ['a b', 'x;rm -rf', '$(id)', '-p', '', 'A'.repeat(65)])
    expect(mcpAddCommand(bad, 'http://127.0.0.1:8740/bridge/mcp')).toBeNull()
})
