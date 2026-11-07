import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import { buildBridgeApp } from '../../src/app.ts'
import { hashMcpToken } from '../../src/mcp/access.ts'
import {
  access,
  bridge,
  browser,
  db,
  enable,
  post,
  setupMcpTest,
  url,
  type McpTestState,
} from './mcp-helpers.ts'

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

test('auth: no token, a malformed one, a bridge-style one, a rotated one and a revoked one all get 401', async () => {
  const token = enable('builder')
  expect((await post(null)).status).toBe(401)
  expect((await post('scm_short')).status).toBe(401)
  expect((await post('A'.repeat(43))).status).toBe(401)
  expect((await post(`scm_${'A'.repeat(43)}`)).status).toBe(401)
  expect((await post(token)).status).toBe(200)
  const rotated = access.issueToken('builder')
  expect((await post(token)).status).toBe(401)
  expect((await post(rotated)).status).toBe(200)
  // Only the hash of the active token is stored.
  const stored = db.sqlite.prepare('SELECT token_hash FROM mcp_access').get() as {
    token_hash: string | null
  }
  expect(stored.token_hash).toBe(hashMcpToken(rotated))
  expect(JSON.stringify(db.sqlite.prepare('SELECT * FROM mcp_access').all())).not.toContain(rotated)
  access.revokeToken('builder')
  expect((await post(rotated)).status).toBe(401)
  expect(db.sqlite.prepare('SELECT token_hash FROM mcp_access').get()).toEqual({ token_hash: null })
})

test('browser-style requests are refused: foreign Host, any Origin, other methods', async () => {
  const token = enable('builder')
  expect((await post(token, { origin: 'https://evil.example' })).status).toBe(403)
  const rebound = await bridge.inject({
    method: 'POST',
    url: '/bridge/mcp',
    headers: {
      host: 'evil.example',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  })
  expect(rebound.statusCode).toBe(403)
  expect(
    (await fetch(url, { method: 'GET', headers: { authorization: `Bearer ${token}` } })).status,
  ).toBe(405)
})

test('an MCP token gets 401 on /api and /bridge/v1 paths, and a bridge-listener token kind does not open /bridge/mcp', async () => {
  const token = enable('builder')
  for (const [method, path] of [
    ['GET', '/api/health'],
    ['GET', '/api/rooms'],
    ['GET', '/api/agents/builder/mcp'],
    ['PUT', '/api/agents/builder/mcp'],
    ['POST', '/api/agents/builder/mcp/token'],
    ['POST', '/api/rooms/r1/messages'],
    ['GET', '/api/does-not-exist'],
  ] as const) {
    const res = await browser.inject({
      method,
      url: path,
      headers: { authorization: `Bearer ${token}`, 'x-score-client': 'web' },
      payload: method === 'GET' ? undefined : {},
    })
    expect([method, path, res.statusCode]).toEqual([method, path, 401])
  }
  for (const path of ['hello', 'events', 'knowledge/search', 'knowledge/write']) {
    const res = await bridge.inject({
      method: 'POST',
      url: `/bridge/v1/${path}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect([path, res.statusCode]).toEqual([path, 401])
  }
  // The other direction: a 43-character bridge-style token is no MCP token.
  const bridgeStyle = randomUUID().replaceAll('-', '').padEnd(43, 'a')
  expect((await post(bridgeStyle)).status).toBe(401)
})

test('MCP is not reachable on the browser listener', async () => {
  const token = enable('builder')
  const res = await browser.inject({
    method: 'POST',
    url: '/bridge/mcp',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  })
  expect(res.statusCode).toBe(404)
  expect(res.body).not.toContain('tools')
})

test('MCP is not served on the bridge listener without MCP deps, and the bridge app serves no /api', async () => {
  const plain = buildBridgeApp()
  expect((await plain.inject({ method: 'POST', url: '/bridge/mcp', payload: {} })).statusCode).toBe(
    404,
  )
  expect((await bridge.inject({ method: 'GET', url: '/api/rooms' })).statusCode).toBe(404)
  await plain.close()
})
