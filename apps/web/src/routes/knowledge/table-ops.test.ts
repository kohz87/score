import { expect, test } from 'vitest'
import { cellRanges, cellStarts, columnAt, modelOf, serializeTable } from './table-ops.ts'

test('canonical output: unpadded cells, delimiter row from the alignment, pipes escaped', () => {
  const model = modelOf('| a | b |\n|:--|--:|\n| x \\| y | `p` |')!
  expect(serializeTable(model)).toBe('| a | b |\n| :--- | ---: |\n| x \\| y | `p` |')
})

test('a ragged row is padded to the header width', () => {
  const model = modelOf('| a | b | c |\n| --- | --- | --- |\n| 1 |')!
  expect(serializeTable(model).split('\n')[2]).toBe('| 1 |  |  |')
})

test('cellRanges finds trimmed content, also for empty cells and rows without outer pipes', () => {
  const line = '| ab |  | c d |'
  expect(cellRanges(line).map((r) => line.slice(r.from, r.to))).toEqual(['ab', '', 'c d'])
  const bare = 'x | y'
  expect(cellRanges(bare).map((r) => bare.slice(r.from, r.to))).toEqual(['x', 'y'])
  expect(columnAt(line, 8)).toBe(1)
  expect(columnAt(line, 12)).toBe(2)
})

test('cellStarts agrees with the serialised text', () => {
  const model = modelOf('| a | b |\n| --- | --- |\n|  | z |')!
  const text = serializeTable(model)
  const starts = cellStarts(model)
  expect(text[starts[0]![1]!]).toBe('b')
  expect(text[starts[1]![1]!]).toBe('z')
  expect(starts[1]![0]).toBe(text.indexOf('|  |') + 2)
})
