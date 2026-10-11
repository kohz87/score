import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  buildNoteIndex,
  codeRanges,
  parseWikilinks,
  rewriteLinks,
} from '../../src/knowledge/links.ts'
import { gitOut, makeVault, type Harness } from './helpers.ts'

vi.setConfig({ testTimeout: 60_000 })

let h: Harness
afterEach(async () => {
  vi.restoreAllMocks()
  await h?.cleanup()
  h = undefined as unknown as Harness
})

describe('S2-015 a stat failure is not evidence of deletion', () => {
  test('EACCES on one known note or document keeps its row and emits no deletion', async () => {
    h = await makeVault({
      files: { 'keep.md': 'kept [[other]]', 'other.md': 'x', 'data.csv': 'a,b\n1,2' },
    })
    await h.vault.scanNow()
    expect(h.vault.search('kept', 5).map((r) => r.path)).toContain('keep.md')
    h.events.length = 0
    const real = fs.promises.lstat
    const failing = vi.spyOn(fs.promises, 'lstat').mockImplementation(((
      p: unknown,
      ...rest: never[]
    ) => {
      if (/[/\\](keep\.md|data\.csv)$/.test(String(p)))
        return Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
      return (real as (...a: unknown[]) => Promise<unknown>)(p, ...rest)
    }) as never)
    await h.vault.scanNow()
    expect(h.events.filter((e) => e.kind === 'deleted')).toEqual([])
    expect(h.vault.search('kept', 5).map((r) => r.path)).toContain('keep.md')
    expect((await h.vault.tree()).documents.map((d) => d.path)).toContain('data.csv')
    failing.mockRestore()
    await h.vault.scanNow()
    expect(h.events.filter((e) => e.kind === 'deleted')).toEqual([])
    expect(h.vault.search('kept', 5).map((r) => r.path)).toContain('keep.md')
  })

  test('a file that is genuinely gone is still removed', async () => {
    h = await makeVault({ files: { 'gone.md': 'bye' } })
    fs.rmSync(path.join(h.vaultDir, 'gone.md'))
    await h.vault.scanNow()
    expect(h.events.some((e) => e.path === 'gone.md' && e.kind === 'deleted')).toBe(true)
  })
})

describe('S2-016 invalidating a document is announced once', () => {
  test('a document replaced by invalid bytes is removed with one deletion event, and not again', async () => {
    h = await makeVault()
    fs.writeFileSync(path.join(h.vaultDir, 'a.pdf'), '%PDF-1.4 not really')
    // Index a valid document first: a CSV standing in for "valid", then swap its extension's content.
    fs.writeFileSync(path.join(h.vaultDir, 'b.csv'), 'a,b\n1,2')
    await h.vault.scanNow()
    expect((await h.vault.tree()).documents.map((d) => d.path)).toContain('b.csv')
    h.events.length = 0
    fs.writeFileSync(path.join(h.vaultDir, 'b.csv'), Buffer.from([0, 1, 2, 0, 255, 254, 0]))
    await h.vault.scanNow()
    expect((await h.vault.tree()).documents.map((d) => d.path)).not.toContain('b.csv')
    expect(h.events.filter((e) => e.path === 'b.csv')).toEqual([
      expect.objectContaining({ kind: 'deleted', by: 'outside' }),
    ])
    h.events.length = 0
    await h.vault.scanNow()
    expect(h.events.filter((e) => e.path === 'b.csv')).toEqual([])
  })
})

describe('S2-017 a rebuild keeps tracked documents versioned', () => {
  test('a document that grew past the versioning size stays versioned across a rebuild', async () => {
    h = await makeVault()
    await h.vault.docs.upload('big.csv', Buffer.from('a,b\n1,2\n'), 'ask')
    expect((await h.vault.docs.get('big.csv')).versioned).toBe(true)
    const rows = 'abcdefghijklmnopqrstuvwxyz,0123456789,0123456789\n'
    fs.writeFileSync(
      path.join(h.vaultDir, 'big.csv'),
      'a,b,c\n' + rows.repeat(Math.ceil((11 * 1024 * 1024) / rows.length)),
    )
    await h.vault.scanNow()
    expect((await h.vault.docs.get('big.csv')).versioned).toBe(true)
    gitOut(h.vaultDir, 'add', 'big.csv')
    gitOut(h.vaultDir, 'commit', '-q', '-m', 'big')
    await h.vault.rebuild()
    expect((await h.vault.docs.get('big.csv')).versioned).toBe(true)
    expect(h.vault.docs.unversionedPaths()).not.toContain('big.csv')
  })
})

describe('S2-020 code inside containers is literal', () => {
  const cases: Array<[string, string]> = [
    [
      'fence in a list item after a blank line',
      '- item\n\n  ```\n  [[Target]]\n  ```\n\n- next [[Target]]',
    ],
    [
      'fence in a nested list',
      '1. one\n   - two\n\n     ```md\n     [[Target]]\n\n     [[Target]]\n     ```\n',
    ],
    ['indented code in a blockquote', '> quoted\n>\n>     [[Target]]\n'],
    ['fence in a blockquote', '> ```\n> [[Target]]\n> ```\n'],
    ['indented code in a list item', '- item\n\n      [[Target]]\n'],
  ]
  const index = buildNoteIndex(['Target.md', 'Renamed.md'])
  test.each(cases)('%s', (_name, text) => {
    const ranges = codeRanges(text)
    const at = text.indexOf('[[Target]]')
    expect(ranges.some(([s, e]) => s <= at && at < e)).toBe(true)
    const literal = rewriteLinks(
      text.split('- next')[0]!,
      'n.md',
      'Target.md',
      'Renamed.md',
      index,
      index,
    )
    expect(literal.text).toBe(text.split('- next')[0])
    expect(literal.count).toBe(0)
  })

  test('a link outside the container is still a link, code inside is untouched', () => {
    const text = '- item\n\n  ```\n  [[Target]]\n  ```\n\nafter [[Target]]\n'
    expect(parseWikilinks(text).map((l) => l.start)).toEqual([text.lastIndexOf('[[')])
    const out = rewriteLinks(
      text,
      'n.md',
      'Target.md',
      'Renamed.md',
      buildNoteIndex(['Target.md']),
      buildNoteIndex(['Renamed.md']),
    )
    expect(out.text).toBe(text.replace('after [[Target]]', 'after [[Renamed]]'))
  })

  test('adversarial inline characters stay fast and still find the code', () => {
    const text = '[[a]] **b** ![c](d) <e> &f; `x`\n'.repeat(4000)
    const started = Date.now()
    expect(codeRanges(text)).toHaveLength(4000)
    expect(Date.now() - started).toBeLessThan(5000)
  })
})

describe('S2-021 linear scaling', () => {
  const best = (work: () => void): number => {
    let min = Infinity
    for (let i = 0; i < 3; i++) {
      const t = performance.now()
      work()
      min = Math.min(min, performance.now() - t)
    }
    return Math.max(min, 1)
  }

  test('inline code spans: 4x the spans costs well under 4x squared', () => {
    const small = '`a` '.repeat(4000)
    const large = '`a` '.repeat(16000)
    expect(codeRanges(large)).toHaveLength(16000)
    const ratio = best(() => codeRanges(large)) / best(() => codeRanges(small))
    expect(ratio).toBeLessThan(10) // linear ~4, quadratic ~16
  })

  test('many notes sharing a basename index in linear time', () => {
    const make = (n: number) => Array.from({ length: n }, (_, i) => `d${i}/README.md`)
    const small = make(4000)
    const large = make(16000)
    const ratio = best(() => buildNoteIndex(large)) / best(() => buildNoteIndex(small))
    expect(ratio).toBeLessThan(10)
    expect(buildNoteIndex(large).bySuffix.get('readme.md')).toHaveLength(16000)
  })
})
