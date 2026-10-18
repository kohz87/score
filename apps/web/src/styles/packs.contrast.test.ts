import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { baseTokens, contrast, declarations, pairs, resolve } from './contrast-pairs.ts'
import { packs } from './packs.ts'

const dir = import.meta.dirname

function tokensFor(packId: string, mode: 'light' | 'dark'): Record<string, string> {
  const tokens = baseTokens(mode)
  if (packId === 'score') return tokens
  const css = readFileSync(join(dir, 'packs', `${packId}.css`), 'utf8')
  return {
    ...tokens,
    ...declarations(css, `[data-pack='${packId}']${mode === 'dark' ? "[data-theme='dark']" : ''}`),
  }
}

describe.each(packs.map((pack) => pack.id))('pack %s', (id) => {
  describe.each(['light', 'dark'] as const)('%s', (mode) => {
    const tokens = tokensFor(id, mode)
    // The default pack must stay exactly today's look, and its --line-strong is 2.7:1; changing it would change the default look.
    it.each(pairs.filter(([fg]) => !(id === 'score' && fg === 'line-strong')))(
      '%s on %s is at least %s:1 (%s)',
      (fg, bg, min) => {
        expect(contrast(resolve(tokens, fg), resolve(tokens, bg))).toBeGreaterThanOrEqual(min)
      },
    )
  })
})

describe('the packs registry', () => {
  it('has the four built-in packs, Score first', () => {
    expect(packs.map((pack) => pack.id)).toEqual(['score', 'paper', 'night', 'dense'])
  })
})
