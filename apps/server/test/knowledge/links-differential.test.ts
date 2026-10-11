import { describe, expect, test } from 'vitest'
import { codeRanges } from '../../src/knowledge/links.ts'
import { oracleCodeRanges } from './markdown-oracle.ts'

/** Offsets of every `[[` and whether each sits inside the given ranges. */
function verdicts(text: string, ranges: Array<[number, number]>): boolean[] {
  const out: boolean[] = []
  for (const match of text.matchAll(/\[\[/g))
    out.push(ranges.some(([s, e]) => s <= match.index && match.index < e))
  return out
}

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Random small documents built from the structures that decide what is code. */
export function generate(random: () => number): string {
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!
  const inline = (): string =>
    pick([
      'text [[link]] more',
      'plain',
      'a `code [[link]]` b',
      '``double [[link]] ` tick`` c',
      '```triple [[link]]``` d',
      'x `one` [[link]] `two`',
      '[[link]]',
      '\\`escaped [[link]]',
      'open `tick [[link]]',
    ])
  const leaf = (depth: number): string[] => {
    const kind = random()
    if (kind < 0.3) return [inline()]
    if (kind < 0.4) return [inline(), inline()]
    if (kind < 0.45) return ['# ' + inline()]
    if (kind < 0.5)
      return pick([
        ['---'],
        ['* * *'],
        [inline(), '---'],
        [inline(), '==='],
        ['-'],
        ['1.'],
        ['\t' + inline()],
      ])
    if (kind < 0.65) {
      const fence = pick(['```', '~~~', '````'])
      const body = [pick(['[[link]]', 'code [[link]]', '']), pick(['[[link]]', 'x'])]
      return [fence + pick(['', 'md', ' ts']), ...body, ...(random() < 0.7 ? [fence] : [])]
    }
    if (kind < 0.8)
      return [
        '    ' + pick(['[[link]]', 'code [[link]]', 'x']),
        ...(random() < 0.3 ? ['', '    [[link]]'] : []),
      ]
    if (kind < 0.9 && depth < 3) return list(depth + 1)
    if (depth < 3) return quote(depth + 1)
    return [inline()]
  }
  const blocks = (depth: number): string[] => {
    const out: string[] = []
    const count = 1 + Math.floor(random() * 3)
    for (let i = 0; i < count; i++) {
      if (i > 0 && random() < 0.7) out.push('')
      out.push(...leaf(depth))
    }
    return out
  }
  const list = (depth: number): string[] => {
    const ordered = random() < 0.4
    const items = 1 + Math.floor(random() * 2)
    const out: string[] = []
    for (let n = 0; n < items; n++) {
      const marker = ordered ? pick([`${n + 1}.`, `${n + 1})`]) : pick(['-', '*', '+'])
      const gap = pick([1, 1, 1, 2, 3])
      const pad = ' '.repeat(marker.length + gap)
      const body = blocks(depth)
      body.forEach((line, i) => {
        if (i === 0) out.push(`${marker}${' '.repeat(gap)}${line}`)
        else
          out.push(
            line === '' ? '' : random() < 0.85 ? pad + line : random() < 0.5 ? line : ' ' + line,
          )
      })
      if (n < items - 1 && random() < 0.4) out.push('')
    }
    return out
  }
  const quote = (depth: number): string[] =>
    blocks(depth).map((line) =>
      line === '' ? '>' : random() < 0.85 ? `>${pick([' ', ' ', '', '  '])}${line}` : line,
    )
  const top = blocks(0)
  return top.join('\n') + (random() < 0.5 ? '\n' : '')
}

/**
 * micromark does not start a list item whose number is not 1, or which is empty, right after indented code (the
 * CommonMark reference implementation does), and a tab inside container indentation is not split. Such documents
 * are compared and counted but not asserted.
 */
const MICROMARK_QUIRK = {
  /** A tab that straddles a container's indentation is consumed whole by the scanner (not split). */
  container: /(^|\n) *(?:>|[-*+]|\d+[.)])/,
  indentedCode: /(^|\n)[ >]*(?: {4}|\t)\S/,
  oddItem:
    /(^|\n)[ >]*(?:[-*+]|\d+[.)])?[ \t]*(?:(?:[2-9]|\d{2,})[.)]|[-*+]|\d[.)])[ \t]*(\n|$)|(^|\n)[ >]*(?:[2-9]|\d{2,})[.)]/,
}

describe('codeRanges agrees with a real CommonMark parser', () => {
  test('on seeded random documents, every [[ is inside code exactly when the parser says so', () => {
    const random = mulberry32(20261011)
    const total = Number(process.env.DIFF_DOCS ?? 3000)
    const strict: Array<{ text: string; mine: boolean[]; oracle: boolean[] }> = []
    let quirky = 0
    let quirkyDisagree = 0
    for (let i = 0; i < total; i++) {
      const text = generate(random)
      const mine = verdicts(text, codeRanges(text))
      const oracle = verdicts(text, oracleCodeRanges(text))
      const differs = mine.join() !== oracle.join()
      const isQuirk =
        (MICROMARK_QUIRK.indentedCode.test(text) && MICROMARK_QUIRK.oddItem.test(text)) ||
        (text.includes('\t') && MICROMARK_QUIRK.container.test(text))
      if (isQuirk) {
        quirky++
        if (differs) quirkyDisagree++
      } else if (differs) strict.push({ text, mine, oracle })
    }
    console.log(
      `${total} documents: ${strict.length} disagreements; ${quirkyDisagree}/${quirky} in micromark-quirk documents`,
    )
    if (strict.length > 0)
      console.log(
        strict
          .sort((a, b) => a.text.length - b.text.length)
          .slice(0, 8)
          .map((d) => `${JSON.stringify(d.text)} mine=${d.mine} oracle=${d.oracle}`)
          .join('\n'),
      )
    expect(strict).toEqual([])
  })
})
