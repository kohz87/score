import { expect, test } from 'vitest'
import {
  heightsKey,
  rangeOf,
  rangeText,
  readHeights,
  readWidths,
  scaleWidths,
  widthsKey,
  writeHeights,
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

test('stored widths are used only when they fit the table', () => {
  const key = widthsKey('n.md', ['A', 'B'])
  localStorage.setItem(key, '[10, 200.4]')
  expect(readWidths(key, 2)).toEqual([48, 200])
  expect(readWidths(key, 3)).toBeNull()
  localStorage.setItem(key, 'not json')
  expect(readWidths(key, 2)).toBeNull()
})

test('the corner grip scales every column alike, never below the minimum', () => {
  expect(scaleWidths([100, 200], 600)).toEqual([200, 400])
  expect(scaleWidths([100, 200], 10)).toEqual([48, 64])
})

test('row heights: a reset row is null, all-null clears the key, a wrong row count is ignored', () => {
  const key = heightsKey('n.md', ['A'])
  writeHeights(key, [null, 60.4, null])
  expect(readHeights(key, 3)).toEqual([null, 60, null])
  expect(readHeights(key, 2)).toBeNull()
  writeHeights(key, [null, null, null])
  expect(localStorage.getItem(key)).toBeNull()
})
