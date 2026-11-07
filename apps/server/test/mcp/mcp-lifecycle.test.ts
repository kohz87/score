import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import {
  access,
  call,
  connect,
  db,
  enable,
  post,
  setupMcpTest,
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

test('a lifecycle change revokes access: removed agents and replaced incarnations never keep a token', async () => {
  const life = (state: string, incarnation: string) =>
    db.sqlite
      .prepare(
        `INSERT INTO agent_lifecycle (agent_id, incarnation_id, state, operation_id, display_name) VALUES ('builder', ?, ?, NULL, NULL)
         ON CONFLICT(agent_id) DO UPDATE SET incarnation_id = excluded.incarnation_id, state = excluded.state`,
      )
      .run(incarnation, state)
  const first = randomUUID()
  life('ready', first)
  const token = enable('builder', true)
  const client = await connect(token)
  expect((await call(client, 'knowledge.search', { query: 'x' })).error).toBe(false)
  life('deleting', first)
  expect((await post(token)).status).toBe(401)
  life('removed', first)
  expect((await post(token)).status).toBe(401)
  expect(access.get('builder')).toMatchObject({
    enabled: false,
    writesEnabled: false,
    hasToken: false,
  })
  // Same name, new incarnation: the old token and switches are not inherited.
  life('ready', randomUUID())
  expect((await post(token)).status).toBe(401)
  expect(access.get('builder')).toMatchObject({ enabled: false, writesEnabled: false })
  access.patch('builder', { enabled: true })
  expect(access.get('builder')).toMatchObject({
    enabled: true,
    writesEnabled: false,
    hasToken: false,
  })
  expect((await post(token)).status).toBe(401)
})

test('a session that outlives its agent is refused on the next tool call', async () => {
  const id = randomUUID()
  db.sqlite
    .prepare(
      "INSERT INTO agent_lifecycle (agent_id, incarnation_id, state, operation_id, display_name) VALUES ('builder', ?, 'ready', NULL, NULL)",
    )
    .run(id)
  const client = await connect(enable('builder', true))
  db.sqlite.prepare("UPDATE agent_lifecycle SET state = 'removed'").run()
  for (const [name, args] of [
    ['knowledge.read', { path: 'a.md' }],
    ['rooms.list', {}],
    ['tasks.list', {}],
  ] as const)
    expect(
      await call(client, name, args).then(
        (r) => r.error,
        () => true,
      ),
    ).toBe(true)
})
