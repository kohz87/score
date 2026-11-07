import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  addAgent,
  calls,
  finished,
  home,
  makeRoom,
  replies,
  request,
  say,
  setupCodingRuntime,
  workspace,
} from './coding-runtime-helpers.ts'

setupCodingRuntime()

// ---- PLAN 8.8: role and "Personality and instructions" ----
const OWNER_TEXT = 'Answer in rhyme.\nNever touch the lockfile.'
type Logged = ReturnType<typeof calls>[number] & {
  appended: { path: string; mode: string; content: string } | null
}
const logged = () => calls() as Logged[]
const lastReplyText = () =>
  JSON.stringify(
    replies()
      .at(-1)!
      .parts.filter((part) => part.kind === 'text'),
  )
const patchAgent = (id: string, payload: object) =>
  request('PATCH', `/api/coding-agents/${id}`, payload)

test('8.8: Claude Code gets role and instructions as a 0600 file in Score’s folder, never on argv or in the workspace', async () => {
  await addAgent({ role: 'Reviewer of build scripts', instructions: OWNER_TEXT })
  await makeRoom()
  await say('@coder first')
  await finished(1)
  const [call] = logged()
  const flag = call!.args.indexOf('--append-system-prompt-file')
  expect(flag).toBeGreaterThan(-1)
  expect(call!.appended!.path).toBe(call!.args[flag + 1])
  expect(call!.appended!.mode).toBe('600')
  expect(call!.appended!.path.startsWith(join(home, 'coding', 'coder'))).toBe(true)
  expect(call!.appended!.path.startsWith(workspace)).toBe(false)
  expect(call!.appended!.content).toContain('Your name in this team: Coder.')
  expect(call!.appended!.content).toContain('Your role: Reviewer of build scripts')
  expect(call!.appended!.content).toContain(OWNER_TEXT)
  expect(call!.appended!.content).toMatch(/access level and the folders you must not open/)
  // The text is on neither argv nor stdin, and not in the workspace.
  expect(JSON.stringify(call!.args)).not.toContain('rhyme')
  expect(call!.prompt).not.toContain('rhyme')
  expect(readdirSync(workspace)).toEqual([])
  // The file lives only as long as the run.
  expect(existsSync(call!.appended!.path)).toBe(false)
  // A first session has nothing to refresh.
  expect(call!.args).not.toContain('--system-prompt-snapshot')
})

test('8.8: a resumed Claude Code session renders the system prompt again so an edit applies', async () => {
  await addAgent({ instructions: OWNER_TEXT })
  await makeRoom()
  await say('@coder first')
  await finished(1)
  await say('@coder second')
  await finished(2)
  expect(logged()[1]!.args).toEqual(
    expect.arrayContaining([
      '--resume',
      '--append-system-prompt-file',
      '--system-prompt-snapshot',
      'off',
    ]),
  )
  // Cleared: the file goes, but the recorded prompt must still be dropped.
  const state = (await request('GET', '/api/coding-agents')).json().items[0]
  expect(
    (await patchAgent('coder', { instructions: '', instructionsEtag: state.instructionsEtag }))
      .statusCode,
  ).toBe(200)
  await say('@coder third')
  await finished(3)
  const third = logged()[2]!
  expect(third.args).not.toContain('--append-system-prompt-file')
  expect(third.args).toEqual(expect.arrayContaining(['--system-prompt-snapshot', 'off']))
  // Empty and unchanged since: exactly today's argv.
  await say('@coder fourth')
  await finished(4)
  expect(logged()[3]!.args).not.toContain('--system-prompt-snapshot')
  expect(logged()[3]!.args).not.toContain('--append-system-prompt-file')
})

test('8.8: empty role and instructions change nothing: no flag, the message as written', async () => {
  await addAgent()
  await addAgent({ id: 'cx', name: 'Cx', runtime: 'codex', acknowledgeReads: true })
  await makeRoom()
  await say('@coder one')
  await say('@cx two')
  await finished(2)
  const all = logged()
  const claude = all.find((call) => call.runtime === 'claude-code')!
  const codex = all.find((call) => call.runtime === 'codex')!
  expect(claude.args.join(' ')).not.toMatch(/system-prompt/)
  expect(codex.prompt).not.toContain('Your name in this team')
  expect(codex.prompt).not.toContain('---')
})

test('8.8: Codex gets the block before the first message, again only after a change, and a removal is announced', async () => {
  await addAgent({
    id: 'cx',
    name: 'Cx',
    runtime: 'codex',
    acknowledgeReads: true,
    role: 'Test writer',
    instructions: OWNER_TEXT,
  })
  await makeRoom()
  await say('@cx [fixture:echo] one')
  await finished(1)
  const first = logged()[0]!
  expect(first.args).not.toContain('resume')
  expect(first.prompt.startsWith('Your name in this team: Cx.')).toBe(true)
  expect(first.prompt).toContain('Your role: Test writer')
  expect(first.prompt).toContain(OWNER_TEXT)
  expect(first.prompt.indexOf('one')).toBeGreaterThan(first.prompt.indexOf(OWNER_TEXT))
  // The fake CLI echoes what it was given.
  expect(lastReplyText()).toContain('Received instructions: Your name in this team: Cx.')
  // Resumed, unchanged: the message alone.
  await say('@cx [fixture:echo] two')
  await finished(2)
  const second = logged()[1]!
  expect(second.args).toContain('resume')
  expect(second.prompt).not.toMatch(/^Your name in this team/)
  expect(second.prompt).not.toMatch(/^Your instructions were updated/)
  // Changed: sent again, labelled.
  const etag = (await request('GET', '/api/coding-agents'))
    .json()
    .items.find((item: { id: string }) => item.id === 'cx').instructionsEtag
  await patchAgent('cx', { instructions: 'Be brief.', instructionsEtag: etag })
  await say('@cx three')
  await finished(3)
  const third = logged()[2]!
  expect(third.prompt).toContain('Your instructions were updated:')
  expect(third.prompt).toContain('Be brief.')
  // Unchanged since: nothing.
  await say('@cx four')
  await finished(4)
  expect(logged()[3]!.prompt).not.toMatch(/^Your instructions were updated/)
  // A role change alone also counts; clearing both is announced.
  await patchAgent('cx', { role: '' })
  await say('@cx five')
  await finished(5)
  expect(logged()[4]!.prompt).toContain('Your instructions were updated:')
  const etag2 = (await request('GET', '/api/coding-agents'))
    .json()
    .items.find((item: { id: string }) => item.id === 'cx').instructionsEtag
  await patchAgent('cx', { instructions: '', instructionsEtag: etag2 })
  await say('@cx six')
  await finished(6)
  expect(logged()[5]!.prompt).toContain('removed your role and instructions')
  await say('@cx seven')
  await finished(7)
  expect(logged()[6]!.prompt).not.toMatch(/^Your instructions were updated/)
})

test('8.8: a session from before the block existed gets it once when instructions are added later', async () => {
  await addAgent({ id: 'cx', name: 'Cx', runtime: 'codex', acknowledgeReads: true })
  await makeRoom()
  await say('@cx one')
  await finished(1)
  const etag = (await request('GET', '/api/coding-agents')).json().items[0].instructionsEtag
  await patchAgent('cx', { instructions: OWNER_TEXT, instructionsEtag: etag })
  await say('@cx two')
  await finished(2)
  expect(logged()[1]!.prompt).toContain('Your instructions were updated:')
  expect(logged()[1]!.prompt).toContain(OWNER_TEXT)
})

test('8.8: Antigravity gets the block before the first message', async () => {
  await addAgent({
    id: 'ag',
    name: 'Ag',
    runtime: 'antigravity',
    role: 'Designer',
    instructions: OWNER_TEXT,
  })
  await makeRoom()
  await say('@ag [fixture:echo] hello')
  await finished(1)
  const call = logged()[0]!
  const prompt = call.args[call.args.indexOf('-p') + 1]!
  expect(prompt.startsWith('Your name in this team: Ag.')).toBe(true)
  expect(prompt).toContain(OWNER_TEXT)
  expect(lastReplyText()).toContain('Received instructions:')
})

test('8.8: instructions are saved with an etag; a stale one is a conflict that changes nothing', async () => {
  const created = await addAgent({ role: 'Builder', instructions: 'Be careful.' })
  expect(created).toMatchObject({ role: 'Builder', instructions: 'Be careful.' })
  expect(created.instructionsEtag).toMatch(/^[0-9a-f]{16}$/)
  const saved = await patchAgent('coder', {
    instructions: 'Be bold.',
    instructionsEtag: created.instructionsEtag,
  })
  expect(saved.statusCode, saved.body).toBe(200)
  expect(saved.json()).toMatchObject({ instructions: 'Be bold.' })
  expect(saved.json().instructionsEtag).not.toBe(created.instructionsEtag)
  // The old etag is stale now, and the same request's other fields are not applied either.
  const stale = await patchAgent('coder', {
    instructions: 'Overwrite.',
    instructionsEtag: created.instructionsEtag,
    role: 'Changed',
  })
  expect(stale.statusCode).toBe(409)
  expect(stale.json().error).toMatchObject({
    code: 'conflict',
    details: { etag: saved.json().instructionsEtag, instructions: 'Be bold.' },
  })
  const after = (await request('GET', '/api/coding-agents')).json().items[0]
  expect(after).toMatchObject({ instructions: 'Be bold.', role: 'Builder' })
  // Without an etag, and over the limit, it is refused before anything is stored.
  expect((await patchAgent('coder', { instructions: 'x' })).statusCode).toBe(400)
  expect(
    (
      await patchAgent('coder', {
        instructions: 'x'.repeat(8001),
        instructionsEtag: after.instructionsEtag,
      })
    ).statusCode,
  ).toBe(400)
  expect((await patchAgent('coder', { role: 'r'.repeat(2001) })).statusCode).toBe(400)
  // A role needs no etag.
  expect((await patchAgent('coder', { role: 'Lead builder' })).json().role).toBe('Lead builder')
  // The team list shows the role.
  const team = (await request('GET', '/api/agents')).json().items as { id: string; role: string }[]
  expect(team.find((item) => item.id === 'coder')!.role).toBe('Lead builder')
})

test('3.9.0: effort defaults to null, PATCH sets and clears it per runtime, and bad levels are refused', async () => {
  const created = await addAgent()
  expect(created.effort).toBeNull()
  const set = await request('PATCH', '/api/coding-agents/coder', { effort: 'max' })
  expect(set.statusCode, set.body).toBe(200)
  expect(set.json().effort).toBe('max')
  // Claude Code has no 'minimal'; free text and unknown words never reach argv.
  for (const effort of ['minimal', 'High', 'a b', '--x', 'abcdefghijklm'])
    expect((await request('PATCH', '/api/coding-agents/coder', { effort })).statusCode).toBe(400)
  const cleared = await request('PATCH', '/api/coding-agents/coder', { effort: null })
  expect(cleared.json().effort).toBeNull()
  // Antigravity documents no effort flag.
  await addAgent({ id: 'agy', name: 'Agy', runtime: 'antigravity' })
  expect((await request('PATCH', '/api/coding-agents/agy', { effort: 'low' })).statusCode).toBe(400)
})

test('3.14.1: a Claude Code agent’s own advisor: off by default, only a stronger model, off again when the model catches up', async () => {
  const created = await addAgent()
  expect(created.advisorModel).toBeNull()
  // The default model counts as Opus: only Fable is above it.
  expect(
    (await request('PATCH', '/api/coding-agents/coder', { advisorModel: 'opus' })).statusCode,
  ).toBe(400)
  const sonnet = await request('PATCH', '/api/coding-agents/coder', {
    model: 'sonnet',
    advisorModel: 'opus',
  })
  expect(sonnet.statusCode, sonnet.body).toBe(200)
  expect(sonnet.json()).toMatchObject({ model: 'sonnet', advisorModel: 'opus' })
  // Not at or below its own model.
  expect(
    (await request('PATCH', '/api/coding-agents/coder', { advisorModel: 'sonnet' })).statusCode,
  ).toBe(400)
  expect(
    (await request('PATCH', '/api/coding-agents/coder', { advisorModel: 'gpt' })).statusCode,
  ).toBe(400)
  // A stronger model for the agent turns the advisor off rather than refusing the change.
  const upgraded = await request('PATCH', '/api/coding-agents/coder', { model: 'opus' })
  expect(upgraded.json()).toMatchObject({ model: 'opus', advisorModel: null })
  // The CLI default counts as Opus: going back to it from Sonnet turns an Opus advisor off; Fable stays allowed.
  await request('PATCH', '/api/coding-agents/coder', { model: 'sonnet', advisorModel: 'opus' })
  const toDefault = await request('PATCH', '/api/coding-agents/coder', { model: null })
  expect(toDefault.json()).toMatchObject({ model: null, advisorModel: null })
  const fable = await request('PATCH', '/api/coding-agents/coder', { advisorModel: 'fable' })
  expect(fable.json()).toMatchObject({ advisorModel: 'fable' })
  // An explicit null turns it off.
  const off = await request('PATCH', '/api/coding-agents/coder', { advisorModel: null })
  expect(off.json().advisorModel).toBeNull()
  // Only Claude Code has the setting.
  await addAgent({ id: 'agy', name: 'Agy', runtime: 'antigravity' })
  expect(
    (await request('PATCH', '/api/coding-agents/agy', { advisorModel: 'opus' })).statusCode,
  ).toBe(400)
})
