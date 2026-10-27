import { expect, test } from 'vitest'
import { rangeOf, rangeText, readWidths, widthsKey } from './table-extras.ts'

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
