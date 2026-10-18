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

// Third gate, finding 2: highlight pseudo-elements inherit through the tree separately, so a rule on the root's
// ::selection reaches selected text inside a decision. The shared allowlist refuses them (and every pseudo-element not
// on its list); a protected cascade layer asserts the trusted colours as the second wall (protected.css).
describe('third gate finding 2: pseudo-elements', () => {
  test.each([
    ':root::selection',
    'body::selection',
    ':is(:root, html):has(body)::selection',
    '*::selection',
    '.chat-message::selection',
    ':root::target-text',
    'textarea::spelling-error',
    'textarea::grammar-error',
    ':root::highlight(find)',
    'body::first-line',
    'body:first-letter',
    'div::-webkit-scrollbar',
    '::file-selector-button',
  ])('%s is dropped, with its own reason', (selector) => {
    const css = `${selector} { color: transparent; background-color: transparent; }`
    const result = sanitiseCss(css, { confine: true })
    expect(result.css).toBe('')
    expect(result.report.dropped.map((item) => item.reason)).toEqual(['selector_not_allowed'])
  })

  test('also inside @media and @layer, and in a list with an ordinary selector', () => {
    for (const css of [
      '@media (min-width: 1px) { :root::selection { color: transparent } }',
      '@layer a { @supports (color: red) { :root::selection { color: transparent } } }',
      'p, :root::selection { color: transparent }',
    ]) {
      const result = sanitiseCss(css, { confine: true })
      expect(result.css, css).toBe('')
      expect(
        result.report.dropped.map((item) => item.reason),
        css,
      ).toEqual(['selector_not_allowed'])
    }
  })

  test('::before, ::after, ::placeholder and ::marker still pass, kept out of protected subtrees', () => {
    const result = sanitiseCss(
      'a::before { color: red } input::placeholder { color: red } li::marker { color: red }',
      { confine: true },
    )
    expect(result.report.dropped).toEqual([])
    expect(result.css).toContain(`a${OUTSIDE_PROTECTED}::before`)
    expect(result.css).toContain(`input${OUTSIDE_PROTECTED}::placeholder`)
    expect(result.css).toContain(`li${OUTSIDE_PROTECTED}::marker`)
  })

  test('the Customizer explains the removal', () => {
    const [line] = describeDropped(sanitiseCss(':root::selection { color: red }').report)
    expect(line!.why).toMatch(/pseudo-element/)
  })
})
