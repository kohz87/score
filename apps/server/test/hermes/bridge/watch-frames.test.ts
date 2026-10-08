import { type BridgeEvent } from '@score/contract'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { retireIngestKeys } from '../../../src/hub/retire.ts'
import { event, setup } from './helpers.ts'

let server: ReturnType<typeof setup>
let counter = 0
let cachedToken: string | null = null
beforeEach(() => {
  server = setup()
  counter = 0
  cachedToken = null
})
afterEach(async () => {
  await server.close()
})

const secrets = [
  'fixture-bearer-secret',
  'fixture-cmd-secret',
  'sk-fixture-output-secret-123456',
  'ghp_fixtureoutputsecret123456',
  'fixture-code-secret',
  'fixture-code-output-secret',
  'fixture-env-file-secret',
  'AKIA1234567890ABCDEF',
  'fixture-source-secret',
  'fixture-vault-secret',
  'fixture-vault-result-secret',
  'fixture-url-secret',
  'fixture-plugin-miss-secret',
]

interface HookRecord {
  hook: string
  payload: Record<string, unknown>
}
// The plugin's recorded hook shapes, sent here WITHOUT the plugin's own redaction: the server's pass must hold alone.
const records = JSON.parse(
  readFileSync(
    new URL('../../../../../hermes-plugin/tests/fixtures/watch-tool-hooks.json', import.meta.url),
    'utf8',
  ),
) as HookRecord[]

function toEvents(extra: HookRecord[] = []): BridgeEvent[] {
  return [...records, ...extra].map((record, index) => ({
    ...event(index + 1, record.hook, record.payload),
    sessionId: String(record.payload.session_id),
    toolCallId: String(record.payload.tool_call_id),
  }))
}

function frames() {
  return server.db.sqlite
    .prepare('SELECT * FROM watch_frames ORDER BY agent_id, seq')
    .all()
    .map((row) => ({
      ...row,
      caption: String(row.caption),
      payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
    }))
}

async function dump(): Promise<string> {
  server.db.sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const tables = ['watch_frames', 'events', 'session_tool_calls']
  const rows = tables.map((table) => server.db.sqlite.prepare(`SELECT * FROM ${table}`).all())
  const bytes = ['score.db', 'score.db-wal']
    .map((file) => {
      try {
        return readFileSync(join(server.home, file)).toString()
      } catch {
        return ''
      }
    })
    .join('')
  return JSON.stringify(rows) + bytes
}

test('raw fixture hooks produce redacted frames for every producer path', async () => {
  const token = await server.token()
  const response = await server.send(
    token,
    toEvents([
      {
        // A plugin that missed everything: secrets in the tail, cwd, command and URL title.
        hook: 'post_tool_call',
        payload: {
          tool_name: 'terminal',
          session_id: 's1',
          tool_call_id: 'call-miss',
          status: 'ok',
          args: { command: 'run --password=fixture-plugin-miss-secret' },
          result: '{"output":"unused"}',
          watch: {
            output:
              'Authorization: Bearer fixture-plugin-miss-secret\nTOKEN=fixture-plugin-miss-secret',
            exitCode: 0,
            cwd: '/work/password=fixture-plugin-miss-secret',
          },
        },
      },
    ]),
  )
  expect(response.statusCode).toBe(200)
  const stored = frames()
  const byCaption = (text: string) => stored.find((row) => String(row.caption).startsWith(text))
  expect(byCaption('Ran curl')).toMatchObject({
    surface: 'terminal',
    marker_kind: 'command',
    call_key: 's1:call-term',
    payload: { cwd: '/work/demo', status: 'error' },
  })
  expect(byCaption('Ran a script')).toMatchObject({ surface: 'terminal' })
  expect(byCaption('Wrote src/config.ts')).toMatchObject({ surface: 'editor', marker_kind: 'file' })
  expect(byCaption('Wrote /work/demo/.env')?.payload).toMatchObject({
    diff: '[contents hidden: credential file]',
  })
  expect(byCaption('Filled a saved login')).toMatchObject({ surface: 'browser' })
  expect(byCaption('Opened example.test')?.payload).toMatchObject({
    url: 'https://example.test/page',
    title: 'Example',
    imageUrl: null,
  })
  const text = await dump()
  for (const secret of secrets) expect(text).not.toContain(secret)
})

test('pre creates a running frame and post updates it in place under the same seq', async () => {
  const token = await server.token()
  await server.send(token, toEvents().slice(0, 1))
  expect(frames()).toMatchObject([{ seq: 1, payload: { status: 'running', output: '' } }])
  await server.send(token, [toEvents()[1]!])
  const [row, ...rest] = frames()
  expect(rest).toEqual([])
  expect(row).toMatchObject({ seq: 1, payload: { status: 'error' } })
  const emitted = server.db.sqlite
    .prepare("SELECT data FROM events WHERE type = 'watch.frame' ORDER BY seq")
    .all()
    .map((r) => JSON.parse(String(r.data)))
  expect(emitted.map((frame: { seq: number }) => frame.seq)).toEqual([1, 1])
})

test('vault tools: args, results and previews are never stored, even from a plugin that sent them', async () => {
  const token = await server.token()
  await server.send(token, toEvents().slice(5, 7))
  const tool = server.db.sqlite.prepare('SELECT * FROM session_tool_calls').get()!
  expect(tool.tool).toBe('browser_vault_fill')
  expect(tool.args_preview).toBeNull()
  const text = await dump()
  for (const word of ['fixture-vault-secret', 'fixture-vault-result-secret', 'me@example.test'])
    expect(text).not.toContain(word)
  expect(frames()).toMatchObject([{ caption: 'Filled a saved login' }])
})

test('terminal output is a bounded UTF-8 tail marked as such', async () => {
  const token = await server.token()
  await server.send(token, [
    event(1, 'post_tool_call', {
      tool_name: 'terminal',
      status: 'ok',
      args: { command: 'make' },
      result: '{"output":"x"}',
      watch: { output: '🙂'.repeat(30_000), tail: true, exitCode: 0 },
    }),
  ])
  const output = (frames()[0]!.payload as { output: string }).output
  expect(output.startsWith('[earlier output omitted]')).toBe(true)
  expect(Buffer.byteLength(output)).toBeLessThanOrEqual(64 * 1024)
})

test('frames link to the run of their session and the watch endpoints page them', async () => {
  const token = await server.token()
  server.db.sqlite
    .prepare(
      `INSERT INTO runs (id, profile, origin, session_id, status, started_at, updated_at)
       VALUES ('run-1', 'builder', 'kanban', 'session-1', 'running', '2026-10-07T11:00:00Z', '2026-10-07T11:00:00Z')`,
    )
    .run()
  const calls = Array.from({ length: 5 }, (_, index) => [
    event(index * 2 + 1, 'pre_tool_call', {
      tool_name: 'terminal',
      args: { command: `step ${index}` },
    }),
    event(index * 2 + 2, 'post_tool_call', {
      tool_name: 'terminal',
      status: 'ok',
      args: { command: `step ${index}` },
      result: '{"output":"done","exit_code":0}',
    }),
  ]).flat()
  for (const [index, call] of calls.entries()) call.toolCallId = `call-${Math.floor(index / 2)}`
  await server.send(token, calls)
  const get = (url: string) => server.app.inject({ method: 'GET', url })

  const all = (await get('/api/agents/builder/watch')).json()
  expect(all).toMatchObject({ live: true, agent: { id: 'builder' } })
  expect(all.frames.map((f: { seq: number }) => f.seq)).toEqual([1, 2, 3, 4, 5])
  expect(all.frames[0]).toMatchObject({
    agentId: 'builder',
    runId: 'run-1',
    terminal: { command: 'step 0', status: 'ok', output: 'done' },
    caption: 'Ran step 0',
  })
  expect(all.markers).toHaveLength(5)
  expect(all.markers[0]).toMatchObject({ seq: 1, kind: 'command' })
  expect(all.asOfSeq).toBeGreaterThan(0)

  const page = (await get('/api/agents/builder/watch?from=3&limit=2')).json()
  expect(page.frames.map((f: { seq: number }) => f.seq)).toEqual([3, 4])
  expect(page.markers).toHaveLength(5)
  const latest = (await get('/api/agents/builder/watch?limit=2')).json()
  expect(latest.frames.map((f: { seq: number }) => f.seq)).toEqual([4, 5])

  server.db.sqlite.prepare("UPDATE runs SET status = 'completed'").run()
  expect((await get('/api/agents/builder/watch')).json().live).toBe(false)
  expect((await get('/api/agents/nobody/watch')).statusCode).toBe(404)
  expect((await get('/api/agents/builder/watch?limit=0')).statusCode).toBe(400)

  const overview = (await get('/api/watch/overview')).json()
  const builder = overview.items.find(
    (item: { agent: { id: string } }) => item.agent.id === 'builder',
  )
  expect(builder).toMatchObject({
    thumbnail: null,
    status: 'Ran step 4',
    live: false,
    surface: 'terminal',
  })
  expect(overview.items.length).toBeGreaterThan(1)
})

test('markers include approvals as "asked" on the nearest earlier frame', async () => {
  const token = await server.token()
  await server.send(token, [
    event(1, 'post_tool_call', { tool_name: 'terminal', status: 'ok', args: { command: 'a' } }),
  ])
  server.db.sqlite
    .prepare(
      `INSERT INTO approvals (id, origin, stage, target_kind, profile, session_key, surface, command, description,
         pattern_keys, choices, phase, status, created_at, updated_at)
       VALUES ('a1', 'gateway', 'human', 'none', 'builder', 's', 'cli', 'rm', 'd', '[]', '[]', 'human_pending', 'pending',
         '2026-10-07T12:00:05.000Z', '2026-10-07T12:00:05.000Z')`,
    )
    .run()
  const watch = (
    await server.app.inject({ method: 'GET', url: '/api/agents/builder/watch' })
  ).json()
  expect(watch.markers.map((m: { kind: string }) => m.kind)).toEqual(['command', 'asked'])
  expect(watch.markers[1].seq).toBe(1)
})

test('retention drops frames older than seven days but keeps each agent its newest', async () => {
  const token = await server.token()
  await server.send(token, [
    event(1, 'post_tool_call', { tool_name: 'terminal', status: 'ok', args: { command: 'a' } }),
  ])
  const insert = server.db.sqlite.prepare(
    `INSERT INTO watch_frames (agent_id, seq, at, surface, payload, caption, marker_kind)
     VALUES (?, ?, ?, 'terminal', '{"cwd":"","command":"x","output":"","status":"ok"}', 'Ran x', 'command')`,
  )
  const now = Date.parse('2026-10-20T00:00:00Z')
  insert.run('builder', 2, '2026-10-01T00:00:00.000Z')
  insert.run('old-agent', 1, '2026-09-01T00:00:00.000Z')
  insert.run('old-agent', 2, '2026-09-02T00:00:00.000Z')
  retireIngestKeys(server.db, { now })
  expect(
    server.db.sqlite.prepare('SELECT agent_id, seq FROM watch_frames ORDER BY agent_id, seq').all(),
  ).toEqual([
    { agent_id: 'builder', seq: 2 },
    { agent_id: 'old-agent', seq: 2 },
  ])
})

// --- 4.7 browser screenshots ---
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { png } from '../../media-fixtures.ts'

const SHOT = 'browser_screenshot_0123abcd.png'
function shotDir(sub = join('cache', 'screenshots'), profile = 'builder'): string {
  const dir = join(server.hermesHome, 'profiles', profile, sub)
  mkdirSync(dir, { recursive: true })
  return dir
}
async function vision(path: string, tool = 'browser_vision', call = 'v1', redeliver = false) {
  cachedToken ??= await server.token()
  const token = cachedToken
  if (!redeliver) counter += 1
  const response = await server.send(token, [
    {
      ...event(counter, 'post_tool_call', {
        tool_name: tool,
        session_id: 's1',
        tool_call_id: call,
        status: 'ok',
        args: {},
        result: JSON.stringify({ url: 'https://example.test/', screenshot_path: path }),
        watch: { screenshotPath: path },
      }),
      sessionId: 's1',
      toolCallId: call,
    },
  ])
  expect(response.statusCode).toBe(200)
  return frames().at(-1)!
}
const refs = () =>
  server.db.sqlite.prepare('SELECT id, refs FROM media').all() as { id: string; refs: number }[]

test('a browser_vision screenshot becomes a served media image held by its frame', async () => {
  const path = join(shotDir(), SHOT)
  writeFileSync(path, png(200))
  const frame = await vision(path)
  const url = String(frame.payload.imageUrl)
  expect(url).toMatch(/^\/api\/media\/[0-9a-f-]{36}$/)
  const res = await server.app.inject({ method: 'GET', url })
  expect(res.statusCode).toBe(200)
  expect(res.headers['content-type']).toBe('image/png')
  expect(refs()).toMatchObject([{ refs: 1 }])
  // a redelivered hook must not take a second reference
  await vision(path, 'browser_vision', 'v1', true)
  expect(refs()).toMatchObject([{ refs: 1 }])
  // a later hook for the same call (new counter) rewrites the frame without a second reference
  await vision(path, 'browser_vision', 'v1')
  expect(frames()).toHaveLength(1)
  expect(refs()).toMatchObject([{ refs: 1 }])
})

test('the legacy browser_screenshots directory is accepted', async () => {
  const path = join(shotDir('browser_screenshots'), SHOT)
  writeFileSync(path, png(100))
  expect((await vision(path)).payload.imageUrl).toMatch(/^\/api\/media\//)
})

test.each([
  ['non-image bytes', () => Buffer.from('not an image at all')],
  ['oversize file', () => Buffer.concat([png(10), Buffer.alloc(2 * 1024 * 1024 + 1)])],
])('%s keeps imageUrl null', async (_label, bytes) => {
  const path = join(shotDir(), SHOT)
  writeFileSync(path, bytes())
  expect((await vision(path)).payload.imageUrl).toBeNull()
  expect(refs()).toEqual([])
})

test('paths outside Hermes screenshot directories are refused', async () => {
  const dir = shotDir()
  const outside = join(server.home, SHOT)
  writeFileSync(outside, png(100))
  const other = join(shotDir(join('cache', 'screenshots'), 'reviewer'), SHOT)
  writeFileSync(other, png(101))
  const badName = join(dir, 'secret.png')
  writeFileSync(badName, png(102))
  const refused = [
    outside,
    other, // another profile's directory
    badName,
    `${dir}/../screenshots/${SHOT}`,
    `${dir}/../../${SHOT}`,
    `relative/${SHOT}`,
    join(dir, SHOT) + '\0',
  ]
  writeFileSync(join(dir, SHOT), png(103))
  for (const [index, path] of refused.entries())
    expect((await vision(path, 'browser_vision', `r${index}`)).payload.imageUrl).toBeNull()
  expect(refs()).toEqual([])
})

test('symlinked screenshots are refused', async () => {
  const dir = shotDir()
  const target = join(server.home, 'private.png')
  writeFileSync(target, png(300))
  const link = join(dir, SHOT)
  symlinkSync(target, link)
  expect((await vision(link)).payload.imageUrl).toBeNull()
  expect(refs()).toEqual([])
})

test('other browser tools and the vault never store a screenshot', async () => {
  const path = join(shotDir(), SHOT)
  writeFileSync(path, png(150))
  expect((await vision(path, 'browser_snapshot', 'a')).payload.imageUrl).toBeNull()
  const vault = await vision(path, 'browser_vault_fill', 'b')
  expect(vault.payload.imageUrl).toBeNull()
  expect(refs()).toEqual([])
})

test('retention releases the media reference when old frames are deleted', async () => {
  const path = join(shotDir(), SHOT)
  writeFileSync(path, png(120))
  await vision(path, 'browser_vision', 'old')
  await vision(path, 'browser_snapshot', 'newer')
  expect(refs()).toMatchObject([{ refs: 1 }])
  retireIngestKeys(server.db, { now: Date.parse('2026-10-20T00:00:00Z') })
  expect(frames()).toHaveLength(1)
  expect(refs()).toMatchObject([{ refs: 0 }])
})
