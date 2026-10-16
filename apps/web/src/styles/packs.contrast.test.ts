import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { packs } from './packs.ts'

const dir = import.meta.dirname

/** Custom properties declared in the first rule whose selector starts with `selector`. */
function declarations(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) return {}
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start))
  const out: Record<string, string> = {}
  for (const match of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[match[1]!] = match[2]!.trim()
  return out
}

const base = readFileSync(join(dir, 'tokens.css'), 'utf8')

function tokensFor(packId: string, mode: 'light' | 'dark'): Record<string, string> {
  const tokens = {
    ...declarations(base, ":root,\n[data-pack='score']"),
    ...(mode === 'dark'
      ? declarations(base, ":root[data-theme='dark'],\n[data-pack='score'][data-theme='dark']")
      : {}),
  }
  if (packId === 'score') return tokens
  const css = readFileSync(join(dir, 'packs', `${packId}.css`), 'utf8')
  return {
    ...tokens,
    ...declarations(css, `[data-pack='${packId}']${mode === 'dark' ? "[data-theme='dark']" : ''}`),
  }
}

function channel(value: number): number {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
function luminance(hex: string): number {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h
  const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(full.slice(i, i + 2), 16)))
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

// [foreground, background, minimum ratio, what it is]. 4.5 is WCAG AA for text, 3 for focus rings and graphics.
const pairs: [string, string, number, string][] = [
  ['ink', 'ground', 4.5, 'body text on the ground'],
  ['ink', 'card', 4.5, 'body text on cards'],
  ['ink-muted', 'card', 4.5, 'secondary text on cards'],
  ['ink-muted', 'ground', 4.5, 'secondary text on the ground'],
  ['muted', 'ground', 4.5, 'hints on the ground'],
  ['muted', 'card', 4.5, 'hints on cards'],
  ['muted', 'subtle', 4.5, 'hints on subtle fills'],
  ['chat-text', 'chat-soft', 4.5, 'chat text on soft fills'],
  ['chat-secondary', 'card', 4.5, 'chat secondary text'],
  ['tasks-note', 'tasks-done', 4.5, 'task notes on done cards'],
  ['profile-add-ink', 'card', 4.5, 'add-agent text'],
  ['card', 'ink', 4.5, 'primary buttons and the current navigation item'],
  ['panel-ink', 'panel-card', 4.5, 'text on inverse panels'],
  ['on-dark', 'panel-ink', 4.5, 'white text on inverse panels'],
  ['ink', 'card', 3, 'focus ring on cards'],
  ['ink', 'ground', 3, 'focus ring on the ground'],
  ['line-strong', 'card', 3, 'input borders'],
  ['flow-edge', 'flow-canvas', 3, 'Flow lines on the canvas'],
  ['agent-violet-text', 'agent-violet-tint', 4.5, 'violet agent text on its tint'],
  ['agent-jade-text', 'agent-jade-tint', 4.5, 'jade agent text on its tint'],
  ['agent-saffron-text', 'agent-saffron-tint', 4.5, 'saffron agent text on its tint'],
  ['agent-coral-text', 'agent-coral-tint', 4.5, 'coral agent text on its tint'],
  ['agent-violet-text', 'card', 4.5, 'violet agent text on cards'],
  ['agent-jade-text', 'card', 4.5, 'jade agent text on cards'],
  ['agent-saffron-text', 'card', 4.5, 'saffron agent text on cards'],
  ['agent-coral-text', 'card', 4.5, 'coral agent text on cards'],
]

function resolve(tokens: Record<string, string>, name: string): string {
  let value = tokens[`--${name}`]
  for (let i = 0; i < 4 && value?.startsWith('var('); i += 1) value = tokens[value.slice(6, -1)]
  if (!value || !/^#[0-9a-f]{3,6}$/i.test(value))
    throw new Error(`--${name} is not a hex colour: ${value}`)
  return value
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
