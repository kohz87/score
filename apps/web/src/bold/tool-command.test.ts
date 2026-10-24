import { expect, test } from 'vitest'
import { parseToolCommand } from './tool-command.ts'

test('a command is split on spaces and quoted arguments stay one argument', () => {
  expect(parseToolCommand('npx -y @example/tickets')).toEqual({
    ok: true,
    argv: ['npx', '-y', '@example/tickets'],
  })
  expect(parseToolCommand('node server.mjs --title "My tickets app"')).toEqual({
    ok: true,
    argv: ['node', 'server.mjs', '--title', 'My tickets app'],
  })
  expect(parseToolCommand("npx tool --name='tickets app'")).toEqual({
    ok: true,
    argv: ['npx', 'tool', '--name=tickets app'],
  })
})

test('escaped spaces and empty quoted arguments survive the split', () => {
  expect(parseToolCommand('tool one\\ two ""')).toEqual({
    ok: true,
    argv: ['tool', 'one two', ''],
  })
  expect(parseToolCommand('tool --token="abc def"')).toEqual({
    ok: true,
    argv: ['tool', '--token=abc def'],
  })
})

test('an unclosed quote and an empty command are refused', () => {
  expect(parseToolCommand('tool "unclosed')).toEqual({
    ok: false,
    error: 'Close the quote in the command.',
  })
  expect(parseToolCommand('   ')).toEqual({ ok: false, error: 'Type a command to run.' })
})
