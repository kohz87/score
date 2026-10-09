import { describe, expect, test } from 'vitest'
import {
  DOCX_TYPE,
  XLSX_TYPE,
  declaredMatches,
  isPlainText,
  sniffMedia,
} from '../src/media/sniff.ts'
import { docx, pdf, png, xlsx, zip } from './media-fixtures.ts'

const text = (value: string) => Buffer.from(value)

describe('sniffMedia', () => {
  test('recognises documents by their bytes, not their name', () => {
    expect(sniffMedia(pdf(), { name: 'x.txt' })).toBe('application/pdf')
    expect(sniffMedia(docx(), { name: 'x.pdf' })).toBe(DOCX_TYPE)
    expect(sniffMedia(xlsx())).toBe(XLSX_TYPE)
    expect(sniffMedia(png(), { name: 'x.csv' })).toBe('image/png')
  })

  test('rejects zips that are not Word or Excel, and truncated zips', () => {
    expect(sniffMedia(zip(['a.txt']))).toBeNull()
    expect(sniffMedia(zip(['[Content_Types].xml']))).toBeNull()
    expect(sniffMedia(docx().subarray(0, 40))).toBeNull()
    const damaged = docx()
    damaged.writeUInt32LE(0xffffff, damaged.length - 6)
    expect(sniffMedia(damaged)).toBeNull()
  })

  test('text kinds need plain text content and a known extension or declared type', () => {
    expect(sniffMedia(text('# hi'), { name: 'n.md' })).toBe('text/markdown')
    expect(sniffMedia(text('a,b\n1,2'), { name: 'n.CSV' })).toBe('text/csv')
    expect(sniffMedia(text('<p>x</p>'), { name: 'n.html' })).toBe('text/html')
    expect(sniffMedia(text('{"a":1}'), { name: 'n.json' })).toBe('application/json')
    expect(sniffMedia(text('{broken'), { name: 'n.json' })).toBe('text/plain')
    expect(sniffMedia(text('hello'), { declared: 'text/csv; charset=utf-8' })).toBe('text/csv')
    expect(sniffMedia(text('hello'), { name: 'n.exe' })).toBeNull()
    expect(sniffMedia(text('hello'))).toBeNull()
    expect(sniffMedia(Buffer.from([0x68, 0x00, 0x69]), { name: 'n.txt' })).toBeNull()
    expect(sniffMedia(Buffer.from([0xff, 0xfe, 0x41]), { name: 'n.txt' })).toBeNull()
    expect(isPlainText(text('tab\tline\r\nπ'))).toBe(true)
  })

  test('declared types only reject contradictions of binary types', () => {
    expect(declaredMatches('application/pdf', 'application/pdf')).toBe(true)
    expect(declaredMatches('image/png', 'application/pdf')).toBe(false)
    expect(declaredMatches('text/plain', 'application/pdf')).toBe(false)
    expect(declaredMatches('text/plain', 'text/csv')).toBe(true)
    expect(declaredMatches('application/pdf', 'text/csv')).toBe(false)
    expect(declaredMatches('application/octet-stream', DOCX_TYPE)).toBe(true)
    expect(declaredMatches('application/vnd.ms-excel', 'text/csv')).toBe(true)
  })
})
