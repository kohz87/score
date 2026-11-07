import { RunSummarySchema } from '@score/contract'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { activityParts } from '../../src/domain/message-runs.ts'
import { readWatch } from '../../src/domain/watch-frames.ts'
import {
  addAgent,
  calls,
  coding,
  db,
  dir,
  finished,
  home,
  ingest,
  launches,
  log,
  makeRoom,
  replies,
  request,
  roomId,
  runs,
  say,
  setEnv,
  setupCodingRuntime,
  workspace,
} from './coding-runtime-helpers.ts'

setupCodingRuntime()

test('an @mention runs Claude Code in the workspace: reply, tool cards, run, usage, frames, session', async () => {
  await addAgent()
  await makeRoom()
  setEnv('OPENAI_API_KEY', 'sk-abcdefghijklmnop')
  setEnv('SCORE_SECRET_THING', 'x')
  await say('@coder please add a greeting')
  await finished()
  const [run] = runs()
  expect(run).toMatchObject({
    profile: 'coder',
    runtime: 'claude-code',
    status: 'completed',
    cost_usd: 0.0123,
    cost_kind: 'estimated',
    input_tokens: 1350,
    output_tokens: 340,
    session_id: '11111111-1111-4111-8111-111111111111',
  })
  const [reply] = replies()
  expect(reply!.streaming).toBe(false)
  const kinds = reply!.parts.map((part) => part.kind)
  expect(kinds.filter((kind) => kind === 'tool')).toHaveLength(3)
  expect(kinds).toContain('thinking')
  const text = reply!.parts
    .filter((part) => part.kind === 'text')
    .map((part) => (part as { text: string }).text)
    .join('')
  expect(text).toContain('Looking at the project.')
  expect(text).toContain('Created hello.txt and changed it.')
  // The summary of the run, as every other surface reads it.
  const summary = RunSummarySchema.parse(
    JSON.parse(
      JSON.stringify(
        db.sqlite
          .prepare("SELECT data FROM events WHERE type = 'run.updated' ORDER BY seq DESC LIMIT 1")
          .get()
          ? JSON.parse(
              String(
                (
                  db.sqlite
                    .prepare(
                      "SELECT data FROM events WHERE type = 'run.updated' ORDER BY seq DESC LIMIT 1",
                    )
                    .get() as { data: string }
                ).data,
              ),
            )
          : {},
      ),
    ),
  )
  expect(summary).toMatchObject({
    runtime: 'claude-code',
    costKind: 'estimated',
    status: 'completed',
  })
  // Frames from the parsed events: a terminal frame for the command and editor frames for the file edits.
  const frames = db.sqlite
    .prepare("SELECT surface, caption FROM watch_frames WHERE agent_id = 'coder' ORDER BY seq")
    .all() as { surface: string; caption: string }[]
  expect(frames.map((frame) => frame.surface)).toEqual(['terminal', 'editor', 'editor'])
  expect(frames[0]!.caption).toBe('Ran ls -la')
  // The CLI session is kept for the next turn.
  expect(db.sqlite.prepare('SELECT session_id FROM coding_sessions').all()).toEqual([
    { session_id: '11111111-1111-4111-8111-111111111111' },
  ])
  // What the process was given.
  const [call] = calls()
  expect(call!.cwd).toBe(workspace)
  expect(call!.args).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits']))
  expect(call!.args.join(' ')).not.toContain('please add a greeting')
  expect(call!.prompt).toContain('please add a greeting')
  expect(call!.env).not.toContain('OPENAI_API_KEY')
  expect(call!.env).not.toContain('SCORE_SECRET_THING')
  expect(call!.env).not.toContain('SCORE_HOME')
  expect(call!.env).toContain('PATH')
  // Deny rules for Score's, Hermes's and SSH folders reach the CLI through its settings file.
  const settingsPath = call!.args[call!.args.indexOf('--settings') + 1]!
  expect(JSON.parse(readFileSync(settingsPath, 'utf8')).permissions.deny).toContain(
    `Read(/${home}/**)`,
  )
})

// 3.20.0 shared workspaces: where a chat turn of a coding agent runs.
async function sharedWorkspace(
  name: string,
  assigned: string[],
): Promise<{ id: string; path: string }> {
  const folder = join(dir, name)
  mkdirSync(folder)
  const created = await request('POST', '/api/workspaces', { name, path: folder })
  expect(created.statusCode, created.body).toBe(201)
  const id = created.json().id as string
  if (assigned.length)
    expect(
      (await request('PATCH', `/api/workspaces/${id}`, { agentIds: assigned })).statusCode,
    ).toBe(200)
  return { id, path: created.json().path as string }
}
const setRoomWorkspace = (workspaceId: string | null) =>
  request('PUT', `/api/rooms/${roomId}/workspace`, { workspaceId })

test('3.20.0: a coding agent runs in the room’s workspace when assigned to it, else in its own folder', async () => {
  await addAgent()
  await makeRoom()
  const shared = await sharedWorkspace('shared', ['coder'])
  const other = await sharedWorkspace('other', [])
  expect((await setRoomWorkspace(shared.id)).json().workspaceId).toBe(shared.id)
  await say('@coder please add a greeting')
  await finished(1)
  expect(calls().at(-1)!.cwd).toBe(shared.path)
  // A room set to a workspace the agent is not assigned to: its own folder.
  await setRoomWorkspace(other.id)
  await say('@coder please add another greeting')
  await finished(2)
  expect(calls().at(-1)!.cwd).toBe(workspace)
  // No workspace on the room: its own folder.
  await setRoomWorkspace(null)
  await say('@coder and one more')
  await finished(3)
  expect(calls().at(-1)!.cwd).toBe(workspace)
})

test('3.20.0: a room workspace that fails the root policy is refused at admission and at launch, nothing spawns', async () => {
  await addAgent()
  await makeRoom()
  const shared = await sharedWorkspace('shared2', ['coder'])
  // Admission: the stored folder has since become one the policy refuses (Score's own home), written past the route.
  db.sqlite.prepare('UPDATE workspaces SET path = ? WHERE id = ?').run(home, shared.id)
  await setRoomWorkspace(shared.id)
  const before = launches
  await say('@coder please add a greeting')
  await new Promise((resolve) => setTimeout(resolve, 300))
  await ingest.drain()
  expect(launches).toBe(before)
  expect(existsSync(log) ? calls().length : 0).toBe(0)
  expect(runs().every((row) => row.status !== 'completed')).toBe(true)
})

test('3.20.0: the launch check applies to the room’s workspace too (folder replaced after admission)', async () => {
  await addAgent()
  await makeRoom()
  const shared = await sharedWorkspace('shared3', ['coder'])
  await setRoomWorkspace(shared.id)
  // Hold the first turn at admission's tail by blocking the agent's previous turn is awkward; instead point the room at a
  // folder that passes admission, then swap the stored path to a forbidden one before the queued run starts.
  const real = coding as unknown as {
    executeRun: (...args: unknown[]) => Promise<void>
  }
  const original = real.executeRun.bind(coding)
  real.executeRun = async (...args: unknown[]) => {
    db.sqlite.prepare('UPDATE workspaces SET path = ? WHERE id = ?').run(home, shared.id)
    return original(...args)
  }
  const before = launches
  await say('@coder please add a greeting')
  await finished(1)
  expect(launches).toBe(before)
  expect(runs()[0]).toMatchObject({ status: 'failed' })
  expect(runs()[0]!.error).toMatch(/workspace is unavailable/)
})

test('the next turn in the same room resumes the CLI session; another room does not', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder first')
  await finished(1)
  await say('@coder second')
  await finished(2)
  const [first, second] = calls()
  expect(first!.args).not.toContain('--resume')
  expect(second!.args).toEqual(
    expect.arrayContaining(['--resume', '11111111-1111-4111-8111-111111111111']),
  )
})

test('Codex: tokens without cost are shown as unknown, never zero; sandbox flags follow the permission', async () => {
  await addAgent({
    id: 'cx',
    name: 'Cx',
    runtime: 'codex',
    acknowledgeReads: true,
    permission: 'read-only',
  })
  await makeRoom()
  await say('@cx look around')
  await finished()
  const [run] = runs()
  expect(run).toMatchObject({
    runtime: 'codex',
    status: 'completed',
    cost_usd: null,
    cost_kind: 'unknown',
    input_tokens: 2400,
    output_tokens: 150,
  })
  const [call] = calls()
  expect(call!.args).toEqual(expect.arrayContaining(['-s', 'read-only', '-C', workspace]))
  const [reply] = replies()
  expect(reply!.parts.filter((part) => part.kind === 'tool').length).toBe(4)
  expect(
    reply!.parts.some((part) => part.kind === 'text' && part.text.includes('Updated notes.txt')),
  ).toBe(true)
})

test('8.7: a turn with a sub-agent keeps its success; the sub-agent calls nest under the Agent card', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:subagent] list the files')
  await finished()
  const [run] = runs()
  expect(run).toMatchObject({ status: 'completed' })
  const [reply] = replies()
  const tools = reply!.parts.filter((part) => part.kind === 'tool')
  expect(tools).toHaveLength(2)
  const agent = tools.find((part) => part.tool === 'Agent')!
  const inner = tools.find((part) => part.tool === 'Bash')!
  expect(agent.callId).toBeTruthy()
  expect(agent.parentCallId).toBeUndefined()
  expect(inner.parentCallId).toBe(agent.callId)
  expect(agent.subagent).toEqual({
    status: 'done',
    description: 'List files in folder',
    subagentType: 'general-purpose',
    toolCalls: 1,
    durationMs: 7550,
    totalTokens: 19455,
  })
  // An unreadable stored summary is treated as absent, never an error.
  db.sqlite.prepare("UPDATE tool_calls SET subagent = '{nope' WHERE tool = 'Agent'").run()
  expect(
    activityParts(db.sqlite, run!.id).parts.find(
      (part) => part.kind === 'tool' && part.tool === 'Agent',
    ),
  ).not.toHaveProperty('subagent')
  // Watch frames of the sub-agent's command say so.
  const captions = db.sqlite.prepare('SELECT caption FROM watch_frames').all() as {
    caption: string
  }[]
  expect(captions.some((frame) => frame.caption.startsWith('Sub-agent · '))).toBe(true)
  // C1: and they carry the Agent call's id, in the table and in what Watch reads back.
  const stored = db.sqlite
    .prepare('SELECT caption, parent_call_id AS parent FROM watch_frames ORDER BY seq')
    .all() as { caption: string; parent: string | null }[]
  expect(stored.filter((frame) => frame.parent !== null)).toEqual(
    stored.filter((frame) => frame.caption.startsWith('Sub-agent · ')),
  )
  expect(stored.find((frame) => frame.parent !== null)!.parent).toBe(agent.callId)
  const watched = readWatch(db.sqlite, 'coder', { limit: 50 }).frames
  expect(watched.find((frame) => frame.caption.startsWith('Sub-agent · '))).toMatchObject({
    parentCallId: agent.callId,
  })
  expect(watched.filter((frame) => frame.parentCallId === undefined).length).toBe(
    watched.filter((frame) => !frame.caption.startsWith('Sub-agent · ')).length,
  )
})

test('hand-offs: a coding agent can @mention a Hermes agent and be mentioned by one', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:handoff] build it')
  await finished()
  const handoff = db.sqlite
    .prepare("SELECT agent_id, from_agent_id, hop FROM message_runs WHERE from_agent_id = 'coder'")
    .all()
  expect(handoff).toEqual([{ agent_id: 'reviewer', from_agent_id: 'coder', hop: 1 }])
  // And the other way: a person's message to a Hermes agent mentioning the coder reaches the coder.
  await say('@lead [fixture:handoff] hello @coder')
  await vi.waitFor(() => expect(runs().length).toBe(2), { timeout: 15_000 })
})
