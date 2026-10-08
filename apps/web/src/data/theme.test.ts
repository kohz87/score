import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { applyTheme, readTheme, saveTheme } from './theme.ts'

afterEach(() => {
  window.localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  vi.restoreAllMocks()
})

test('reads light, dark or falls back to system', () => {
  expect(readTheme()).toBe('system')
  window.localStorage.setItem('score.theme', 'dark')
  expect(readTheme()).toBe('dark')
  window.localStorage.setItem('score.theme', 'purple')
  expect(readTheme()).toBe('system')
})
test('an unreadable store reads as system', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  expect(readTheme()).toBe('system')
})
test('applyTheme and saveTheme drive data-theme', () => {
  applyTheme('dark')
  expect(document.documentElement.dataset.theme).toBe('dark')
  saveTheme('system')
  expect(document.documentElement.dataset.theme).toBeUndefined()
})

// WCAG contrast, computed from tokens.css so a new dark value can't quietly break readability.
const css = readFileSync(join(process.cwd(), 'src/styles/tokens.css'), 'utf8')
function block(selector: string): Record<string, string> {
  const start = css.indexOf(selector)
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start))
  return Object.fromEntries(
    [...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!]),
  )
}
const light = block(':root {')
const dark = { ...light, ...block(":root[data-theme='dark'] {") }
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}
const textTokens = [
  'ink',
  'ink-muted',
  'muted',
  'chat-text',
  'chat-secondary',
  'tasks-note',
  'profile-add-ink',
  'link-hover',
]
const surfaces = ['ground', 'card', 'subtle', 'subtle-2', 'tasks-ground', 'tasks-done', 'chat-soft']
const tints: [string, string][] = [
  ['agent-violet-text', 'agent-violet-tint'],
  ['agent-jade-text', 'agent-jade-tint'],
  ['agent-saffron-text', 'agent-saffron-tint'],
  ['agent-coral-text', 'agent-coral-tint'],
]

test.each([
  ['light', light],
  ['dark', dark],
])('%s: text tokens reach 4.5:1 on every surface', (_name, tokens) => {
  for (const text of textTokens)
    for (const surface of surfaces)
      expect(
        contrast(tokens[text]!, tokens[surface]!),
        `${text} on ${surface}`,
      ).toBeGreaterThanOrEqual(4.5)
  for (const [text, tint] of tints) {
    expect(contrast(tokens[text]!, tokens[tint]!), `${text} on ${tint}`).toBeGreaterThanOrEqual(4.5)
    for (const surface of ['card', 'ground'])
      expect(
        contrast(tokens[text]!, tokens[surface]!),
        `${text} on ${surface}`,
      ).toBeGreaterThanOrEqual(4.5)
  }
  // Primary buttons: card-coloured text on an ink fill.
  expect(contrast(tokens.card!, tokens.ink!)).toBeGreaterThanOrEqual(4.5)
})

test('the System block repeats every dark value', () => {
  const media = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'))
  const system = Object.fromEntries(
    [...media.slice(0, media.indexOf('\n}\n')).matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map(
      (m) => [m[1]!, m[2]!],
    ),
  )
  expect(system).toEqual(block(":root[data-theme='dark'] {"))
  expect(Object.keys(system).length).toBeGreaterThan(30)
})
