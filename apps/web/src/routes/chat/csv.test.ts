import { expect, test } from 'vitest'
import { parseCsv } from './csv.ts'

test('parses quoted fields, escaped quotes and newlines inside quotes', () => {
  expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n"l1\nl2",z\n').rows).toEqual([
    ['a', 'b'],
    ['x, y', 'say "hi"'],
    ['l1\nl2', 'z'],
  ])
})

test('picks semicolon or tab when the header uses it, and drops a BOM', () => {
  expect(parseCsv('﻿a;b\n1;2').rows).toEqual([
    ['a', 'b'],
    ['1', '2'],
  ])
  expect(parseCsv('a\tb\n1\t2').rows).toEqual([
    ['a', 'b'],
    ['1', '2'],
  ])
})

test('stops at the row limit and says so, but not when only blank lines follow', () => {
  const text = Array.from({ length: 1500 }, (_, i) => `${i},x`).join('\n')
  const cut = parseCsv(text)
  expect(cut.rows).toHaveLength(1000)
  expect(cut.truncated).toBe(true)
  const exact = parseCsv('1\n2\n\n', 2)
  expect(exact.rows).toHaveLength(2)
  expect(exact.truncated).toBe(false)
})

test('empty input has no rows and a missing final newline keeps the last row', () => {
  expect(parseCsv('').rows).toEqual([])
  expect(parseCsv('a,b').rows).toEqual([['a', 'b']])
})
