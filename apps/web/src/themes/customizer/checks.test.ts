import { describe, expect, it } from 'vitest'
import { colourFindings, pairProblems, tokenWarnings, worstRatio } from './checks.ts'
import { emptyManifest, setColor } from './draft.ts'

// Score's own values for the tokens these tests touch (tokens.css).
const score: Record<string, Record<string, string>> = {
  light: {
    ground: '#eceef2',
    card: '#ffffff',
    ink: '#12131a',
    'ink-muted': '#5e626c',
    muted: '#626670',
    'on-dark': '#fff',
    'panel-ink': '#12131a',
    'panel-card': '#ffffff',
  },
  dark: {
    ground: '#0f1116',
    card: '#181a21',
    ink: '#eceef2',
    'ink-muted': '#a9adb8',
    muted: '#9fa3ae',
    'on-dark': '#fff',
    'panel-ink': '#242733',
    'panel-card': '#ffffff',
  },
}
const defaults = (token: string, mode: 'light' | 'dark') => score[mode]![token] ?? ''
const blank = () => ({ manifest: emptyManifest('x', 'X'), css: '', uploads: {} })

describe('colour checks', () => {
  it('finds nothing in a theme that changes no colour', () => {
    expect(colourFindings(blank().manifest, defaults)).toEqual([])
  })

  it('names a faint pair, the mode and the colours to change', () => {
    const d = setColor(blank(), 'light', 'ink', '#c9ccd2')
    const findings = colourFindings(d.manifest, defaults)
    const main = findings.find((f) => f.id === 'pair:light:ink:card')!
    expect(main.where).toBe('Light')
    expect(main.text).toMatch(
      /Main text on cards is hard to read \(1\.\d:1; 4\.5:1 is the least that works\)/,
    )
    expect(main.text).toContain('“Text” or “Panels”')
    expect(findings.some((f) => f.id === 'protected:light')).toBe(true)
    expect(findings.some((f) => f.where === 'Dark')).toBe(false)
  })

  it('measures the main buttons as Score draws them: card-coloured text on ink', () => {
    // A light dark-mode ink is normal (Score's own is #eceef2); white text never sits on it.
    const d = setColor(blank(), 'dark', 'ink', '#e8eaee')
    const findings = colourFindings(d.manifest, defaults)
    expect(findings.filter((f) => f.text.startsWith('Text on the main buttons'))).toEqual([])
    const faint = setColor(blank(), 'dark', 'ink', '#2a2d36')
    expect(
      colourFindings(faint.manifest, defaults).some((f) => f.id === 'pair:dark:card:ink'),
    ).toBe(true)
  })

  it('puts a short warning on each colour of a faint pair', () => {
    const d = setColor(blank(), 'dark', 'ground', '#e0e0e0')
    const warnings = tokenWarnings(pairProblems(d.manifest, defaults), 'dark')
    expect(warnings.ink).toMatch(/Hard to read on “Ground”/)
    expect(warnings.ground).toMatch(/“Text” is hard to read on this/)
    expect(tokenWarnings(pairProblems(d.manifest, defaults), 'light')).toEqual({})
  })

  it('holds lines to 3:1, not 4.5:1', () => {
    const d = setColor(blank(), 'light', 'line-strong', '#c5c8cf')
    const findings = colourFindings(d.manifest, (t, m) =>
      t === 'line-strong' ? '' : defaults(t, m),
    )
    expect(
      findings.some((f) => f.text.includes('Strong lines on cards') && f.text.includes('3:1')),
    ).toBe(true)
  })
})

describe('worstRatio', () => {
  const black = [0, 0, 0, 1] as const
  const white = [1, 1, 1, 1] as const
  it('counts a bright band behind the text, not one stray pixel', () => {
    const bases = [...Array(9).fill(white), black]
    expect(worstRatio(black, [], bases)).toBeGreaterThan(10)
    const half = [...Array(5).fill(white), ...Array(5).fill(black)]
    expect(worstRatio(black, [], half)).toBeLessThan(2)
  })
  it('lays translucent cards over the picture first', () => {
    const glass = [1, 1, 1, 0.9] as const
    expect(worstRatio(black, [glass], [black])).toBeGreaterThan(8)
  })
})

describe('classic-view colour checks (still emitted by the engine)', () => {
  it('warns about a faint classic pair and says so', () => {
    const d = setColor(blank(), 'light', 'chat-text', '#f0f0f0')
    const set = setColor(d, 'light', 'chat-soft', '#ffffff')
    const findings = colourFindings(set.manifest, (t, m) => score[m]![t] ?? '#000000')
    const hit = findings.find((f) => f.id === 'pair:light:chat-text:chat-soft')
    expect(hit?.text).toContain('(classic view)')
  })
})
