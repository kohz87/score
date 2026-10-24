import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUILTIN_THEME_IDS, ThemeManifestSchema } from '@score/contract'
import { baseTokens, contrast, resolve } from '../styles/contrast-pairs.ts'

// PLAN 11.9d: the bold shell wears a built-in theme through bold-theme.css. Whatever the theme, the text pairs the
// shell draws (bold-theme.css maps each bold token to a theme token) have to stay WCAG AA.
const root = join(import.meta.dirname, '../../../..')
// Whitespace is flattened so Prettier's line breaks inside a selector don't matter.
const css = readFileSync(join(import.meta.dirname, 'bold-theme.css'), 'utf8').replace(/\s+/g, ' ')
const boldTokens = readFileSync(join(import.meta.dirname, 'tokens.css'), 'utf8').replace(
  /\s+/g,
  ' ',
)
const roomCss = readFileSync(join(import.meta.dirname, 'room/bold-room.css'), 'utf8').replace(
  /\s+/g,
  ' ',
)
const protectedCss = readFileSync(
  join(import.meta.dirname, '../styles/protected.css'),
  'utf8',
).replace(/\s+/g, ' ')

/** [text token, background token] in the bold set, as the shell draws them. */
const pairs: [string, string, string][] = [
  ['ink', 'bg', 'body text on the ground'],
  ['ink', 'panel', 'text on panels'],
  ['ink', 'field', 'text in fields'],
  ['ink2', 'panel', 'secondary text on panels'],
  ['ink2', 'field', 'secondary text on fields'],
  ['muted', 'bg', 'muted text on the ground'],
  ['muted', 'panel', 'muted text on panels'],
  ['faint', 'bg', 'hints on the ground'],
  ['faint', 'panel', 'hints on panels'],
  ['hi-ink', 'hi-bg', 'text on the light object'],
  ['hi-sub', 'hi-bg', 'secondary text on the light object'],
]

/** Reads `--name: var(--t-x)` out of the rule for `selector`, then the theme token behind `--t-x`. */
function source(selector: string, name: string): string {
  const start = css.indexOf(`${selector} {`)
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start))
  const value = new RegExp(`--${name}:\\s*([^;]+);`).exec(body)?.[1]
  if (!value) throw new Error(`${name} is not set under ${selector}`)
  return value
}

function declaration(text: string, selector: string, name: string): string {
  // The same selector can be split over several rules (the request card paints, then tints); find the one with `name`.
  const pattern = new RegExp(`--${name}:\\s*([^;]+);`)
  let at = text.indexOf(selector)
  let value: string | undefined
  while (at >= 0 && !value) {
    const open = text.indexOf('{', at)
    value = pattern.exec(text.slice(open + 1, text.indexOf('}', open)))?.[1]
    at = text.indexOf(selector, at + 1)
  }
  if (at < 0 && !value) throw new Error(`${selector} is missing`)
  if (!value) throw new Error(`${name} is not set under ${selector}`)
  return value.trim()
}

const nameTints = ['agent-violet-name', 'agent-jade-name', 'agent-saffron-name', 'agent-coral-name']

/** The name tints a request card uses: its light rule in the light look, its default rule in dark. */
function requestTints(mode: 'light' | 'dark'): Record<string, string> {
  const selector =
    mode === 'light'
      ? "[data-ui='bold'][data-look='light'] .bold-request"
      : "[data-ui='bold'] .bold-request"
  return Object.fromEntries(nameTints.map((name) => [name, declaration(roomCss, selector, name)]))
}

function expectNameTints(background: string, mode: 'light' | 'dark') {
  for (const [name, value] of Object.entries(requestTints(mode)))
    expect(contrast(value, background), `${name} on the request card`).toBeGreaterThanOrEqual(4.5)
}

/** The colour of a bold token for a mode: a `var(--t-x)` or a `color-mix` of two. */
function colour(tokens: Record<string, string>, selector: string, name: string): string {
  const value = source(selector, name)
  const theme = (token: string) => resolve(tokens, token.replace(/^--t-/, ''))
  const single = /^var\((--t-[a-z-]+)\)$/.exec(value)
  if (single) return theme(single[1]!)
  const mix = /^color-mix\(in srgb, var\((--t-[a-z-]+)\) (\d+)%, var\((--t-[a-z-]+)\)\)$/.exec(
    value,
  )
  if (!mix) throw new Error(`Unreadable value for ${name}: ${value}`)
  const a = theme(mix[1]!)
  const b = theme(mix[3]!)
  const weight = Number(mix[2]) / 100
  const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)
  const out = [0, 1, 2].map((i) =>
    Math.round(channel(a, i) * weight + channel(b, i) * (1 - weight))
      .toString(16)
      .padStart(2, '0'),
  )
  return `#${out.join('')}`
}

describe.each(BUILTIN_THEME_IDS.slice(1))('the bold shell in %s', (id) => {
  const manifest = ThemeManifestSchema.parse(
    JSON.parse(readFileSync(join(root, 'apps/server/themes', id, 'theme.json'), 'utf8')),
  )
  for (const mode of ['light', 'dark'] as const) {
    it(`keeps every text pair at 4.5:1 in ${mode}`, () => {
      const tokens = {
        ...baseTokens(mode),
        ...Object.fromEntries(
          Object.entries(manifest.colors?.[mode] ?? {}).map(([k, v]) => [`--${k}`, v]),
        ),
      }
      const dark =
        ":root:is([data-look='custom'], [data-pack]:not([data-pack='score'])) [data-ui='bold']"
      const light = `${dark}[data-look='light']`
      const read = (name: string) => {
        // The light set overrides only the light object; every other token is the base rule's.
        const lightOnly = mode === 'light' && name.startsWith('hi-')
        return colour(tokens, lightOnly ? light : dark, name)
      }
      // Status colours and the agent name tints keep the shell's own value for the mode (tokens.css).
      const own =
        mode === 'dark'
          ? { ok: '#5ee3bf', warn: '#ffc94d', bad: '#ff97ae' }
          : { ok: '#00694f', warn: '#8a5a00', bad: '#b01e43' }
      for (const [name, value] of Object.entries(own))
        for (const background of ['bg', 'panel'])
          expect(
            contrast(value, read(background)),
            `${name} on ${background}`,
          ).toBeGreaterThanOrEqual(4.5)
      for (const [text, background, what] of pairs) {
        expect(
          contrast(read(text), read(background)),
          `${what} (${text} on ${background})`,
        ).toBeGreaterThanOrEqual(4.5)
      }
      expectNameTints(read('hi-bg'), mode)
    })
  }
})

it('Score itself keeps the request cards’ agent names readable in both looks', () => {
  for (const mode of ['light', 'dark'] as const) {
    const selector = mode === 'light' ? "[data-ui='bold'][data-look='light']" : "[data-ui='bold']"
    const background = declaration(boldTokens, selector, 'hi-bg')
    expectNameTints(background, mode)
  }
})

it('the contrast fallback keeps the request cards’ agent names readable in both looks', () => {
  for (const mode of ['light', 'dark'] as const) {
    const selector = `html[data-contrast-fallback][data-contrast-fallback] [data-ui='bold'][data-look='${mode}'] [data-protected]`
    const background = declaration(protectedCss, selector, 'hi-bg')
    expectNameTints(background, mode)
  }
})
