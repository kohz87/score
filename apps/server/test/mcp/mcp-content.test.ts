import { expect, test } from 'vitest'
import {
  TOKEN_IN_TEXT,
  call,
  comments,
  connect,
  db,
  enable,
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

test('tokens are redacted in room posts, task comments and knowledge notes, bare or embedded', async () => {
  const client = await connect(enable('builder', true))
  const token = TOKEN_IN_TEXT()
  await call(client, 'rooms.post', { roomId: 'r1', text: token })
  await call(client, 'rooms.post', { roomId: 'r1', text: `the token is ${token}, use it` })
  await call(client, 'tasks.comment', { taskId: 't1', text: `try ${token}` })
  await call(client, 'knowledge.write', { path: 'n.md', body: `key ${token}`, expectedEtag: null })
  expect(JSON.stringify(db.sqlite.prepare('SELECT parts FROM messages').all())).not.toContain(
    'scm_',
  )
  expect(JSON.stringify(comments)).not.toContain('scm_')
  expect((await call(client, 'knowledge.read', { path: 'n.md' })).text).not.toContain('scm_')
  expect(comments[0]?.text).toContain('[redacted]')
})

test('rooms.list previews only visible messages: deleted, edited-away and rewound text never appears', async () => {
  const client = await connect(enable('builder'))
  const add = (id: string, text: string, at: string, extra = '') =>
    db.sqlite
      .prepare(
        `INSERT INTO messages (id, room_id, author_kind, author_agent_id, "to", parts, refs, streaming, created_at, updated_at${extra ? ', deleted_at, version_id' : ''})
         VALUES (?, 'r1', 'agent', 'lead', '[]', ?, '[]', 0, ?, ?${extra ? ", ?, 'v1'" : ''})`,
      )
      .run(id, JSON.stringify([{ kind: 'text', text }]), at, at, ...(extra ? [at] : []))
  const preview = async () =>
    (await call(client, 'rooms.list')).json.rooms[0].lastMessage.preview as string
  add('m1', 'visible old', '2026-10-09T09:00:00.000Z')
  expect(await preview()).toBe('visible old')
  // Deleted newest message.
  db.sqlite
    .prepare("UPDATE messages SET deleted_at = '2026-10-09T09:30:00.000Z' WHERE id = 'm2'")
    .run()
  add('m2', 'withdrawn secret instruction', '2026-10-09T09:10:00.000Z', 'hidden')
  expect(await preview()).toBe('visible old')
  // An edit-and-resend / rewind hides the original and what followed (deleted_at + version_id) while the replacement shows.
  add('m3', 'rewound answer', '2026-10-09T09:20:00.000Z', 'hidden')
  expect(await preview()).toBe('visible old')
  add('m4', 'the replacement', '2026-10-09T09:40:00.000Z')
  expect(await preview()).toBe('the replacement')
  const seen = JSON.stringify((await call(client, 'rooms.list')).json)
  for (const hidden of ['withdrawn', 'rewound answer']) expect(seen).not.toContain(hidden)
})
