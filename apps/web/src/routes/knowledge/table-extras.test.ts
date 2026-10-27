import { expect, test } from 'vitest'
import {
  heightsKey,
  rangeOf,
  rangeText,
  readHeights,
  readWidths,
  scaleWidths,
  toSize,
  widthsKey,
  writeHeights,
  writeWidths,
} from './table-extras.ts'

test('a range is the rectangle between two cells, either way round', () => {
  expect(rangeOf({ row: 3, column: 0 }, { row: 1, column: 2 })).toEqual({
    r0: 1,
    c0: 0,
    r1: 3,
    c1: 2,
  })
})

test('copied cells are tab-separated text and an escaped HTML table', () => {
  expect(
    rangeText([
      ['a\tb', '<x>'],
      ['1', '2'],
    ]),
  ).toEqual({
    plain: 'a b\t<x>\n1\t2',
    html: '<table><tr><td>a\tb</td><td>&lt;x&gt;</td></tr><tr><td>1</td><td>2</td></tr></table>',
  })
})

test('a size is relative: the table to its space, each column to the table (3.8.5)', () => {
  expect(toSize([200, 600], 1000)).toEqual({ table: 0.8, cols: [0.25, 0.75], px: 800 })
  const key = widthsKey('n.md', ['A', 'B'])
  writeWidths(key, { table: 1.5, cols: [0.25, 0.75] })
  expect(readWidths(key, 2)).toEqual({ table: 1.5, cols: [0.25, 0.75] })
  expect(readWidths(key, 3)).toBeNull()
  // Pixel arrays from before don't fit another screen: dropped.
  localStorage.setItem(key, '[180, 90]')
  expect(readWidths(key, 2)).toBeNull()
  localStorage.setItem(key, 'not json')
  expect(readWidths(key, 2)).toBeNull()
})

test('the corner grip scales every column alike, never below the minimum', () => {
  expect(scaleWidths([100, 200], 600)).toEqual([200, 400])
  expect(scaleWidths([100, 200], 10)).toEqual([48, 64])
})

test('row heights: a reset row is null, all-null clears the key, a wrong row count is ignored', () => {
  const key = heightsKey('n.md', ['A'])
  writeHeights(key, [null, 3.456, null])
  expect(readHeights(key, 3)).toEqual([null, 3.46, null])
  expect(readHeights(key, 2)).toBeNull()
  writeHeights(key, [null, null, null])
  expect(localStorage.getItem(key)).toBeNull()
})
