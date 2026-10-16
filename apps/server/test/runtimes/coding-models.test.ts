import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CodingModelsResponseSchema } from '@score/contract'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  CLAUDE_CODE_ALIASES,
  aliasModels,
  parseAntigravityModels,
  parseCodexModels,
  readCodexModels,
} from '../../src/runtimes/coding/models.ts'

// PLAN 8.5 (decision 86): model lists. The `agy models` text is the real output captured 2026-10-16; the Codex cache is
// a hand-made fixture with the same top-level keys, including an identity that must never come out.
const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../fixtures/coding/${name}`, import.meta.url)), 'utf8')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-models-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('agy models: every id<TAB>name line becomes an option, in order', () => {
  const models = parseAntigravityModels(fixture('antigravity-models.txt'))
  expect(models).toHaveLength(13)
  expect(models[0]).toEqual({ id: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' })
  expect(models.at(-1)).toEqual({ id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' })
})

test('agy models: lines that are not exactly id<TAB>name, unsafe ids and repeats are dropped', () => {
  const text = [
    'Available models:',
    'good-one\tGood one',
    'no tab here',
    'a\tb\tc',
    'bad id\tSpaces in the id',
    '--flag\tLooks like a flag',
    '$(rm)\tShell',
    'good-one\tRepeated',
    '',
  ].join('\n')
  expect(parseAntigravityModels(text)).toEqual([{ id: 'good-one', name: 'Good one' }])
  expect(parseAntigravityModels('')).toEqual([])
})

test('Codex cache: keeps the listed models with their reasoning levels, drops hidden and unsafe ones', () => {
  expect(parseCodexModels(fixture('codex-models-cache.json'))).toEqual([
    {
      id: 'gpt-6.1-sol',
      name: 'GPT-6.1 Sol',
      description: 'Fast, capable coding model.',
      efforts: ['low', 'medium', 'high'],
    },
    {
      id: 'gpt-6.1-mini',
      name: 'GPT-6.1 Mini',
      description: 'Smaller and cheaper.',
      efforts: ['low', 'medium'],
    },
  ])
  expect(parseCodexModels('not json')).toEqual([])
  expect(parseCodexModels('{"models":"x"}')).toEqual([])
})

test('Codex cache: the account identity and every other field never appear in any output or log', () => {
  const home = join(dir, 'codex')
  mkdirSync(home)
  writeFileSync(join(home, 'models_cache.json'), fixture('codex-models-cache.json'))
  const logged: unknown[] = []
  const spies = (['log', 'info', 'warn', 'error'] as const).map((name) =>
    vi.spyOn(console, name).mockImplementation((...args: unknown[]) => void logged.push(args)),
  )
  const response = readCodexModels(home)
  spies.forEach((spy) => spy.mockRestore())
  expect(CodingModelsResponseSchema.parse(response).source).toBe('cache')
  const everything = JSON.stringify([response, logged])
  for (const secret of [
    'someone@example.invalid',
    'acct-FAKE-0001',
    'identity',
    'etag',
    'W/',
    '0.160.1',
  ])
    expect(everything).not.toContain(secret)
  expect(Object.keys(response.models[0]!).sort()).toEqual(['description', 'efforts', 'id', 'name'])
})

test('Codex cache: a missing file, a symlink, a directory, a huge file and junk all give the free-text answer', () => {
  const none = { models: [], source: 'none' }
  const home = join(dir, 'codex')
  mkdirSync(home)
  expect(readCodexModels(home)).toEqual(none)
  const real = join(dir, 'real.json')
  writeFileSync(real, fixture('codex-models-cache.json'))
  symlinkSync(real, join(home, 'models_cache.json'))
  expect(readCodexModels(home)).toEqual(none)
  rmSync(join(home, 'models_cache.json'))
  mkdirSync(join(home, 'models_cache.json'))
  expect(readCodexModels(home)).toEqual(none)
  rmSync(join(home, 'models_cache.json'), { recursive: true })
  writeFileSync(join(home, 'models_cache.json'), 'x'.repeat(2 * 1024 * 1024 + 1))
  expect(readCodexModels(home)).toEqual(none)
  writeFileSync(join(home, 'models_cache.json'), '{"models":[{"slug":"a b"}]}')
  expect(readCodexModels(home)).toEqual(none)
})

test('Codex cache: auth.json next to it is never opened', () => {
  const home = join(dir, 'codex')
  mkdirSync(home)
  writeFileSync(join(home, 'models_cache.json'), fixture('codex-models-cache.json'))
  // A directory named auth.json would make any open() of it throw; reading must not care.
  mkdirSync(join(home, 'auth.json'))
  expect(readCodexModels(home).source).toBe('cache')
})

test('Claude Code: the documented aliases, and no other runtime has any', () => {
  expect(aliasModels('claude-code')).toEqual({ models: CLAUDE_CODE_ALIASES, source: 'aliases' })
  expect(CLAUDE_CODE_ALIASES.map((model) => model.id)).toEqual(['fable', 'opus', 'sonnet'])
  expect(aliasModels('codex')).toBe(null)
  expect(aliasModels('antigravity')).toBe(null)
})
