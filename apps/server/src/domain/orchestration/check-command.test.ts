import { describe, expect, test } from 'vitest'
import { joinCommand, splitCommand } from './check-command.ts'

describe('splitCommand', () => {
  test('words, quotes and backslashes become arguments', () => {
    expect(splitCommand('pnpm test')).toEqual({ ok: true, argv: ['pnpm', 'test'] })
    expect(splitCommand(`pytest -k 'not slow'  "a b" c\\ d`)).toEqual({
      ok: true,
      argv: ['pytest', '-k', 'not slow', 'a b', 'c d'],
    })
    expect(splitCommand(`echo ''`)).toEqual({ ok: true, argv: ['echo', ''] })
    expect(splitCommand(`echo "say \\"hi\\""`)).toEqual({ ok: true, argv: ['echo', 'say "hi"'] })
  })

  test('an explicit shell is allowed, written out', () => {
    expect(splitCommand(`bash -lc 'pnpm lint && pnpm test | tee out'`)).toEqual({
      ok: true,
      argv: ['bash', '-lc', 'pnpm lint && pnpm test | tee out'],
    })
  })

  test.each([
    'pnpm lint && pnpm test',
    'pnpm test | tee log',
    'pnpm test; rm -rf x',
    'pnpm test > out',
    'echo $HOME',
    'echo `id`',
    'echo "$HOME"',
    'ls *.ts',
    'cd ~',
    '# comment',
    'a & b',
  ])('refuses shell syntax: %s', (line) => {
    const result = splitCommand(line)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/shell/)
  })

  test('refuses broken or oversized lines', () => {
    expect(splitCommand('   ').ok).toBe(false)
    expect(splitCommand(`echo 'open`).ok).toBe(false)
    expect(splitCommand('echo a\\').ok).toBe(false)
    expect(splitCommand('a\nb').ok).toBe(false)
    expect(splitCommand(Array.from({ length: 65 }, () => 'x').join(' ')).ok).toBe(false)
  })

  test('a word may contain # and ~ inside it', () => {
    expect(splitCommand('git log a#b x~1')).toEqual({
      ok: true,
      argv: ['git', 'log', 'a#b', 'x~1'],
    })
  })
})

test('joinCommand quotes what needs it and round-trips', () => {
  const argv = ['bash', '-lc', "it's a && b", 'plain/path.ts']
  const line = joinCommand(argv)
  expect(line).toBe(`bash -lc 'it'\\''s a && b' plain/path.ts`)
})
