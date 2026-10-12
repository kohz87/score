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
import { opencodeDriver } from '../../src/runtimes/coding/opencode.ts'
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

test('opencode is listed but cannot run', () => {
  expect(opencodeDriver.supported).toBe(false)
  expect(() => opencodeDriver.buildArgs({ ...base, permission: 'read-only' })).toThrow()
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
  for (const tool of ['Read', 'Edit']) {
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
    'not_supported',
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
    { type: 'browser', url: 'https://example.test/docs?token=abc#frag' },
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

test('codex: the next turn starts clean after a malformed one', () => {
  const parser = createCodexParser()
  const first = ['bad', agentMessage('m1', 'A'), turnCompleted].flatMap((l) => parser.parse(l))
  expect(verdictOf(first)?.eligible).toBe(false)
  const second = [agentMessage('m2', 'B'), turnCompleted].flatMap((l) => parser.parse(l))
  expect(verdictOf(second)).toMatchObject({ eligible: true, reply: 'B' })
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
