import { expect, test } from 'vitest'
import {
  claudeDriver,
  createClaudeParser,
  CLAUDE_DENY_RULES,
} from '../../src/runtimes/coding/claude.ts'
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
  expect(events.at(-1)).toEqual({
    kind: 'result',
    ok: false,
    text: 'The model request failed',
    error: 'The model request failed',
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

const base = { workspace: '/ws', model: null, sessionId: null, settingsPath: null }

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
    expect(list[list.indexOf('--disallowed-tools') + 1]).toBe(CLAUDE_DENY_RULES.join(','))
  }
  expect(CLAUDE_DENY_RULES).toEqual(
    expect.arrayContaining([
      'Read(~/.hermes/**)',
      'Read(~/.score/**)',
      'Read(~/.ssh/**)',
      'Read(**/.env)',
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
