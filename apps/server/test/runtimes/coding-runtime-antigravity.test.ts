import { expect, test, vi } from 'vitest'
import {
  agy,
  calls,
  db,
  finished,
  makeRoom,
  replies,
  request,
  roomId,
  runs,
  say,
  setEnv,
  setupCodingRuntime,
  style,
  workspace,
} from './coding-runtime-helpers.ts'

setupCodingRuntime()

// ---------------------------------------------------------------------------------------------------- Antigravity (7.6)

test('antigravity: levels are offered only once verified; create and patch refuse the rest', async () => {
  const defaults = (await request('GET', '/api/coding-agents/runtimes'))
    .json()
    .items.find((item: { runtime: string }) => item.runtime === 'antigravity')
  expect(defaults.unverifiedPermissions).toEqual([])
  setEnv('SCORE_CODING_VERIFIED_ANTIGRAVITY', '')
  const info = (await request('GET', '/api/coding-agents/runtimes'))
    .json()
    .items.find((item: { runtime: string }) => item.runtime === 'antigravity')
  expect(info.unverifiedPermissions).toEqual(['read-only', 'workspace-write', 'full'])
  expect(info.warning).toMatch(/browse the web, generate images/)
  const refused = await request('POST', '/api/coding-agents', {
    id: 'agy0',
    name: 'Agy',
    runtime: 'antigravity',
    acknowledgeReads: true,
    permission: 'read-only',
    workspace,
    style,
  })
  expect(refused.statusCode).toBe(422)
  expect(refused.json().error.code).toBe('permission_unverified')
  setEnv('SCORE_CODING_VERIFIED_ANTIGRAVITY', 'read-only,workspace-write')
  const after = (await request('GET', '/api/coding-agents/runtimes'))
    .json()
    .items.find((item: { runtime: string }) => item.runtime === 'antigravity')
  expect(after.unverifiedPermissions).toEqual(['full'])
  await agy()
  const patch = await request('PATCH', '/api/coding-agents/agy1', {
    permission: 'full',
    password: 'x',
  })
  expect(patch.statusCode).toBe(422)
  expect(patch.json().error.code).toBe('permission_unverified')
  // Inside the sandbox (below full access) no read acknowledgement is needed; at full access it is, like Codex.
  const sandboxed = await request('POST', '/api/coding-agents', {
    id: 'agy2',
    name: 'Agy',
    runtime: 'antigravity',
    permission: 'read-only',
    workspace,
    style,
  })
  expect(sandboxed.json().error?.code).not.toBe('acknowledgement_required')
  setEnv('SCORE_CODING_VERIFIED_ANTIGRAVITY', 'read-only,workspace-write,full')
  const fullNoAck = await request('POST', '/api/coding-agents', {
    id: 'agy3',
    name: 'Agy',
    runtime: 'antigravity',
    permission: 'full',
    password: 'x',
    workspace,
    style,
  })
  expect(fullNoAck.json().error.code).toBe('acknowledgement_required')
})

test('antigravity: a turn spawns by argv with the level flags, shows tool cards and Watch frames, tokens without cost', async () => {
  setEnv('SCORE_CODING_VERIFIED_ANTIGRAVITY', 'read-only,workspace-write,full')
  await agy({ permission: 'workspace-write' })
  await makeRoom()
  await say('@agy1 please update the notes')
  await finished()
  expect(runs()[0]).toMatchObject({
    runtime: 'antigravity',
    status: 'completed',
    cost_usd: null,
    cost_kind: 'unknown',
    input_tokens: 2400,
    output_tokens: 310,
    session_id: 'aaaaaaaa-3333-4333-8333-000000000003',
  })
  const [call] = calls()
  expect(call!.args[0]).toBe('-p')
  expect(call!.args).toEqual(
    expect.arrayContaining([
      '--output-format',
      'stream-json',
      '--mode',
      'accept-edits',
      '--sandbox',
    ]),
  )
  expect(call!.prompt).toContain('please update the notes')
  expect(call!.cwd).toBe(workspace)
  const [reply] = replies()
  expect(reply!.parts.filter((part) => part.kind === 'tool').length).toBe(4)
  expect(JSON.stringify(reply!.parts)).toContain('Updated notes.txt and checked the docs.')
  const frames = db.sqlite.prepare('SELECT surface, caption, payload FROM watch_frames').all() as {
    surface: string
    caption: string
    payload: string
  }[]
  expect(frames.map((frame) => frame.surface).sort()).toEqual(['browser', 'editor', 'terminal'])
  // The browser frame lost the query and fragment.
  expect(frames.find((f) => f.surface === 'browser')!.payload).not.toContain('token=abc')
  // The conversation continues in the same room.
  await say('@agy1 [fixture:handoff] again')
  await finished(2)
  expect(calls()[1]!.args).toEqual(
    expect.arrayContaining(['--conversation', 'aaaaaaaa-3333-4333-8333-000000000003']),
  )
})

test('antigravity: refused actions show as a card; SUCCESS without a response is no result, and the note says why (7.7a section 6)', async () => {
  setEnv('SCORE_CODING_VERIFIED_ANTIGRAVITY', 'read-only')
  await agy()
  await makeRoom()
  await say('@agy1 [fixture:denied] list the files')
  await finished()
  expect(runs()[0]!.status).toBe('failed')
  const text = JSON.stringify(replies()[0]!.parts)
  expect(text).toContain('Antigravity refused')
  expect(text).toContain('RunCommand')
  expect(calls()[0]!.args).toEqual(expect.arrayContaining(['--mode', 'plan', '--sandbox']))
})

test('antigravity: the version is read before every turn; a self-updated CLI keeps working (3.15.3)', async () => {
  setEnv('SCORE_CODING_VERIFIED_ANTIGRAVITY', 'read-only')
  await agy()
  await makeRoom()
  await say('@agy1 one')
  await finished()
  setEnv('SCORE_CODING_FAKE_VERSION', '1.9.9')
  await say('@agy1 two')
  await vi.waitFor(() => expect(calls().length).toBe(2), { timeout: 10_000 })
  const view = (await request('GET', '/api/coding-agents')).json().items[0]
  expect(view.cli).toMatchObject({ state: 'untested_version', version: '1.9.9', problem: null })
})

test('antigravity: Stop ends the process group and the reply says it was stopped', async () => {
  setEnv('SCORE_CODING_VERIFIED_ANTIGRAVITY', 'read-only')
  await agy()
  await makeRoom()
  await say('@agy1 [fixture:slow] take your time')
  await vi.waitFor(() => expect(runs()[0]?.status).toBe('running'), { timeout: 10_000 })
  await vi.waitFor(() => expect(replies()[0]?.parts.length).toBeGreaterThan(0), { timeout: 10_000 })
  const stopped = await request('POST', `/api/rooms/${roomId}/messages/${replies()[0]!.id}/stop`)
  expect(stopped.statusCode, stopped.body).toBe(200)
  await finished()
  expect(runs()[0]!.status).toBe('cancelled')
  expect(JSON.stringify(replies()[0]!.parts)).toContain('This run was stopped.')
})

test('antigravity: secrets are redacted from the assembled reply, even when split across deltas, and from tool cards and frames', async () => {
  setEnv('SCORE_CODING_VERIFIED_ANTIGRAVITY', 'read-only')
  await agy()
  await makeRoom()
  await say('@agy1 [fixture:secret] go')
  await finished()
  const stored = JSON.stringify([
    replies().map((reply) => reply.parts),
    db.sqlite.prepare('SELECT * FROM tool_calls').all(),
    db.sqlite.prepare('SELECT * FROM watch_frames').all(),
    db.sqlite.prepare('SELECT data FROM events').all(),
    db.sqlite.prepare('SELECT output, error FROM runs').all(),
  ])
  expect(stored).not.toContain('sk-abcdefghijklmnopqrstuvwx')
  expect(stored).not.toContain('abcdefghijklmnop123456')
  expect(stored).toContain('[redacted]')
})

test('antigravity: a failed turn and a stale conversation falls back to a fresh one', async () => {
  setEnv('SCORE_CODING_VERIFIED_ANTIGRAVITY', 'read-only')
  await agy()
  await makeRoom()
  await say('@agy1 [fixture:error] go')
  await finished()
  expect(runs()[0]).toMatchObject({ status: 'failed', error: 'The model request failed' })
  await say('@agy1 [fixture:stale] one')
  await finished(2)
  await say('@agy1 [fixture:stale] two')
  await finished(3)
  expect(runs()[2]).toMatchObject({ status: 'completed' })
  // error (fresh), stale one (resumes, not found, fresh), stale two (same).
  expect(calls().map((call) => call.args.includes('--conversation'))).toEqual([
    false,
    true,
    false,
    true,
    false,
  ])
})

test('antigravity: the quota reading comes from /usage and is cached', async () => {
  setEnv('SCORE_CODING_VERIFIED_ANTIGRAVITY', 'read-only')
  // 3.15.2: read through the quota route the app uses (the raw /usage route is gone).
  const response = await request('GET', '/api/coding-agents/runtimes/antigravity/quota')
  expect(response.statusCode, response.body).toBe(200)
  const windows = response.json().quota.windows as {
    name: string
    group: string
    usedPercent: number | null
  }[]
  expect(windows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: '5 hours', group: 'Gemini Models', usedPercent: 13 }),
      expect.objectContaining({ group: 'Gemini Models', usedPercent: 25 }),
    ]),
  )
  expect((await request('GET', '/api/coding-agents/runtimes/antigravity/usage')).statusCode).toBe(
    404,
  )
  setEnv('SCORE_CODING_FAKE_VERSION', '9.9.9')
  // Cached for a minute, so the version change is not noticed yet.
  expect((await request('GET', '/api/coding-agents/runtimes/antigravity/quota')).statusCode).toBe(
    200,
  )
})
