import { describe, expect, test } from 'vitest'
import { checkThemeCss } from '../../src/themes/css-check.ts'

// Third gate, finding 2: the server refuses what the browser's sanitiser drops, here the pseudo-elements a theme may not
// style (the highlight pseudos inherit into protected surfaces from a rule on the root).
describe('pseudo-elements in an imported theme’s CSS', () => {
  test.each([
    ':root::selection { color: transparent; background-color: transparent }',
    ':root::selec\\74 ion { color: transparent }',
    '@media (min-width: 1px) { :is(:root, html)::target-text { color: transparent } }',
    'body::first-line { color: transparent }',
    'textarea::spelling-error { color: transparent }',
    ':root::highlight(find) { color: transparent }',
  ])('%s is refused, naming the pseudo-element', (css) => {
    const { reasons } = checkThemeCss(css)
    expect(reasons.join(' | ')).toMatch(/can’t be styled by a theme/)
  })

  test('::before, ::after, ::placeholder, ::marker and an escaped colon in a class name are fine', () => {
    expect(
      checkThemeCss(
        'a::before { color: red } a::after { color: red } input::placeholder { color: red } li::marker { color: red } .x\\:y { color: red }',
      ).reasons,
    ).toEqual([])
  })
})
