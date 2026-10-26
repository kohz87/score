import { BridgeEventsRequestSchema } from '@score/contract'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { event, hello, setup } from './helpers.ts'

let server: ReturnType<typeof setup>
beforeEach(() => {
  server = setup()
})
afterEach(async () => {
  await server.close()
})

test('recorded L5 worker batch projects eight tool lifecycles including nested blocked results', async () => {
  const batch = BridgeEventsRequestSchema.parse(
    JSON.parse(
      readFileSync(new URL('../../fixtures/bridge/l5-worker-batch.json', import.meta.url), 'utf8'),
    ),
  )
  const token = await server.token()
  const response = await server.send(token, batch.events)
  expect(response.statusCode).toBe(200)
  expect(response.json()).toEqual({ ackedThrough: batch.events.length })
  const rows = server.db.sqlite
    .prepare('SELECT * FROM session_tool_calls ORDER BY started_at')
    .all()
  expect(rows).toHaveLength(8)
  expect(rows.filter((row) => row.status === 'blocked')).toHaveLength(1)
  expect(rows.filter((row) => row.status === 'ok')).toHaveLength(7)
  for (const row of rows) {
    expect(row).toMatchObject({
      profile: 'builder',
      kanban_task_id: 'task-1',
      version: 2,
      ended_at: expect.any(String),
      duration_ms: expect.any(Number),
    })
    expect(Buffer.byteLength(String(row.args_preview))).toBeLessThanOrEqual(2048)
    expect(Buffer.byteLength(String(row.result_preview))).toBeLessThanOrEqual(2048)
  }
  const logs = server.db.sqlite
    .prepare("SELECT data FROM events WHERE type = 'log.line'")
    .all()
    .map((row) => JSON.parse(String(row.data)))
  expect(logs.filter((log) => log.kind === 'tool')).toHaveLength(16)
  expect(logs.filter((log) => log.kind === 'system')).toHaveLength(4)
  expect(logs.filter((log) => log.kind === 'message')).toHaveLength(5)
  expect(server.metrics.unknownHooks).toBe(4)
  expect(server.db.sqlite.prepare('SELECT * FROM tool_calls').all()).toEqual([])
})

test('pre records command digest; terminal state and result are final against delayed pre/post hooks', async () => {
  const token = await server.token()
  const digest = 'a'.repeat(64)
  await server.send(token, [
    event(1, 'pre_tool_call', {
      tool_name: 'terminal',
      args: { command: 'pwd' },
      command_digest: digest,
    }),
  ])
  expect(
    server.db.sqlite.prepare('SELECT status, command_digest FROM session_tool_calls').get(),
  ).toEqual({ status: 'running', command_digest: digest })
  await server.send(token, [
    event(2, 'post_tool_call', {
      tool_name: 'terminal',
      status: 'error',
      result: '{"status":"blocked","password":"planted-password"}',
      duration_ms: 12,
    }),
  ])
  const terminal = server.db.sqlite.prepare('SELECT * FROM session_tool_calls').all()
  expect(terminal[0]).toMatchObject({ status: 'blocked', duration_ms: 12, command_digest: digest })
  await server.send(token, [
    event(3, 'pre_tool_call', { tool_name: 'terminal', args: { command: 'changed' } }),
    event(4, 'post_tool_call', { tool_name: 'terminal', status: 'ok', result: 'late' }),
  ])
  expect(server.db.sqlite.prepare('SELECT * FROM session_tool_calls').all()).toEqual(terminal)
})

test('post without pre can project a terminal tool; errors and object-valued blocked results are recognized', async () => {
  const token = await server.token()
  await server.send(token, [
    event(1, 'post_tool_call', { tool_name: 'terminal', status: 'error', result: 'not JSON' }),
    {
      ...event(2, 'post_tool_call', {
        tool_name: 'terminal',
        status: 'error',
        result: { status: 'blocked' },
      }),
      toolCallId: 'tool-2',
    },
  ])
  expect(
    server.db.sqlite.prepare('SELECT status FROM session_tool_calls ORDER BY tool_call_id').all(),
  ).toEqual([{ status: 'error' }, { status: 'blocked' }])
})

test('approval and human input signals are redacted, deduped, and preserved without creating approvals', async () => {
  const token = await server.token()
  const hooks = [
    'pre_approval_request',
    'post_approval_response',
    'on_human_input_request',
    'on_human_input_resolved',
    'approval.settled',
  ]
  const events = hooks.map((hook, index) =>
    event(index + 1, hook, {
      requestId: 'request-1',
      commandDigest: 'a'.repeat(64),
      token: 'planted-approval-secret',
    }),
  )
  await server.send(token, events)
  await server.send(token, events)
  const signals = server.db.sqlite.prepare('SELECT * FROM approval_signals').all()
  expect(signals).toHaveLength(5)
  for (const signal of signals) {
    expect(signal).toMatchObject({
      producer_id: expect.any(String),
      profile: 'builder',
      session_key: 'gateway-session',
      request_id: 'request-1',
    })
    expect(String(signal.payload)).not.toContain('planted-approval-secret')
    expect(JSON.parse(String(signal.payload))).toMatchObject({
      requestId: 'request-1',
      token: '[redacted]',
    })
  }
  expect(server.db.sqlite.prepare('SELECT type FROM events').all()).toEqual(
    hooks.map(() => ({ type: 'log.line' })),
  )
})

test('gap markers record visible loss and acknowledge covered counters, including ranges arriving after a hole', async () => {
  const token = await server.token()
  await server.send(token, [event(1), event(2)])
  const gap = event(5, 'bridge.gap', { from_counter: 3, to_counter: 5, dropped: 3 })
  expect((await server.send(token, [gap, event(6)])).json()).toEqual({ ackedThrough: 6 })
  expect((await server.send(token, [gap, event(6)])).json()).toEqual({ ackedThrough: 6 })
  expect(server.db.sqlite.prepare('SELECT source, run_id FROM gaps').all()).toEqual([
    { source: `bridge:${hello.incarnation}`, run_id: null },
  ])
  expect(
    server.db.sqlite.prepare("SELECT type FROM events WHERE type = 'gap.recorded'").all(),
  ).toHaveLength(1)
  expect(
    (
      await server.send(token, [
        event(10, 'bridge.gap', { from_counter: 9, to_counter: 10, dropped: 2 }),
      ])
    ).json(),
  ).toEqual({ ackedThrough: 6 })
  expect((await server.send(token, [event(7), event(8)])).json()).toEqual({ ackedThrough: 10 })
})

test('capture loss marker can cover earlier counters and itself precede its envelope position', async () => {
  const token = await server.token()
  // Sender._take reserves another counter for the summary marker after the lost range.
  expect(
    (
      await server.send(token, [
        event(3, 'bridge.gap', { from_counter: 1, to_counter: 2, dropped: 2 }),
        event(4),
      ])
    ).json(),
  ).toEqual({ ackedThrough: 4 })
})

test('secrets are absent from projections, event log and SQLite bytes; previews redact before byte truncation', async () => {
  const token = await server.token()
  const secret = 'sk-bridgePlantedSecret123456789'
  const args = {
    command: `echo ${secret}`,
    api_key: 'planted-key-value',
    padding: '🙂'.repeat(3000),
  }
  await server.send(token, [
    event(1, 'pre_tool_call', { tool_name: 'terminal', args }),
    event(2, 'post_tool_call', {
      tool_name: 'terminal',
      status: 'ok',
      result: JSON.stringify({
        output: `Bearer ${secret}`,
        password: 'planted-password',
        padding: '🙂'.repeat(3000),
      }),
    }),
    event(3, 'on_interim_message', { text: `token=${secret}` }),
    event(4, 'on_kanban_task_updated', { text: `api_key=${secret}` }),
  ])
  const tool = server.db.sqlite.prepare('SELECT * FROM session_tool_calls').get()!
  expect(Buffer.byteLength(String(tool.args_preview))).toBeLessThanOrEqual(2048)
  expect(Buffer.byteLength(String(tool.result_preview))).toBeLessThanOrEqual(2048)
  const bytes = Buffer.concat(
    ['score.db', 'score.db-wal'].map((file) => readFileSync(join(server.home, file))),
  ).toString()
  for (const planted of [secret, 'planted-key-value', 'planted-password'])
    expect(bytes).not.toContain(planted)
  const logs = server.db.sqlite.prepare('SELECT * FROM events').all()
  expect(logs.filter((row) => row.type === 'log.line')).toHaveLength(4)
  expect(JSON.stringify(logs)).not.toContain(secret)
})

test('credential-file reads keep neither result, error nor content in previews or logs', async () => {
  const token = await server.token()
  await server.send(token, [
    event(1, 'pre_tool_call', {
      tool_name: 'read_file',
      args: { path: '/home/u/.netrc', content: 'password willow-tree-17' },
    }),
    event(2, 'post_tool_call', {
      tool_name: 'read_file',
      status: 'ok',
      args: { path: '/home/u/.netrc' },
      result: '{"content":"machine h login me password willow-tree-17"}',
      error_message: 'password willow-tree-17',
    }),
  ])
  const dump = JSON.stringify([
    server.db.sqlite.prepare('SELECT * FROM session_tool_calls').all(),
    server.db.sqlite.prepare('SELECT data FROM events').all(),
  ])
  expect(dump).not.toContain('willow-tree-17')
  expect(dump).toContain('.netrc')
})

// 2.3.1 (decision 129): Hermes 0.22.5's session hooks.
test('a session Hermes deleted moves its Score room to a successor at once; a deletion the person made is said', async () => {
  const at = '2026-10-26T00:00:00.000Z'
  server.db.sqlite
    .prepare(
      `INSERT INTO rooms (id, name, kind, lead_agent_id, members, created_at, updated_at)
       VALUES ('r1', 'one', 'room', 'lead', '["lead","builder"]', ?, ?)`,
    )
    .run(at, at)
  const token = await server.token()
  await server.send(token, [
    event(1, 'on_session_delete', {
      session_id: 'score-r1-builder',
      reason: 'delete',
      profile: 'builder',
    }),
    // Not a Score session, and an archive: nothing moves.
    event(2, 'on_session_delete', { session_id: 'cli-123', reason: 'delete' }),
    event(3, 'on_session_delete', { session_id: 'score-r1-lead', reason: 'archive' }),
  ])
  expect(
    server.db.sqlite
      .prepare('SELECT agent_id, retired_session_id, successor_session_id FROM session_successors')
      .all(),
  ).toEqual([
    {
      agent_id: 'builder',
      retired_session_id: 'score-r1-builder',
      successor_session_id: 'score-r1-builder~2',
    },
  ])
  const notices = server.db.sqlite
    .prepare("SELECT parts FROM messages WHERE room_id = 'r1' AND author_kind = 'agent'")
    .all() as { parts: string }[]
  expect(notices).toHaveLength(1)
  expect(notices[0]!.parts).toContain('was deleted in Hermes')
  // The sweep of an empty successor moves it on silently; a replay changes nothing.
  await server.send(token, [
    event(4, 'on_session_delete', { session_id: 'score-r1-builder~2', reason: 'empty_sweep' }),
    event(5, 'on_session_delete', { session_id: 'score-r1-builder', reason: 'delete' }),
  ])
  await server.send(token, [
    // One unreadable id in a sweep doesn't hide the rest.
    event(6, 'on_session_delete', {
      reason: 'empty_sweep',
      deleted_ids: ['bad id with spaces', 'score-r1-builder~3', 'score-r1-builder~3'],
    }),
  ])
  expect(server.db.sqlite.prepare('SELECT count(*) AS n FROM session_successors').get()).toEqual({
    n: 3,
  })
  expect(
    server.db.sqlite.prepare("SELECT count(*) AS n FROM messages WHERE room_id = 'r1'").get(),
  ).toEqual({ n: 1 })
  expect(server.metrics.unknownHooks).toBe(0)
})

test('a compaction Hermes made is a system log line', async () => {
  const token = await server.token()
  await server.send(token, [
    event(1, 'post_compaction', {
      session_id: 'score-r1-builder',
      kind: 'auto',
      reason: 'context',
      before_tokens: 9000,
      after_tokens: 2100,
      messages_removed: 40,
    }),
  ])
  const logs = server.db.sqlite
    .prepare("SELECT data FROM events WHERE type = 'log.line'")
    .all()
    .map((row) => JSON.parse(String(row.data)) as { kind: string; text: string })
  expect(logs).toEqual([
    expect.objectContaining({
      kind: 'system',
      text: 'Hermes compacted the conversation (40 messages summarised, 9000 → 2100 tokens)',
    }),
  ])
  expect(server.metrics.unknownHooks).toBe(0)
})
