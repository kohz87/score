import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { DRIVERS } from '../../src/runtimes/coding/drivers.ts'
import { helpMismatch } from '../../src/runtimes/coding/help-check.ts'

// 3.7.7 (decision 138): Score's own check of a new CLI version, from help text only.

const help = (name: string) =>
  readFileSync(join(import.meta.dirname, '../fixtures/coding/help', `${name}.txt`), 'utf8')
const claude = DRIVERS['claude-code'].worker!.help
const codex = DRIVERS.codex.worker!.help

test('the help of Claude Code 2.1.311 and Codex 0.164.0 documents every flag as declared', () => {
  expect(helpMismatch(help('claude-code'), claude)).toBeNull()
  expect(helpMismatch(help('codex'), codex)).toBeNull()
})

test('every flag a worker launch neutralises is in the help check', () => {
  for (const driver of [DRIVERS['claude-code'], DRIVERS.codex]) {
    const checked = driver.worker!.help.flags.map((entry) => entry.flag)
    for (const { flag } of driver.worker!.neutralised) expect(checked).toContain(flag)
  }
})

test('a changed description, a dropped choice or a missing flag names the flag', () => {
  expect(
    helpMismatch(
      help('claude-code').replace('ignoring all other MCP configurations', 'and the others'),
      claude,
    ),
  ).toBe('--strict-mcp-config')
  expect(helpMismatch(help('claude-code').replace('"dontAsk", ', ''), claude)).toBe(
    '--permission-mode',
  )
  const withoutRules = help('codex')
    .split('\n')
    .filter((line) => !/--ignore-rules|execpolicy/.test(line))
    .join('\n')
  expect(helpMismatch(withoutRules, codex)).toBe('--ignore-rules')
  expect(helpMismatch('', codex)).toBe('--config')
})

test('a wrapped description that starts with a flag name is not that flag’s entry', () => {
  const text = [
    'Options:',
    '  --verbose        Override verbose mode setting from config',
    '                   --strict-mcp-config Only use MCP servers from --mcp-config, ignoring all other MCP configurations',
  ].join('\n')
  expect(
    helpMismatch(text, {
      args: [],
      flags: [
        {
          flag: '--strict-mcp-config',
          phrases: ['Only use MCP servers from --mcp-config'],
        },
      ],
    }),
  ).toBe('--strict-mcp-config')
})

test('whitespace and line wrapping don’t matter', () => {
  const text =
    '  --settings <file-or-json>   Path to a settings JSON file or a JSON\n        string to load additional settings from\n'
  expect(
    helpMismatch(text, {
      args: [],
      flags: [
        {
          flag: '--settings',
          phrases: [
            'Path to a settings JSON file or a JSON string to load additional settings from',
          ],
        },
      ],
    }),
  ).toBeNull()
})
