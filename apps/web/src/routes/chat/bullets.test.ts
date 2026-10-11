import { describe, expect, test } from 'vitest'
import { normalizeBullets } from './bullets.ts'

describe('normalizeBullets', () => {
  test('turns bullet-character lines into a Markdown list, nesting by indentation', () => {
    const reply =
      '• Lock the regress tiles.\n• Clarify Rift effects:\n  • Options discussed: 3 of each.\n  • Target roughly 5%.\n• Resolve the Rift counter.'
    expect(normalizeBullets(reply)).toBe(
      '- Lock the regress tiles.\n- Clarify Rift effects:\n  - Options discussed: 3 of each.\n  - Target roughly 5%.\n- Resolve the Rift counter.',
    )
  })

  test('leaves fenced code and bullets inside a sentence alone', () => {
    const text = 'a • b\n```\n• kept\n```\n~~~~\n• kept too\n```\n• still code\n~~~~\n• item'
    expect(normalizeBullets(text)).toBe(
      'a • b\n```\n• kept\n```\n~~~~\n• kept too\n```\n• still code\n~~~~\n- item',
    )
  })

  test('returns text without bullet characters unchanged', () => {
    const text = '- already a list\n* another'
    expect(normalizeBullets(text)).toBe(text)
  })
})
