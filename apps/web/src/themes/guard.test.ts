import { describe, expect, test } from 'vitest'
import { contrastVerdict } from './guard.ts'

describe('contrastVerdict', () => {
  test('AA is the bar: 4.5:1 for text, 3:1 for large text and icons', () => {
    expect(contrastVerdict(4.5, 12, false)).toBeNull()
    expect(contrastVerdict(3.9, 12, false)).toBe('has unreadable text')
    expect(contrastVerdict(3.0, 12, true)).toBeNull()
    expect(contrastVerdict(2.9, 12, true)).toBe('has unreadable text')
  })

  test('the old 3:1 floor no longer passes ordinary text', () => {
    expect(contrastVerdict(3.1, 7, false)).toBe('has unreadable text')
  })

  test('below AA is only the theme’s doing when Score’s own look reads better', () => {
    expect(contrastVerdict(3.0, 3.0, false)).toBeNull()
    expect(contrastVerdict(3.0, 3.04, false)).toBeNull()
    expect(contrastVerdict(2.5, 3.0, false)).toBe('has unreadable text')
  })

  test('a colour that can’t be measured fails closed once Score’s own could be', () => {
    expect(contrastVerdict(null, 7, false)).toBe('has text whose colours can’t be checked')
    expect(contrastVerdict(null, null, false)).toBeNull()
    expect(contrastVerdict(3.9, null, false)).toBe('has unreadable text')
  })
})
