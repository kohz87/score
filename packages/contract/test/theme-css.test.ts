import { describe, expect, test } from 'vitest'
import {
  THEME_CSS_CORPUS,
  checkThemeDeclaration,
  isAllowedThemeProperty,
  scanThemeCss,
} from '../src/index.ts'

const ok = (name: string, value: string) =>
  expect(checkThemeDeclaration(name, value).ok, `${name}: ${value}`).toBe(true)
const bad = (name: string, value: string) =>
  expect(checkThemeDeclaration(name, value).ok, `${name}: ${value}`).toBe(false)

describe('checkThemeDeclaration', () => {
  test('visual properties pass', () => {
    ok('color', '#fff')
    ok('COLOR', 'Red')
    ok('background-color', 'color-mix(in srgb, var(--card) 70%, transparent)')
    ok('background-image', 'url("asset:img/a.png")')
    ok('background-image', 'linear-gradient(to right, #fff, #000), none')
    ok('border', '1px solid var(--hairline)')
    ok('border-radius', '12px 4px / 8px')
    ok('box-shadow', '0 2px 8px rgb(0 0 0 / 12%), inset 0 1px 0 #fff')
    ok('font-family', '"Inter", system-ui, sans-serif')
    ok('font-weight', '650')
    ok('opacity', '0.5')
    ok('--link-hover', '#112233')
    ok('--radius-card', '20px')
    ok('color', 'inherit')
  })

  test('layout, motion and spacing properties are refused by name', () => {
    for (const name of [
      'position',
      'inset',
      'top',
      'left',
      'right',
      'bottom',
      'transform',
      'translate',
      'rotate',
      'scale',
      'overflow',
      'overflow-x',
      'clip',
      'clip-path',
      'mask',
      'mask-image',
      'width',
      'height',
      'min-width',
      'max-height',
      'margin',
      'padding',
      'display',
      'flex',
      'flex-direction',
      'grid',
      'grid-area',
      'z-index',
      'content',
      'filter',
      'backdrop-filter',
      'font-size',
      'line-height',
      'letter-spacing',
      'word-spacing',
      'text-indent',
      'text-transform',
      'writing-mode',
      'direction',
      'visibility',
      'animation',
      'transition',
      'pointer-events',
      'white-space',
      'float',
      'font',
      'outline',
      'outline-offset',
      'cursor',
      'list-style',
      'border-image',
      'fill',
      'stroke',
      'd',
      'resize',
    ])
      expect(isAllowedThemeProperty(name), name).toBe(false)
  })

  test('values that could resolve to something unchecked are refused', () => {
    bad('color', 'var(--x)')
    bad('color', 'var(--ground)'.replace('--ground', '--unknown'))
    bad('background-color', 'calc(1)')
    bad('background-image', 'url(https://x.test/a.png)')
    bad('background-image', 'url(asset:fonts/a.woff2)')
    bad('background-image', 'image-set("a.png" 1x)')
    bad('background-image', 'linear-gradient(url(asset:img/a.png), red)')
    bad('border-width', '20px')
    bad('box-shadow', '0 0 0 999px red')
    bad('text-shadow', '0 0 99px red')
    bad('opacity', '2')
    bad('--radius-m', '99px')
    bad('--ground', '#fff')
    bad('--agent-violet', '#fff')
    bad('font-family', 'url(x)')
    bad('font-family', '"a;b"')
    bad('text-decoration-line', 'line-through')
    bad('color', '')
  })
})

describe('scanThemeCss', () => {
  const refused = (css: string) => scanThemeCss(css).map((finding) => finding.property)

  test('finds declarations at any depth', () => {
    expect(refused('@media (x) { @supports (y) { .a { b { word-spacing: 1px } } } }')).toEqual([
      'word-spacing',
    ])
  })

  test('resolves escapes and comments the way the parser does', () => {
    expect(refused('a { \\77 ord-spacing: 1px }')).toEqual(['word-spacing'])
    // A comment splits a name in two, which the parser reads as no property at all.
    expect(refused('a { wo/**/rd-spacing: 1px }')).toEqual(['wo rd-spacing'])
    expect(refused('a { color: red; /* word-spacing: 1px */ }')).toEqual([])
  })

  test('an escaped semicolon is not a separator, and a stray brace does not end the scan', () => {
    expect(refused('a { color: red\\3b word-spacing: 1px }')).toEqual(['color'])
    expect(refused('} a { word-spacing: 1px }')).toEqual(['word-spacing'])
    expect(refused('a { color: red } } b { transform: none }')).toEqual(['transform'])
  })

  test('strings and parentheses hide structure from the splitter', () => {
    expect(refused('a { font-family: "a;b"; color: red }')).toEqual(['font-family'])
    expect(refused('a { background-image: url(asset:img/a.png); margin: 0 }')).toEqual(['margin'])
  })

  test('at-rules other than the grouping ones are refused with their bodies unread', () => {
    expect(
      refused(
        '@font-face { font-family: x; src: url(a) } @keyframes k { to { color: red } } .a { color: red }',
      ),
    ).toEqual(['@font-face', '@keyframes'])
    expect(refused('@page { margin: 0 }')).toEqual(['@page'])
    expect(refused('@charset "utf-8"; .a { color: red }')).toEqual([])
  })

  test('the shared corpus is classified as written', () => {
    for (const item of THEME_CSS_CORPUS) {
      const found = [...new Set(refused(item.css))].sort()
      expect(found, item.name).toEqual([...item.refused].sort())
    }
  })
})
