import { expect, test } from 'vitest'
import { normalizeTables } from './tables.ts'

// 3.7.11 (owner): a table a model wrote without its separator row shows as a table.

test('a pipe table without a separator row gets one, with a blank line around it', () => {
  const text = [
    'Below is a proposed revision table.',
    'No. / Card | Proposed version | Main improvement',
    '1. Forced Displacement | Each player must teleport. | Guarantees displacement.',
    '2. Terrain Collapse | Each player destroys 1 tile. | Less board destruction.',
    'Notes follow.',
  ].join('\n')
  expect(normalizeTables(text)).toBe(
    [
      'Below is a proposed revision table.',
      '',
      '| No. / Card | Proposed version | Main improvement |',
      '| --- | --- | --- |',
      '| 1. Forced Displacement | Each player must teleport. | Guarantees displacement. |',
      '| 2. Terrain Collapse | Each player destroys 1 tile. | Less board destruction. |',
      '',
      'Notes follow.',
    ].join('\n'),
  )
})

test('a real Markdown table, two lines, mixed cell counts and empty cells are left alone', () => {
  const real = 'x\n| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |\n| 7 | 8 |'
  expect(normalizeTables(real)).toBe(real)
  const two = 'a | b\n1 | 2'
  expect(normalizeTables(two)).toBe(two)
  const mixed = 'a | b\n1 | 2 | 3\nx | y'
  expect(normalizeTables(mixed)).toBe(mixed)
  const empty = 'a | b\n | 2\nx | y'
  expect(normalizeTables(empty)).toBe(empty)
  const prose = 'Use a | b for pipes.\nOr not.'
  expect(normalizeTables(prose)).toBe(prose)
})

test('fenced code keeps its pipes byte for byte', () => {
  const code = '```sh\nls | grep a | wc\ncat x | sort | uniq\nps | head | tail\n```'
  expect(normalizeTables(code)).toBe(code)
})
