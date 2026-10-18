import { describe, expect, test } from 'vitest'
import { describeDropped } from './customizer/report-text.ts'
import { OUTSIDE_PROTECTED, WITHOUT_PROTECTED_INSIDE, sanitiseCss } from './sanitise.ts'

// Decision 102 / re-gate finding 3: theme CSS is an allowlist of visual properties. Anything that positions, sizes,
// clips, transforms or changes text spacing never reaches the page, whatever element it is written on.
const dropped = (css: string) => sanitiseCss(css).report.dropped.map((item) => item.reason)

describe('re-gate finding 3: ancestor styling that changes protected text', () => {
  test('inherited word spacing on the root is dropped', () => {
    const result = sanitiseCss(':root { word-spacing: -100px; }')
    expect(result.css).not.toContain('word-spacing')
    expect(dropped(':root { word-spacing: -100px; }')).toEqual(['property_not_allowed'])
  })

  test('an ancestor transform that flips a decision is dropped', () => {
    const result = sanitiseCss('.chat-message { transform: scaleY(-1); }')
    expect(result.css).not.toContain('transform')
    expect(dropped('.chat-message { transform: scaleY(-1); }')).toEqual(['property_not_allowed'])
  })
})

describe('what stays', () => {
  test('visual declarations pass through, and opacity only where nothing protected is inside', () => {
    const css = '.card { color: red; opacity: 0.5; border-radius: 12px }'
    const stored = sanitiseCss(css)
    expect(stored.report.dropped).toEqual([])
    expect(stored.css).toContain('opacity: 0.5')
    const applied = sanitiseCss(css, { confine: true }).css
    expect(applied).toContain(`.card${OUTSIDE_PROTECTED} { color: red; border-radius: 12px; }`)
    expect(applied).toContain(
      `.card${OUTSIDE_PROTECTED}${WITHOUT_PROTECTED_INSIDE} { opacity: 0.5; }`,
    )
  })

  test('the Customizer says which declaration was dropped and why', () => {
    const lines = describeDropped(
      sanitiseCss(':root { word-spacing: -100px; color: var(--x); } .a { transform: none }').report,
    )
    expect(lines.map((line) => line.rule)).toEqual([
      ':root { word-spacing }',
      ':root { color: var(--x) }',
      '.a { transform }',
    ])
    expect(lines[0]!.why).toContain('`word-spacing`')
    expect(lines[1]!.why).toMatch(/value isn’t/)
  })
})
