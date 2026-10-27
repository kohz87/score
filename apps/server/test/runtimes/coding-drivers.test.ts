import { expect, test } from 'vitest'
import {
  claudeDriver,
  createClaudeParser,
  claudeDenyRules,
} from '../../src/runtimes/coding/claude.ts'
import {
  antigravityDriver,
  createAntigravityParser,
  parseAntigravityUsage,
} from '../../src/runtimes/coding/antigravity.ts'
import { codexDriver, createCodexParser } from '../../src/runtimes/coding/codex.ts'
import { isTestedVersion } from '../../src/runtimes/coding/drivers.ts'
import { buildChildEnv } from '../../src/runtimes/coding/env.ts'
import type { CodingEvent } from '../../src/runtimes/coding/types.ts'
import { fixtureLines } from './coding-fixtures.ts'

const parseAll = (parser: { parse(line: string): CodingEvent[] }, name: string) =>
  fixtureLines(name).flatMap((line) => parser.parse(line))

test('claude fixture: session, text, thinking, tool calls with details, usage and result', () => {
  const parser = createClaudeParser('/work')
  const events = parseAll(parser, 'claude-basic')
  expect(events.map((event) => event.kind)).toEqual([
    'session',
    'thinking',
    'text',
    'tool_start',
    'tool_end',
    'tool_start',
    'tool_end',
    'tool_start',
    'tool_end',
    'text',
    'usage',
    'result',
  ])
  expect(events[0]).toMatchObject({ sessionId: '11111111-1111-4111-8111-111111111111' })
  expect(events[3]).toMatchObject({
    tool: 'Bash',
    preview: 'ls -la',
    detail: { type: 'command', command: 'ls -la', cwd: '/work' },
  })
  expect(events[5]).toMatchObject({
    tool: 'Write',
    detail: { type: 'write', path: '/work/hello.txt' },
  })
  expect(events[7]).toMatchObject({ detail: { type: 'replace', oldString: 'world' } })
  // Text after a tool call starts a new paragraph.
  expect(events[9]).toMatchObject({ kind: 'text', text: '\n\nCreated hello.txt and changed it.' })
  expect(events[10]).toMatchObject({
    kind: 'usage',
    inputTokens: 1350,
    outputTokens: 340,
    costUsd: 0.0123,
  })
  expect(events[11]).toMatchObject({ kind: 'result', ok: true })
  // The rate-limit record (kept for the quota meter, never an event) is the one record counted as ignorable.
  expect(parser.stats).toEqual({ unknown: 0, malformed: 0 })
})

test('claude: unknown shapes and malformed lines are counted and dropped, never stored', () => {
  const parser = createClaudeParser()
  const lines = ['this line is not json', ...fixtureLines('claude-unknown')]
  const events = lines.flatMap((line) => parser.parse(line))
  expect(events.map((event) => event.kind)).toEqual(['session', 'text', 'result'])
  expect(parser.stats.malformed).toBeGreaterThanOrEqual(1)
  expect(parser.stats.unknown).toBe(3)
})

test('claude: an error result is a failed result with the CLI’s message', () => {
  const events = parseAll(createClaudeParser(), 'claude-error')
  expect(events.at(-1)).toMatchObject({
    kind: 'result',
    ok: false,
    text: 'The model request failed',
    error: 'The model request failed',
    verdict: { eligible: false, reply: null },
  })
})

test('codex fixture: thread, commands, file changes, message, usage without cost', () => {
  const parser = createCodexParser('/work')
  const events = parseAll(parser, 'codex-basic')
  expect(events.map((event) => event.kind)).toEqual([
    'session',
    'thinking',
    'tool_start',
    'tool_end',
    'tool_start',
    'tool_end',
    'tool_start',
    'tool_end',
    'tool_start',
    'tool_end',
    'text',
    'usage',
    'result',
  ])
  expect(events[2]).toMatchObject({
    tool: 'Bash',
    detail: { type: 'command', command: 'bash -lc ls', cwd: '/work' },
  })
  expect(events[3]).toMatchObject({ ok: true, exitCode: 0 })
  expect(events[4]).toMatchObject({
    detail: { type: 'file', path: '/work/notes.txt', change: 'update' },
  })
  expect(events[6]).toMatchObject({ detail: { type: 'file', change: 'add' } })
  expect(events[9]).toMatchObject({ ok: false, exitCode: 1 })
  expect(events[11]).toEqual({ kind: 'usage', inputTokens: 2400, outputTokens: 150 })
  expect(parser.stats).toEqual({ unknown: 0, malformed: 0 })
})

test('codex: a failed turn carries the CLI’s message; stray error events are not fatal', () => {
  const parser = createCodexParser()
  const events = parseAll(parser, 'codex-failed')
  expect(events.map((event) => event.kind)).toEqual(['session', 'result'])
  expect(events[1]).toMatchObject({ ok: false, error: "You've hit your usage limit." })
  expect(parser.stats.unknown).toBe(1)
})

const deny = ['/home/u/.hermes', '/home/u/.score', '/home/u/.ssh']
const base = {
  workspace: '/ws',
  prompt: '',
  model: null,
  sessionId: null,
  settingsPath: null,
  denyPaths: deny,
  denyFiles: [],
}

test('claude flag mapping per permission level', () => {
  const args = (permission: 'read-only' | 'workspace-write' | 'full', extra = {}) =>
    claudeDriver.buildArgs({ ...base, permission, ...extra })
  const read = args('read-only')
  expect(read.slice(0, 4)).toEqual(['-p', '--output-format', 'stream-json', '--verbose'])
  expect(read).toEqual(
    expect.arrayContaining(['--permission-mode', 'dontAsk', '--tools', 'Read,Grep,Glob']),
  )
  const write = args('workspace-write')
  expect(write).toEqual(
    expect.arrayContaining(['--permission-mode', 'acceptEdits', '--permission-prompts', 'none']),
  )
  expect(write.join(' ')).not.toContain('bypassPermissions')
  const full = args('full')
  expect(full).toEqual(
    expect.arrayContaining([
      '--permission-mode',
      'bypassPermissions',
      '--allow-dangerously-skip-permissions',
    ]),
  )
  // The deny rules are on every level, and the prompt is never an argument.
  for (const list of [read, write, full]) {
    expect(list[list.indexOf('--disallowed-tools') + 1]).toBe(claudeDenyRules(deny).join(','))
  }
  expect(claudeDenyRules(deny)).toEqual(
    expect.arrayContaining([
      'Read(//home/u/.hermes/**)',
      'Read(//home/u/.score/**)',
      'Read(//home/u/.ssh/**)',
      'Read(//**/.env*)',
      'Edit(//home/u/.hermes/**)',
    ]),
  )
  const resumed = args('workspace-write', {
    model: 'sonnet',
    sessionId: 'abc',
    settingsPath: '/s.json',
  })
  expect(resumed).toEqual(
    expect.arrayContaining(['--model', 'sonnet', '--resume', 'abc', '--settings', '/s.json']),
  )
})

test('codex flag mapping per permission level, new and resumed', () => {
  const args = (permission: 'read-only' | 'workspace-write' | 'full', extra = {}) =>
    codexDriver.buildArgs({ ...base, permission, ...extra })
  expect(args('read-only').slice(0, 6)).toEqual([
    'exec',
    '--json',
    '--skip-git-repo-check',
    '-s',
    'read-only',
    '-C',
  ])
  expect(args('workspace-write')).toEqual(
    expect.arrayContaining(['-s', 'workspace-write', '-C', '/ws']),
  )
  expect(args('full')).toEqual(expect.arrayContaining(['-s', 'danger-full-access']))
  expect(args('full').at(-1)).toBe('-')
  const resumed = args('read-only', { sessionId: 'thread-1', model: 'gpt-x' })
  expect(resumed.slice(0, 3)).toEqual(['exec', 'resume', 'thread-1'])
  expect(resumed).toEqual(expect.arrayContaining(['-c', 'sandbox_mode="read-only"', '-m', 'gpt-x']))
  expect(resumed).not.toContain('-C')
})

test('version gate: tested series only', () => {
  expect(isTestedVersion(claudeDriver, '2.1.295')).toBe(true)
  expect(isTestedVersion(claudeDriver, '2.10.0')).toBe(false)
  expect(isTestedVersion(claudeDriver, '3.0.0')).toBe(false)
  expect(isTestedVersion(codexDriver, '0.160.1')).toBe(true)
  expect(isTestedVersion(codexDriver, '0.161.0')).toBe(false)
  expect(claudeDriver.parseVersion('2.1.295 (Claude Code)\n')).toBe('2.1.295')
  expect(claudeDriver.parseVersion('hello')).toBeNull()
  expect(codexDriver.parseVersion('codex-cli 0.160.1')).toBe('0.160.1')
})

test('child environment is an allowlist: no Score variables, no *_API_KEY, no tokens', () => {
  const env = buildChildEnv({
    PATH: '/usr/bin',
    HOME: '/home/u',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C',
    CODEX_HOME: '/home/u/.codex',
    SCORE_HOME: '/home/u/.score',
    SCORE_PORT: '8740',
    HERMES_HOME: '/home/u/.hermes',
    OPENAI_API_KEY: 'sk-abcdefghijklmnop',
    ANTHROPIC_API_KEY: 'sk-ant-xyz',
    GITHUB_TOKEN: 'ghp_x',
    AWS_SECRET_ACCESS_KEY: 'x',
    EDITOR: 'vim',
    HTTPS_PROXY: 'http://user:pass@proxy.example:8080',
    NO_PROXY: 'localhost',
    SCORE_CODING_FAKE_LOG: '/tmp/x',
  })
  expect(env).toEqual({
    PATH: '/usr/bin',
    HOME: '/home/u',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C',
    CODEX_HOME: '/home/u/.codex',
    NO_PROXY: 'localhost',
  })
  // The fake CLI’s steering variables pass only in fake mode.
  expect(
    buildChildEnv({ SCORE_CODING_FAKE_LOG: '/tmp/x', SCORE_HOME: '/h' }, { fake: true }),
  ).toEqual({
    SCORE_CODING_FAKE_LOG: '/tmp/x',
  })
})

test('deny rules are filesystem-rooted: .env variants anywhere, credentials, and the protected folders (review: high 1)', () => {
  const rules = claudeDenyRules(deny, ['/home/u/.claude/.credentials*', '/home/u/.codex/auth*'])
  for (const tool of ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'NotebookEdit']) {
    expect(rules).toContain(`${tool}(//**/.env*)`)
    expect(rules).toContain(`${tool}(//home/u/.claude/.credentials*)`)
    expect(rules).toContain(`${tool}(//home/u/.codex/auth*)`)
    expect(rules).toContain(`${tool}(//home/u/.ssh/**)`)
  }
  // No rule left relative (a relative pattern excludes parent directories and other projects).
  expect(rules.filter((rule) => /\((?!\/\/)/.test(rule))).toEqual([])
})

test('fake mode never starts a real CLI, whatever the environment says (review: high 3)', async () => {
  const { locatorForMode } = await import('../../src/runtimes/coding/cli.ts')
  const { codexDriver: codex } = await import('../../src/runtimes/coding/codex.ts')
  const fakeMode = locatorForMode('fake', { PATH: process.env.PATH ?? '' })
  expect((await fakeMode.info()).map((item) => item.state)).toEqual([
    'not_installed',
    'not_installed',
    'not_installed',
  ])
  expect(() => fakeMode.command(codex)).toThrow(/fake mode/)
  // With the fake script it is the script that runs, never the binary.
  const scripted = locatorForMode('fake', { SCORE_CODING_FAKE_CLI: '/x/fake.mjs' })
  expect(scripted.command(codex)).toEqual({
    file: process.execPath,
    args: ['/x/fake.mjs', 'codex'],
  })
  // A live server ignores the override (outside tests).
  const live = locatorForMode('live', { SCORE_CODING_FAKE_CLI: '/x/fake.mjs' })
  expect(live.command(codex)).toEqual({ file: 'codex', args: [] })
})

test('antigravity fixtures (recorded): a text turn becomes session, text and usage without cost', () => {
  const parser = createAntigravityParser('/work')
  const events = parseAll(parser, 'antigravity-text')
  expect(events.map((event) => event.kind)).toEqual(['session', 'text', 'text', 'usage', 'result'])
  expect(events[0]).toMatchObject({ sessionId: 'aaaaaaaa-1111-4111-8111-000000000001' })
  // The closing DONE step carries the trailing newline: the reply is exactly the streamed deltas.
  expect(events.filter((e) => e.kind === 'text').map((e) => (e as { text: string }).text)).toEqual([
    'AGY-OK',
    '\n',
  ])
  expect(events[3]).toEqual({ kind: 'usage', inputTokens: 12624, outputTokens: 1567 })
  expect(events[4]).toMatchObject({ kind: 'result', ok: true, verdict: { eligible: true } })
  expect(parser.stats).toEqual({ unknown: 0, malformed: 0 })
})

test('antigravity fixtures (recorded): a refused command is a tool card plus a "refused" card, and the turn still completes', () => {
  const parser = createAntigravityParser('/work')
  const events = parseAll(parser, 'antigravity-denied')
  expect(events.map((event) => event.kind)).toEqual([
    'session',
    'tool_start',
    'tool_end',
    'usage',
    'tool_start',
    'tool_end',
    'result',
  ])
  expect(events[1]).toMatchObject({
    tool: 'run_command',
    preview: 'ls -la',
    detail: { type: 'command', command: 'ls -la', cwd: '/work' },
  })
  expect(events[4]).toMatchObject({ tool: 'Antigravity refused', preview: 'RunCommand' })
  expect(events[5]).toMatchObject({ ok: false })
  expect(events[6]).toMatchObject({ kind: 'result', ok: true })
  expect((events[6] as { text: string }).text).toContain('Antigravity refused: RunCommand')
  expect(parser.stats).toEqual({ unknown: 0, malformed: 0 })
})

test('antigravity: file, browser and plain tools map to frame details; unknown shapes are counted', () => {
  const events = parseAll(createAntigravityParser('/work'), 'antigravity-basic')
  const starts = events.filter((e) => e.kind === 'tool_start')
  expect(starts.map((e) => (e as { detail?: unknown }).detail)).toEqual([
    { type: 'command', command: 'ls -la', cwd: '/work' },
    { type: 'file', path: '/work/notes.txt', change: 'update' },
    { type: 'browser', url: 'https://example.test/docs?token=[redacted]#frag' },
    undefined,
  ])
  expect(starts[3]).toMatchObject({ tool: 'view_file', preview: '/work/notes.txt' })
  const parser = createAntigravityParser()
  const lines = ['this is not json', ...fixtureLines('antigravity-unknown')]
  const unknown = lines.flatMap((line) => parser.parse(line))
  expect(unknown.map((event) => event.kind)).toEqual(['session', 'text', 'result'])
  expect(parser.stats).toEqual({ unknown: 2, malformed: 2 })
})

test('antigravity: a failed result carries the CLI’s words, an unknown status is still a failure', () => {
  const events = parseAll(createAntigravityParser(), 'antigravity-error')
  expect(events.at(-1)).toMatchObject({
    kind: 'result',
    ok: false,
    error: 'The model request failed',
    verdict: { eligible: false },
  })
})

test('antigravity argv per permission level; the prompt is in argv, bare slash/dash prompts are wrapped', () => {
  const args = (permission: 'read-only' | 'workspace-write' | 'full', extra = {}) =>
    antigravityDriver.buildArgs({ ...base, prompt: 'hello', permission, ...extra })
  expect(args('read-only')).toEqual([
    '-p',
    'hello',
    '--output-format',
    'stream-json',
    '--mode',
    'plan',
    '--sandbox',
  ])
  expect(args('workspace-write')).toEqual([
    '-p',
    'hello',
    '--output-format',
    'stream-json',
    '--mode',
    'accept-edits',
    '--sandbox',
  ])
  expect(args('full')).toEqual([
    '-p',
    'hello',
    '--output-format',
    'stream-json',
    '--dangerously-skip-permissions',
  ])
  expect(args('read-only', { sessionId: 'abc', model: 'm1' }).slice(-4)).toEqual([
    '--conversation',
    'abc',
    '--model',
    'm1',
  ])
  expect(args('read-only', { prompt: '/usage' })[1]).toBe('Message: /usage')
  expect(args('read-only', { prompt: '--dangerously-skip-permissions' })[1]).toBe(
    'Message: --dangerously-skip-permissions',
  )
  expect(() => args('read-only', { prompt: 'x'.repeat(100_001) })).toThrow(/too long/)
  expect(antigravityDriver.promptVia).toBe('argv')
})

test('antigravity version parsing and the exact tested version', () => {
  expect(antigravityDriver.parseVersion('1.3.3\n')).toBe('1.3.3')
  expect(antigravityDriver.parseVersion('agy version 1.3.3')).toBe('1.3.3')
  expect(antigravityDriver.parseVersion('no version here')).toBeNull()
  expect(isTestedVersion(antigravityDriver, '1.3.3')).toBe(true)
  expect(isTestedVersion(antigravityDriver, '1.3.4')).toBe(false)
})

test('antigravity usage: the live `/usage` response lines become groups; anything else keeps the text', () => {
  const response =
    'Gemini Models\tWeekly Limit Remaining\t75%\t2026-10-14T02:29:49Z\nGemini Models\tFive Hour Limit Remaining\t87%\t2026-10-11T04:43:48Z\nClaude and GPT models\tFive Hour Limit Remaining\t100%\t2026-10-11T06:00:00Z\n'
  const reading = parseAntigravityUsage(JSON.stringify({ status: 'SUCCESS', response }))
  expect(reading.groups).toEqual([
    {
      name: 'Gemini Models',
      fiveHourRemainingPercent: 87,
      fiveHourResets: '2026-10-11T04:43:48Z',
      weeklyRemainingPercent: 75,
      weeklyResets: '2026-10-14T02:29:49Z',
    },
    {
      name: 'Claude and GPT models',
      fiveHourRemainingPercent: 100,
      fiveHourResets: '2026-10-11T06:00:00Z',
      weeklyRemainingPercent: null,
      weeklyResets: null,
    },
  ])
  expect(reading.text).toContain('Gemini Models')
  const odd = parseAntigravityUsage('plain words, no table')
  expect(odd.groups).toEqual([])
  expect(odd.text).toBe('plain words, no table')
})

test('antigravity: the file tools name their path by TargetFile / AbsolutePath', () => {
  const parser = createAntigravityParser('/work')
  let index = 0
  const line = (tool: string, parameters: object) =>
    JSON.stringify({
      event: 'step_update',
      step_update: {
        step_index: ++index,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: tool,
        tool_info: { name: tool, parameters },
      },
    })
  expect(
    parser.parse(line('write_to_file', { TargetFile: '/work/a.txt', CodeContent: 'secret' }))[0],
  ).toMatchObject({
    detail: { type: 'file', path: '/work/a.txt' },
  })
  expect(parser.parse(line('view_file', { AbsolutePath: '/work/b.txt' }))[0]).toMatchObject({
    preview: '/work/b.txt',
  })
})

// ---- 7.7a design section 6: the acceptance matrix per pinned driver ----------------------------------------------

const verdictOf = (events: CodingEvent[]) =>
  (events.findLast((event) => event.kind === 'result') as Extract<CodingEvent, { kind: 'result' }>)
    ?.verdict

const claudeResult = (fields: Record<string, unknown>) =>
  JSON.stringify({ type: 'result', ...fields })

test('claude: only an explicit success with text is eligible; defaults never imply success (7.7a section 6)', () => {
  const run = (fields: Record<string, unknown>) =>
    verdictOf(createClaudeParser().parse(claudeResult(fields)))
  expect(run({ subtype: 'success', is_error: false, result: 'Done.' })).toEqual({
    eligible: true,
    reply: 'Done.',
    reason: null,
  })
  // Each default is a refusal: no subtype, no is_error, no text, empty text, an error flag, another subtype.
  for (const fields of [
    { is_error: false, result: 'Done.' },
    { subtype: 'success', result: 'Done.' },
    { subtype: 'success', is_error: false },
    { subtype: 'success', is_error: false, result: '   ' },
    { subtype: 'success', is_error: true, result: 'Done.' },
    { subtype: 'error_max_turns', is_error: false, result: 'Done.' },
  ])
    expect(run(fields)?.eligible, JSON.stringify(fields)).toBe(false)
})

const codexLine = (value: unknown) => JSON.stringify(value)
const agentMessage = (id: string, text: unknown, type = 'item.completed') =>
  codexLine({ type, item: { id, type: 'agent_message', text } })
const turnCompleted = codexLine({
  type: 'turn.completed',
  usage: { input_tokens: 1, output_tokens: 1 },
})

test('codex: the reply is the last validated agent_message before turn.completed (7.7a section 6)', () => {
  const parser = createCodexParser()
  const events = [
    agentMessage('m1', 'First thoughts.'),
    agentMessage('m2', 'The final answer.'),
    turnCompleted,
  ].flatMap((line) => parser.parse(line))
  expect(verdictOf(events)).toEqual({ eligible: true, reply: 'The final answer.', reason: null })
})

test('codex: a malformed or empty agent_message, a dropped record or no message at all leaves no authority', () => {
  const run = (lines: string[]) => {
    const parser = createCodexParser()
    return verdictOf(lines.flatMap((line) => parser.parse(line)))
  }
  // A completed message with the wrong shape or no text invalidates the whole turn, even with a good one after it.
  expect(run([agentMessage('m1', 42), agentMessage('m2', 'Fine.'), turnCompleted])?.eligible).toBe(
    false,
  )
  expect(run([agentMessage('m1', ''), agentMessage('m2', 'Fine.'), turnCompleted])?.eligible).toBe(
    false,
  )
  expect(run([agentMessage('m1', '  \n'), turnCompleted])?.eligible).toBe(false)
  // An unparseable line inside the turn is a dropped record.
  expect(run([agentMessage('m1', 'Fine.'), 'not json at all', turnCompleted])?.eligible).toBe(false)
  // A turn that said nothing, and a failed turn.
  expect(run([turnCompleted])?.eligible).toBe(false)
  expect(
    run([agentMessage('m1', 'Fine.'), codexLine({ type: 'turn.failed', error: { message: 'x' } })])
      ?.eligible,
  ).toBe(false)
  // Messages still streaming (not completed) are not validated messages.
  expect(run([agentMessage('m1', 'Part', 'item.updated'), turnCompleted])?.eligible).toBe(false)
})

test('codex: a malformed agent_message (no or bad id, bad updated shape) invalidates authority, review #3', () => {
  const run = (lines: string[]) => {
    const parser = createCodexParser()
    return verdictOf(lines.flatMap((line) => parser.parse(line)))
  }
  const noId = (type = 'item.completed') =>
    codexLine({ type, item: { type: 'agent_message', text: 'Final.' } })
  const badId = codexLine({
    type: 'item.completed',
    item: { id: '', type: 'agent_message', text: 'Final.' },
  })
  expect(run([agentMessage('m1', 'Preliminary.'), noId(), turnCompleted])?.eligible).toBe(false)
  expect(run([agentMessage('m1', 'Preliminary.'), badId, turnCompleted])?.eligible).toBe(false)
  expect(
    run([agentMessage('m1', 'Preliminary.'), agentMessage('m2', 7, 'item.updated'), turnCompleted])
      ?.eligible,
  ).toBe(false)
  expect(
    run([agentMessage('m1', 'Preliminary.'), noId('item.updated'), turnCompleted])?.eligible,
  ).toBe(false)
  // The loss is sticky: a good message after it does not restore authority.
  expect(run([noId(), agentMessage('m2', 'Fine.'), turnCompleted])?.eligible).toBe(false)
})

test('codex: loss is sticky for the whole attempt; a later turn in the same stream is not authoritative either (re-review #3)', () => {
  const parser = createCodexParser()
  const first = ['bad', agentMessage('m1', 'A'), turnCompleted].flatMap((l) => parser.parse(l))
  expect(verdictOf(first)?.eligible).toBe(false)
  const second = [agentMessage('m2', 'B'), turnCompleted].flatMap((l) => parser.parse(l))
  // The first terminal closed the attempt: the second yields no verdict at all (FT #1) and the loss stays.
  expect(verdictOf(second)).toBeUndefined()
  expect(parser.lossReason?.()).toBeTruthy()
})

test('codex: an item record with no item, or a malformed started message, leaves no authority (re-review #3)', () => {
  const run = (lines: string[]) => {
    const parser = createCodexParser()
    const events = lines.flatMap((line) => parser.parse(line))
    return { verdict: verdictOf(events), loss: parser.lossReason?.() ?? null }
  }
  const nullItem = codexLine({ type: 'item.completed', item: null })
  const startedNoText = codexLine({
    type: 'item.started',
    item: { id: 'm3', type: 'agent_message' },
  })
  expect(run([agentMessage('m1', 'Final.'), nullItem, turnCompleted]).verdict?.eligible).toBe(false)
  expect(run([agentMessage('m1', 'Final.'), startedNoText, turnCompleted]).verdict?.eligible).toBe(
    false,
  )
  expect(run([agentMessage('m1', 'Final.'), turnCompleted]).loss).toBeNull()
})

test('codex: a record dropped or invalid after turn.completed still takes the authority away, asked once the stream is done (re-review #3)', () => {
  const parser = createCodexParser()
  const events = [agentMessage('m1', 'Final.'), turnCompleted].flatMap((l) => parser.parse(l))
  expect(verdictOf(events)?.eligible).toBe(true)
  expect(parser.lossReason?.()).toBeNull()
  parser.parse('not json at all')
  expect(parser.lossReason?.()).toBeTruthy()
  const other = createCodexParser()
  ;[agentMessage('m1', 'Final.'), turnCompleted].forEach((l) => other.parse(l))
  other.parse(codexLine({ type: 'item.completed', item: null }))
  expect(other.lossReason?.()).toBeTruthy()
})

test('antigravity: SUCCESS and a non-empty response are eligible, and the response wins over commentary (7.7a section 6)', () => {
  const result = (status: string, response: string | undefined) =>
    JSON.stringify({
      event: 'result',
      result: { status, ...(response === undefined ? {} : { response }) },
    })
  const parse = (status: string, response: string | undefined) =>
    verdictOf(createAntigravityParser().parse(result(status, response)))
  expect(parse('SUCCESS', 'The answer.')).toEqual({
    eligible: true,
    reply: 'The answer.',
    reason: null,
  })
  expect(parse('SUCCESS', '   ')?.eligible).toBe(false)
  expect(parse('SUCCESS', undefined)?.eligible).toBe(false)
  expect(parse('ERROR', 'The answer.')?.eligible).toBe(false)
  expect(parse('success', 'The answer.')?.eligible).toBe(false)
})

// ---- FZ1 (re-review 2026-10-12 #1, #18) ------------------------------------------------------------------------------

const runCodex = (lines: string[]) => {
  const parser = createCodexParser()
  const events = lines.flatMap((line) => parser.parse(line))
  return { events, verdict: verdictOf(events), lost: parser.lossReason?.() ?? null }
}
const finalMessage = agentMessage('m1', 'All done.')

test('#1: any rejected recognised Codex record takes the authority of the attempt, terminal ones and later ones too', () => {
  const rejected: Record<string, string> = {
    'command with no command': codexLine({
      type: 'item.completed',
      item: { id: 'c1', type: 'command_execution' },
    }),
    'file change with bad changes': codexLine({
      type: 'item.completed',
      item: { id: 'f1', type: 'file_change', changes: 'nope' },
    }),
    'mcp call without a tool': codexLine({
      type: 'item.completed',
      item: { id: 'x1', type: 'mcp_tool_call' },
    }),
    'search without a query': codexLine({
      type: 'item.completed',
      item: { id: 's1', type: 'web_search' },
    }),
    'reasoning without text': codexLine({
      type: 'item.completed',
      item: { id: 'r1', type: 'reasoning' },
    }),
  }
  for (const [name, line] of Object.entries(rejected)) {
    // Before the terminal record and after it: the verdict is decided once the whole stream was processed.
    const before = runCodex([finalMessage, line, turnCompleted])
    expect(before.verdict?.eligible, name).toBe(false)
    const after = runCodex([finalMessage, turnCompleted, line])
    expect(after.lost, name).not.toBeNull()
  }
  // Malformed terminal records.
  const badCompleted = codexLine({ type: 'turn.completed', usage: 'many' })
  const badFailed = codexLine({ type: 'turn.failed', error: 7 })
  expect(runCodex([finalMessage, turnCompleted, badFailed]).lost).not.toBeNull()
  expect(runCodex([finalMessage, badCompleted]).lost).not.toBeNull()
  expect(runCodex([finalMessage, badCompleted, turnCompleted]).verdict?.eligible).toBe(false)
  // A clean attempt keeps its authority.
  const clean = runCodex([finalMessage, turnCompleted])
  expect(clean.verdict?.eligible).toBe(true)
  expect(clean.lost).toBeNull()
})

test('#18: ids, tool details and candidate replies are bounded, and the parser reports what it really holds', () => {
  const parser = createCodexParser()
  const hugeId = 'i'.repeat(200_000)
  const events: CodingEvent[] = []
  for (let n = 0; n < 64; n++)
    events.push(
      ...parser.parse(
        codexLine({
          type: 'item.started',
          item: { id: `${hugeId}${n}`, type: 'command_execution', command: 'c'.repeat(500_000) },
        }),
      ),
    )
  const starts = events.filter((e) => e.kind === 'tool_start')
  expect(starts).toHaveLength(64)
  for (const start of starts) {
    expect(Buffer.byteLength(start.callId)).toBeLessThanOrEqual(256)
    if (start.detail?.type === 'command')
      expect(Buffer.byteLength(start.detail.command)).toBeLessThanOrEqual(16 * 1024)
  }
  // Distinct long ids stay distinct, and the same id maps to the same short id (the end pairs with the start).
  expect(new Set(starts.map((s) => s.callId)).size).toBe(64)
  expect(parser.retainedBytes!()).toBeLessThan(64 * 300)
  // A candidate reply past the limit is never an authoritative reply.
  const big = runCodex([agentMessage('m1', 'r'.repeat(300 * 1024)), turnCompleted])
  expect(big.verdict?.eligible).toBe(false)
  const ok = createCodexParser()
  ;[agentMessage('m1', 'r'.repeat(100 * 1024)), turnCompleted].forEach((l) => ok.parse(l))
  expect(ok.retainedBytes!()).toBeGreaterThanOrEqual(100 * 1024)
})

test('#18: Claude and Antigravity results and tool details are bounded too', () => {
  const claude = createClaudeParser()
  const events = claude.parse(
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 't'.repeat(10_000),
            name: 'Bash',
            input: { command: 'c'.repeat(300_000) },
          },
        ],
      },
    }),
  )
  const start = events.find((e) => e.kind === 'tool_start')!
  expect(start.kind === 'tool_start' && Buffer.byteLength(start.callId)).toBeLessThanOrEqual(256)
  const result = claude.parse(claudeResult({ result: 'r'.repeat(400 * 1024) }))
  expect(verdictOf(result)).toMatchObject({ eligible: false })
})

// ---- FW #5 -----------------------------------------------------------------------------------------------------------

test('FW #5: Codex unknown records are loss unless explicitly allow-listed', () => {
  const unknownTop = codexLine({ type: 'mystery.notice', note: 'x' })
  const unknownItem = codexLine({ type: 'item.completed', item: { id: 'u1', type: 'hologram' } })
  expect(runCodex([finalMessage, turnCompleted, unknownTop]).lost).not.toBeNull()
  expect(runCodex([finalMessage, unknownItem, turnCompleted]).verdict?.eligible).toBe(false)
  // Allow-listed: a todo list item, the retry notice.
  const todo = codexLine({ type: 'item.completed', item: { id: 't1', type: 'todo_list' } })
  const notice = codexLine({ type: 'error', message: 'Reconnecting... 1/5' })
  const clean = runCodex([finalMessage, todo, notice, turnCompleted])
  expect(clean.lost).toBeNull()
  expect(clean.verdict?.eligible).toBe(true)
})

test('FW #5: Claude Code gets the same final loss check: rejected and unknown records take the authority', () => {
  const run = (lines: string[]) => {
    const parser = createClaudeParser()
    const events = lines.flatMap((line) => parser.parse(line))
    return { verdict: verdictOf(events), lost: parser.lossReason?.() ?? null }
  }
  const success = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Done.',
  })
  const rejectedError = JSON.stringify({
    type: 'result',
    subtype: 'error',
    is_error: 'yes',
    result: 'It failed.',
  })
  expect(run([success]).lost).toBeNull()
  expect(run([success, rejectedError]).lost).not.toBeNull()
  expect(run([success, JSON.stringify({ type: 'mystery' })]).lost).not.toBeNull()
  expect(run([success, JSON.stringify({ type: 'assistant', message: 7 })]).lost).not.toBeNull()
  expect(run([success, 'not json']).lost).not.toBeNull()
  const badBlock = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash' }] },
  })
  expect(run([success, badBlock]).lost).not.toBeNull()
  // Allow-listed notices keep the authority.
  const notices = [
    JSON.stringify({ type: 'stream_event', event: {} }),
    JSON.stringify({ type: 'rate_limit_event' }),
    JSON.stringify({ type: 'system', subtype: 'hook_started' }),
  ]
  expect(run([...notices, success]).lost).toBeNull()
})

test('FW #5: Antigravity unknown records are loss; telemetry is allow-listed', () => {
  const parser = createAntigravityParser()
  parser.parse(JSON.stringify({ event: 'telemetry', x: 1 }))
  expect(parser.lossReason?.()).toBeNull()
  parser.parse(JSON.stringify({ event: 'mystery' }))
  expect(parser.lossReason?.()).not.toBeNull()
})

// ---- FV #3 -----------------------------------------------------------------------------------------------------------

test('FV #3: Codex `error` records are ignorable only as a validated retry notice before the turn ended', () => {
  const fatal = codexLine({ type: 'error', message: 'fatal: the final output was lost' })
  const retry = codexLine({ type: 'error', message: 'Reconnecting... 2/5' })
  const malformed = codexLine({ type: 'error', message: { nested: true } })
  const noMessage = codexLine({ type: 'error' })
  // The probe of re-review 4: a validated answer and turn.completed, then an error claiming fatal output loss.
  const late = runCodex([finalMessage, turnCompleted, fatal])
  expect(late.lost).not.toBeNull()
  expect(late.verdict?.eligible).toBe(true) // the verdict was already given; the final loss check takes the authority
  // A retry notice after the verdict is still too late to be a notice about the turn.
  expect(runCodex([finalMessage, turnCompleted, retry]).lost).not.toBeNull()
  // Before the verdict: an error that reports a failure, a malformed one and one without a message all lose it.
  expect(runCodex([finalMessage, fatal, turnCompleted]).lost).not.toBeNull()
  expect(runCodex([finalMessage, malformed, turnCompleted]).lost).not.toBeNull()
  expect(runCodex([finalMessage, noMessage, turnCompleted]).lost).not.toBeNull()
  // The retry notice before the verdict keeps it.
  const clean = runCodex([retry, finalMessage, turnCompleted])
  expect(clean.lost).toBeNull()
  expect(clean.verdict?.eligible).toBe(true)
})

test('FU #2: only the anchored `Reconnecting... n/m` notice is harmless; messages that merely mention a retry are loss', () => {
  const text = (message: string) => codexLine({ type: 'error', message })
  for (const message of [
    'stream disconnected: fatal output loss; no retries remain',
    'Retrying fatal',
    'reconnecting... 1/5',
    'Reconnecting... 0/5',
    'Reconnecting... 6/5',
    'Reconnecting... x/5',
    ' Reconnecting... 1/5',
    'error: Reconnecting... 1/5',
  ]) {
    expect(runCodex([finalMessage, text(message), turnCompleted]).lost, message).not.toBeNull()
    expect(runCodex([text(message), finalMessage, turnCompleted]).lost, message).not.toBeNull()
  }
  // Extra fields that could report a failure are not a plain notice either.
  const extra = codexLine({ type: 'error', message: 'Reconnecting... 1/5', fatal: true })
  expect(runCodex([extra, finalMessage, turnCompleted]).lost).not.toBeNull()
  // The anchored form, with a reason after it, is the notice.
  const reason = text('Reconnecting... 2/5 (stream disconnected before completion)')
  expect(runCodex([reason, finalMessage, turnCompleted]).lost).toBeNull()
})

test('FV #3: Claude Code system records: only known notices that report no error, and only before the result', () => {
  const run = (lines: string[]) => {
    const parser = createClaudeParser()
    const events = lines.flatMap((line) => parser.parse(line))
    return { verdict: verdictOf(events), lost: parser.lossReason?.() ?? null }
  }
  const success = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Done.',
  })
  const system = (extra: object) => JSON.stringify({ type: 'system', ...extra })
  expect(run([system({ subtype: 'hook_started' }), success]).lost).toBeNull()
  expect(run([system({ subtype: 'api_retry', error: 'overloaded' }), success]).lost).toBeNull()
  // The probe of re-review 4: an unknown system error record after a clean success.
  expect(run([success, system({ subtype: 'error', message: 'output lost' })]).lost).not.toBeNull()
  expect(run([system({ subtype: 'fatal_error' }), success]).lost).not.toBeNull()
  // A known subtype that reports an error, a record with no subtype, and a notice after the result.
  expect(run([system({ subtype: 'hook_response', is_error: true }), success]).lost).not.toBeNull()
  expect(run([system({}), success]).lost).not.toBeNull()
  expect(run([success, system({ subtype: 'hook_started' })]).lost).not.toBeNull()
  // 3.8.2: print-mode notices of Claude Code 2.1.311 (shapes from its own code), before the result.
  for (const notice of [
    { subtype: 'thinking_tokens', estimated_tokens: 1200, estimated_tokens_delta: 40 },
    {
      subtype: 'permission_denied',
      tool_name: 'Read',
      tool_use_id: 'toolu_1',
      agent_id: null,
      decision_reason_type: 'rule',
    },
    { subtype: 'background_tasks_changed', tasks: [] },
  ])
    expect(run([system(notice), success]).lost, notice.subtype).toBeNull()
  // The loss names the record's kind, never its content, and says when it came after the result.
  expect(run([system({ subtype: 'brand_new_thing', secret: 'x' }), success]).lost).toContain(
    '(system/brand_new_thing)',
  )
  expect(run([success, system({ subtype: 'thinking_tokens' })]).lost).toContain(
    '(system/thinking_tokens, after the result)',
  )
  expect(run([system({ subtype: 'Not An Identifier!' }), success]).lost).toContain('(system)')
})

// ---- PLAN 8.7: sub-agents ---------------------------------------------------------------------------------------------

test('8.7: a real Claude Code 2.1.302 turn with a sub-agent: no loss, nesting, sub-agent summary, the result', () => {
  const parser = createClaudeParser('/work/ws')
  const events = parseAll(parser, 'claude-subagent')
  expect(parser.lossReason?.() ?? null).toBeNull()
  expect(parser.stats).toEqual({ unknown: 0, malformed: 0 })
  const agentCall = events.find((event) => event.kind === 'tool_start' && event.tool === 'Agent')
  expect(agentCall).toMatchObject({ kind: 'tool_start', preview: expect.any(String) })
  expect(agentCall).not.toHaveProperty('parentCallId')
  const callId = (agentCall as { callId: string }).callId
  // The sub-agent's own tool call and its result carry the Agent call as parent.
  expect(events.filter((event) => event.kind === 'tool_start' && event.tool === 'Bash')).toEqual([
    expect.objectContaining({ parentCallId: callId }),
  ])
  const nested = events.filter((event) => event.kind === 'tool_end' && event.parentCallId)
  expect(nested).toHaveLength(1)
  // The Agent tool's own end is the main agent's: no parent.
  expect(
    events.find((event) => event.kind === 'tool_end' && event.callId === callId),
  ).not.toHaveProperty('parentCallId')
  const subs = events.filter((event) => event.kind === 'subagent')
  expect(subs.map((event) => [event.callId, event.status])).toEqual([
    [callId, 'running'],
    [callId, 'running'],
    [callId, 'done'],
    [callId, 'done'],
  ])
  expect(agentCall).toMatchObject({ preview: 'List files in folder' })
  expect(subs[0]).toMatchObject({
    description: 'List files in folder',
    subagentType: 'general-purpose',
  })
  expect(subs[1]).toMatchObject({ toolCalls: 1, durationMs: 2336, totalTokens: 15882 })
  // The sub-agent's own prose is not the turn's reply; the verdict is the result record's.
  const result = events.find((event) => event.kind === 'result')
  expect(result).toMatchObject({ ok: true, verdict: { eligible: true } })
  expect(verdictOf(events)?.reply).toContain('README.txt')
})

test('8.7: a failed sub-agent is visible on the sub-agent; the turn still follows the result record', () => {
  const lines = fixtureLines('claude-subagent').map((line) => {
    const record = JSON.parse(line) as Record<string, unknown>
    if (record.subtype === 'task_notification') record.status = 'failed'
    if (record.subtype === 'task_updated') record.patch = { status: 'failed', end_time: 1 }
    return JSON.stringify(record)
  })
  const parser = createClaudeParser('/work/ws')
  const events = lines.flatMap((line) => parser.parse(line))
  const subs = events.filter((event) => event.kind === 'subagent')
  expect(subs.at(-1)).toMatchObject({ status: 'failed' })
  expect(subs.at(-2)).toMatchObject({ status: 'failed' })
  expect(parser.lossReason?.() ?? null).toBeNull()
  expect(verdictOf(events)?.eligible).toBe(true)
  // And a failed result still fails the turn whatever the sub-agent did.
  const failedTurn = lines.map((line) => {
    const record = JSON.parse(line) as Record<string, unknown>
    if (record.type === 'result')
      return JSON.stringify({ ...record, is_error: true, subtype: 'error_during_execution' })
    return line
  })
  const second = createClaudeParser('/work/ws')
  const failed = failedTurn.flatMap((line) => second.parse(line))
  expect(verdictOf(failed)?.eligible).toBe(false)
})

test('8.7: sub-agent record shapes outside the captured ones, and unknown system subtypes, are still loss', () => {
  const run = (extra: object[]) => {
    const parser = createClaudeParser()
    const success = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Done.',
    })
    const lines = [...extra.map((record) => JSON.stringify(record)), success]
    lines.forEach((line) => parser.parse(line))
    return parser.lossReason?.() ?? null
  }
  const started = {
    type: 'system',
    subtype: 'task_started',
    task_id: 't1',
    tool_use_id: 'toolu_1',
    description: 'Look',
  }
  expect(run([started])).toBeNull()
  expect(run([{ type: 'system', subtype: 'task_made_up', task_id: 't1' }])).not.toBeNull()
  expect(run([{ ...started, task_id: undefined }])).not.toBeNull()
  expect(run([{ ...started, is_error: true }])).not.toBeNull()
  expect(run([{ ...started, tool_use_id: '' }])).not.toBeNull()
  // task_updated for a task that never started cannot be placed.
  expect(
    run([
      { type: 'system', subtype: 'task_updated', task_id: 'ghost', patch: { status: 'completed' } },
    ]),
  ).not.toBeNull()
  expect(
    run([started, { type: 'system', subtype: 'task_updated', task_id: 't1', patch: 'completed' }]),
  ).not.toBeNull()
  // Progress with a malformed usage block.
  expect(
    run([{ ...started, subtype: 'task_progress', usage: { total_tokens: 'many' } }]),
  ).not.toBeNull()
  // After the result they are as suspicious as any other notice.
  const parser = createClaudeParser()
  parser.parse(
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done.' }),
  )
  parser.parse(JSON.stringify(started))
  expect(parser.lossReason?.()).not.toBeNull()
})

test('a real Claude Code read-only turn (record order and shapes captured 2026-10-13, ids stripped) keeps its success', () => {
  const parser = createClaudeParser()
  const lines = [
    {
      type: 'system',
      subtype: 'init',
      session_id: '88888888-8888-4888-8888-888888888888',
      tools: [],
      cwd: '/w',
    },
    {
      type: 'system',
      subtype: 'commands_changed',
      session_id: '88888888-8888-4888-8888-888888888888',
      commands: [],
    },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } },
    { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1 },
  ]
  const events = lines.flatMap((line) => parser.parse(JSON.stringify(line)))
  expect(parser.lossReason?.() ?? null).toBeNull()
  expect(verdictOf(events)?.eligible).toBe(true)
})

// ---- FT #1 (re-review 6): one terminal per attempt -----------------------------------------------------------------

test('FT #1: codex turn.failed followed by a message and turn.completed is loss; the failure is never replaced', () => {
  const parser = createCodexParser()
  const events = [
    codexLine({ type: 'turn.failed', error: { message: 'x' } }),
    agentMessage('m1', 'All done.'),
    turnCompleted,
  ].flatMap((line) => parser.parse(line))
  expect(events.filter((event) => event.kind === 'result')).toHaveLength(1)
  expect(verdictOf(events)?.eligible).toBe(false)
  expect(parser.lossReason?.()).toBeTruthy()
})

test('FT #1: codex turn.completed followed by turn.failed, or by a second completion, is loss', () => {
  for (const second of [
    codexLine({ type: 'turn.failed', error: { message: 'x' } }),
    turnCompleted,
  ]) {
    const parser = createCodexParser()
    const events = [agentMessage('m1', 'Done.'), turnCompleted, second].flatMap((line) =>
      parser.parse(line),
    )
    expect(events.filter((event) => event.kind === 'result')).toHaveLength(1)
    expect(parser.lossReason?.()).toBeTruthy()
  }
})

test('FT #1: claude error result followed by an explicit success is loss and the first result stands', () => {
  const parser = createClaudeParser()
  const events = [
    claudeResult({ subtype: 'error_during_execution', is_error: true, result: 'x' }),
    claudeResult({ subtype: 'success', is_error: false, result: 'Done.' }),
  ].flatMap((line) => parser.parse(line))
  expect(events.filter((event) => event.kind === 'result')).toHaveLength(1)
  expect(verdictOf(events)?.eligible).toBe(false)
  expect(parser.lossReason?.()).toBeTruthy()
})

test('fix-argon A2: Claude Code activity after the result (assistant text or tool use, a tool result) takes the authority away', () => {
  const baseLines = fixtureLines('claude-basic')
  const after: Record<string, string> = {
    text: JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'One more thing.' }] },
    }),
    stringText: JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: 'One more thing.' },
    }),
    toolUse: JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_late', name: 'Bash', input: { command: 'rm x' } }],
      },
    }),
    toolResult: JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'late', is_error: false },
        ],
      },
    }),
  }
  const clean = createClaudeParser('/work')
  baseLines.forEach((line) => clean.parse(line))
  expect(clean.lossReason?.()).toBeNull()
  for (const [name, line] of Object.entries(after)) {
    const parser = createClaudeParser('/work')
    baseLines.forEach((l) => parser.parse(l))
    parser.parse(line)
    expect(parser.lossReason?.(), name).toBeTruthy()
  }
})

test('fix-argon A2: a Codex tool or command item after turn.completed takes the authority away', () => {
  const items = [
    codexLine({
      type: 'item.started',
      item: { id: 'c9', type: 'command_execution', command: 'rm x', status: 'in_progress' },
    }),
    codexLine({
      type: 'item.completed',
      item: {
        id: 'f9',
        type: 'file_change',
        changes: [{ path: '/w/x', kind: 'add' }],
        status: 'completed',
      },
    }),
    codexLine({
      type: 'item.completed',
      item: { id: 'w9', type: 'web_search', query: 'q' },
    }),
  ]
  for (const line of items) {
    const parser = createCodexParser()
    ;[agentMessage('m1', 'Final.'), turnCompleted].forEach((l) => parser.parse(l))
    expect(parser.lossReason?.()).toBeNull()
    parser.parse(line)
    expect(parser.lossReason?.(), line).toBeTruthy()
  }
})

test('3.9.0: effort is passed only when set and listed for the runtime (chat and worker launches alike)', () => {
  const claude = (extra = {}) =>
    claudeDriver.buildArgs({ ...base, permission: 'read-only', ...extra })
  expect(claude()).not.toContain('--effort')
  expect(claude({ effort: null })).not.toContain('--effort')
  const withEffort = claude({ effort: 'xhigh' })
  expect(withEffort[withEffort.indexOf('--effort') + 1]).toBe('xhigh')
  expect(claude({ effort: 'xhigh', worker: true })).toContain('--effort')
  for (const bad of ['minimal', 'High', '--x', 'a b', ''])
    expect(claude({ effort: bad })).not.toContain('--effort')

  const codex = (extra = {}) =>
    codexDriver.buildArgs({ ...base, permission: 'read-only', ...extra })
  expect(codex().join(' ')).not.toContain('model_reasoning_effort')
  for (const sessionId of [null, 'abc']) {
    const args = codex({ effort: 'minimal', sessionId })
    expect(args[args.indexOf('model_reasoning_effort="minimal"') - 1]).toBe('-c')
    expect(args.at(-1)).toBe('-')
  }
  expect(codex({ effort: 'max' }).join(' ')).not.toContain('model_reasoning_effort')
  expect(codex({ effort: 'x"; rm' }).join(' ')).not.toContain('model_reasoning_effort')
})
