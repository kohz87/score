import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { DRIVERS } from '../../src/runtimes/coding/drivers.ts'
import {
  buildPolicy,
  canonicalJson,
  fileIdentity,
  PolicyUnverifiable,
  policyIdOf,
  type PolicyContext,
  type PolicyInputs,
} from '../../src/runtimes/coding/policy.ts'

// 7.7b-2 §3: the per-driver neutralise/bind declaration, and the policy computed from it. Nothing here starts a CLI or reads
// a configuration file; the opt-in help check runs `--help` only (never a prompt).

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      chmodSync(dir, 0o700)
    } catch {
      // gone
    }
    rmSync(dir, { recursive: true, force: true })
  }
})
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'score-policy-'))
  dirs.push(dir)
  return dir
}

describe('the declarations', () => {
  test('only Claude Code and Codex declare what they neutralise and bind; every tested version is declared', () => {
    expect(
      Object.keys(DRIVERS).filter((runtime) => DRIVERS[runtime as keyof typeof DRIVERS].worker),
    ).toEqual(['claude-code', 'codex'])
    for (const driver of [DRIVERS['claude-code'], DRIVERS.codex])
      for (const version of driver.testedVersions)
        expect(driver.worker!.versions).toContain(version)
  })

  test('worker flags are added for a worker launch only', () => {
    const base = {
      workspace: '/w',
      prompt: '',
      permission: 'read-only' as const,
      model: null,
      sessionId: null,
      settingsPath: '/s.json',
      denyPaths: [],
      denyFiles: [],
    }
    const claude = DRIVERS['claude-code']
    const codex = DRIVERS.codex
    expect(claude.buildArgs(base)).not.toContain('--strict-mcp-config')
    expect(claude.buildArgs({ ...base, worker: true })).toContain('--strict-mcp-config')
    expect(codex.buildArgs(base)).not.toContain('--ignore-user-config')
    expect(codex.buildArgs({ ...base, worker: true })).toEqual(
      expect.arrayContaining(['--ignore-user-config', '--ignore-rules']),
    )
    // Every neutralised flag the declaration names is in the worker argv.
    for (const [driver, args] of [
      [claude, claude.buildArgs({ ...base, worker: true })],
      [codex, codex.buildArgs({ ...base, worker: true })],
    ] as const)
      for (const item of driver.worker!.neutralised) expect(args).toContain(item.flag)
  })

  test('no credential file is ever among the bound sources', () => {
    for (const driver of [DRIVERS['claude-code'], DRIVERS.codex]) {
      const paths = driver.worker!.bound({ home: '/home/x', workspace: '/home/x/project', env: {} })
      expect(paths.length).toBeGreaterThan(5)
      for (const path of paths)
        expect(path).not.toMatch(/auth\.json|credentials|\.env|\.ssh|token/i)
    }
  })

  // Opt-in: asks the installed CLIs for `--help` (no prompt, no model) and checks every flag a declaration relies on is
  // documented there. SCORE_TEST_CLI_HELP=1 pnpm --filter @score/server test coding-worker-policy
  test.skipIf(!process.env['SCORE_TEST_CLI_HELP'])(
    'the installed CLIs document every flag the declarations use (help output only)',
    () => {
      const help = (file: string, args: string[]) =>
        execFileSync(file, args, { encoding: 'utf8', timeout: 20_000 })
      const claude = help('claude', ['--help'])
      for (const flag of [
        '--strict-mcp-config',
        '--setting-sources',
        '--settings',
        '--permission-mode',
      ])
        expect(claude).toContain(flag)
      const codex = help('codex', ['exec', '--help'])
      for (const flag of ['--ignore-user-config', '--ignore-rules', '--sandbox', '--config'])
        expect(codex).toContain(flag)
    },
  )
})

describe('the policy', () => {
  function world() {
    const root = temp()
    const home = join(root, 'home')
    const workspace = join(root, 'ws')
    const cli = join(root, 'claude')
    mkdirSync(home)
    mkdirSync(workspace)
    writeFileSync(cli, '#!/bin/sh\n')
    const inputs: PolicyInputs = {
      runtime: 'claude-code',
      permission: 'workspace-write',
      model: null,
      workspace,
      version: '2.1.295',
    }
    const context: PolicyContext = {
      home,
      env: { PATH: '/usr/bin', HOME: home, LC_ALL: 'sentinel-env-value-42' },
      settingsDir: join(root, 'settings'),
      denyPaths: ['/deny'],
      denyFiles: [],
      command: { file: cli, args: [] },
      settingsOnDisk: false,
    }
    return { root, home, workspace, cli, inputs, context }
  }

  test('an unlisted version passes only when Score checked it itself (3.7.7)', () => {
    const { inputs, context } = world()
    const newer = { ...inputs, version: '2.1.399' }
    expect(() => buildPolicy(newer, context)).toThrow(PolicyUnverifiable)
    expect(() =>
      buildPolicy(newer, { ...context, checkedVersions: new Set(['codex@2.1.399']) }),
    ).toThrow(PolicyUnverifiable)
    expect(
      buildPolicy(newer, { ...context, checkedVersions: new Set(['claude-code@2.1.399']) }).cli
        .version,
    ).toBe('2.1.399')
  })

  test('canonical JSON is key-order independent and the id is the hash of it', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(
      canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }),
    )
    const { inputs, context } = world()
    const policy = buildPolicy(inputs, context)
    expect(policyIdOf(policy)).toBe(policyIdOf(buildPolicy(inputs, context)))
    expect(policyIdOf(policy)).toMatch(/^[0-9a-f]{64}$/)
  })

  test('every input the policy binds changes the id; environment values appear nowhere in it', () => {
    const { inputs, context, home, cli } = world()
    const id = (i = inputs, c = context) => policyIdOf(buildPolicy(i, c))
    const base = id()
    expect(id({ ...inputs, permission: 'read-only' })).not.toBe(base)
    expect(id({ ...inputs, model: 'm' })).not.toBe(base)
    expect(id({ ...inputs, version: '2.1.296' })).not.toBe(base)
    expect(id(inputs, { ...context, env: { ...context.env, LC_ALL: 'other' } })).not.toBe(base)
    expect(id(inputs, { ...context, denyPaths: ['/deny', '/more'] })).not.toBe(base)
    // A bound configuration file appearing, then changing size, shows in the id (identity only).
    mkdirSync(join(home, '.claude'))
    const settings = join(home, '.claude', 'settings.json')
    writeFileSync(settings, '{}')
    const withFile = id(inputs, {
      ...context,
      env: { ...context.env, CLAUDE_CONFIG_DIR: join(home, '.claude') },
    })
    expect(withFile).not.toBe(base)
    writeFileSync(settings, '{"a":1}')
    expect(
      id(inputs, { ...context, env: { ...context.env, CLAUDE_CONFIG_DIR: join(home, '.claude') } }),
    ).not.toBe(withFile)
    // The CLI file replaced.
    writeFileSync(cli, '#!/bin/sh\n# newer\n')
    expect(id()).not.toBe(base)
    expect(JSON.stringify(buildPolicy(inputs, context))).not.toContain('sentinel-env-value-42')
  })

  test('a version the driver has not verified, an unreadable source and a missing CLI are unverifiable', () => {
    const { inputs, context, workspace, root } = world()
    expect(() => buildPolicy({ ...inputs, version: '0.0.1' }, context)).toThrow(PolicyUnverifiable)
    expect(() => buildPolicy({ ...inputs, workspace: join(root, 'missing') }, context)).toThrow(
      PolicyUnverifiable,
    )
    expect(() =>
      buildPolicy(inputs, { ...context, command: { file: join(root, 'nope'), args: [] } }),
    ).toThrow(PolicyUnverifiable)
    // A folder Score may not even look into (EACCES on a source below it) can't be bound: the reach is unverifiable.
    const closed = join(workspace, '.claude')
    mkdirSync(closed)
    chmodSync(closed, 0o000)
    expect(() => buildPolicy(inputs, context)).toThrow(PolicyUnverifiable)
    chmodSync(closed, 0o700)
    expect(() => buildPolicy(inputs, context)).not.toThrow()
  })

  test('file identity is stat only: absent, present, and an unreadable file still has one', () => {
    const root = temp()
    const file = join(root, 'f')
    expect(fileIdentity(file)).toBe('absent')
    expect(fileIdentity(join(file, 'below'))).toBe('absent')
    writeFileSync(file, 'secret')
    chmodSync(file, 0o000)
    expect(fileIdentity(file)).toMatchObject({ size: 6 })
  })
})
