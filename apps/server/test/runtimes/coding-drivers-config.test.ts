import { expect, test } from 'vitest'
import { claudeDriver, claudeDenyRules } from '../../src/runtimes/coding/claude.ts'
import { antigravityDriver, parseAntigravityUsage } from '../../src/runtimes/coding/antigravity.ts'
import { codexDriver } from '../../src/runtimes/coding/codex.ts'
import { isTestedVersion } from '../../src/runtimes/coding/drivers.ts'
import { buildChildEnv } from '../../src/runtimes/coding/env.ts'
import { base, deny } from './coding-drivers-helpers.ts'

test('3.14.1: the advisor on call adds --advisor with its model and nothing else', () => {
  const args = claudeDriver.buildArgs({
    ...base,
    permission: 'workspace-write',
    advisorModel: 'opus',
  })
  const plain = claudeDriver.buildArgs({ ...base, permission: 'workspace-write' })
  expect(args[args.indexOf('--advisor') + 1]).toBe('opus')
  expect(args.filter((arg) => arg !== '--advisor' && arg !== 'opus')).toEqual(plain)
  expect(plain).not.toContain('--advisor')
})

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
