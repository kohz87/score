import { expect, test } from 'vitest'
import { unifiedDiff } from '../../src/domain/line-diff.ts'

test('identical text has an empty diff', () => {
  expect(unifiedDiff('a\nb\n', 'a\nb\n')).toBe('')
  expect(unifiedDiff('', '')).toBe('')
})
test('renders a unified diff with context and hunk headers', () => {
  const before = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
  const after = before.replace('line 6\n', 'six\nsix and a half\n')
  expect(unifiedDiff(before, after)).toBe(
    [
      '--- current',
      '+++ proposed',
      '@@ -3,7 +3,8 @@',
      ' line 3',
      ' line 4',
      ' line 5',
      '-line 6',
      '+six',
      '+six and a half',
      ' line 7',
      ' line 8',
      ' line 9',
      '',
    ].join('\n'),
  )
})
test('separate changes make separate hunks; creation and deletion work', () => {
  const before = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n') + '\n'
  const after = before.replace('l2\n', 'X\n').replace('l27\n', 'Y\n')
  expect(unifiedDiff(before, after).match(/^@@/gm)).toHaveLength(2)
  expect(unifiedDiff('', 'new\n')).toContain('@@ -0,0 +1,1 @@\n+new\n')
  expect(unifiedDiff('old\n', '')).toContain('@@ -1,1 +0,0 @@\n-old\n')
})
test('a missing trailing newline is a visible difference', () => {
  const diff = unifiedDiff('a\nb\n', 'a\nb')
  expect(diff).toContain('-b\n+b\n\\ No newline at end of file')
})
test('large unrelated files fall back to a bounded replacement', () => {
  const a = Array.from({ length: 4000 }, (_, i) => `a${i}`).join('\n')
  const b = Array.from({ length: 4000 }, (_, i) => `b${i}`).join('\n')
  const diff = unifiedDiff(a, b)
  expect(diff.match(/^-a/gm)).toHaveLength(4000)
  expect(diff.match(/^\+b/gm)).toHaveLength(4000)
})
test('applying the diff ops reproduces the new text (random edits)', () => {
  let seed = 7
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  for (let round = 0; round < 50; round++) {
    const a = Array.from({ length: 20 }, () => `w${Math.floor(rand() * 6)}`)
    const b = a.filter(() => rand() > 0.3)
    b.splice(Math.floor(rand() * b.length), 0, `n${round}`)
    const diff = unifiedDiff(a.join('\n') + '\n', b.join('\n') + '\n', 100)
    const rebuilt = diff
      .split('\n')
      .filter((line) => /^[ +]/.test(line) && !line.startsWith('+++'))
      .map((line) => line.slice(1))
    expect(rebuilt).toEqual(b)
  }
})
