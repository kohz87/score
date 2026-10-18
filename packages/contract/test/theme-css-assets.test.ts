import { describe, expect, test } from 'vitest'
import { cssAssetPaths, cssAssetReferences } from '../src/theme-css-assets.ts'

// Third gate finding 6: one CSS-aware reader of `asset:` references, used by the browser's draft check and the server.
describe('cssAssetPaths', () => {
  const cases: [string, string, string[]][] = [
    ['a plain reference', '.a{background:url(asset:img/a.png)}', ['img/a.png']],
    ['double quotes', '.a{background:url("asset:img/a.png")}', ['img/a.png']],
    ['single quotes and spaces', ".a{background:url( 'asset:img/a.png' )}", ['img/a.png']],
    ['upper-case function name', '.a{background:URL(asset:img/a.png)}', ['img/a.png']],
    ['a font', '@font-face{src:url(asset:fonts/f.woff2)}', ['fonts/f.woff2']],
    [
      'sorted, without repeats',
      '.a{b:url(asset:img/b.png)}.c{d:url(asset:img/a.png) url(asset:img/b.png)}',
      ['img/a.png', 'img/b.png'],
    ],
    ['a comment is not a reference', '/* asset:img/missing.png */ .a{color:red}', []],
    ['url() inside a comment', '/* url(asset:img/missing.png) */', []],
    [
      'a comment with a star inside',
      '/* ** url(asset:img/x.png) ** */ .a{b:url(asset:img/y.png)}',
      ['img/y.png'],
    ],
    [
      'an unterminated comment runs to the end',
      '.a{b:url(asset:img/a.png)}/* url(asset:img/b.png)',
      ['img/a.png'],
    ],
    ['url() inside a string', '.a{content:"url(asset:img/x.png)"}', []],
    [
      'a string with an escaped quote',
      '.a{content:"\\" url(asset:img/x.png)"}.b{c:url(asset:img/y.png)}',
      ['img/y.png'],
    ],
    ['text outside url()', '.a{b:asset:img/a.png}', []],
    ['a hex-escaped colon', '.a{b:url(asset\\3a img/a.png)}', ['img/a.png']],
    ['a hex-escaped colon without the space', '.a{b:url(asset\\3a img/a.png)}', ['img/a.png']],
    ['an escaped colon in quotes', '.a{b:url("asset\\:img/a.png")}', ['img/a.png']],
    ['an escaped letter of the scheme', '.a{b:url(\\61 sset:img/a.png)}', ['img/a.png']],
    ['an escaped letter of the file', '.a{b:url(asset:img/\\61.png)}', ['img/a.png']],
    ['an escaped function name', '.a{b:u\\72 l(asset:img/a.png)}', ['img/a.png']],
    ['an escaped slash', '.a{b:url(asset:img\\/a.png)}', ['img/a.png']],
    ['a comment does not split the function name', '.a{b:ur/**/l(asset:img/a.png)}', []],
    ['a longer name is not url()', '.a{b:myurl(asset:img/a.png)}', []],
    ['a dash-prefixed name is not url()', '.a{b:-url(asset:img/a.png)}', []],
    ['a number before it makes one token', '.a{b:1url(asset:img/a.png)}', []],
    ['whitespace inside a bare url is a bad url', '.a{b:url(asset:img/a.png x)}', []],
    ['a quote inside a bare url is a bad url', '.a{b:url(asset:img/a".png)}', []],
    [
      'a path outside the package layout',
      '.a{b:url(asset:img/../a.png) url(asset:css/a.png) url(asset:img/a.gif)}',
      [],
    ],
    ['another scheme', '.a{b:url(https://example.com/a.png)}', []],
    [
      'an escaped newline in a string continues it',
      '.a{b:url("asset:img/\\\na.png")}',
      ['img/a.png'],
    ],
    ['a lone backslash at the end', '.a{b:url(asset:img/a.png)} \\', ['img/a.png']],
    ['an unclosed function', '.a{b:url(asset:img/a.png', []],
  ]
  test.each(cases)('%s', (_name, css, expected) => {
    expect(cssAssetPaths(css)).toEqual(expected)
  })

  test('the position covers the whole function and reports the quote', () => {
    const css = '.a{b:url( "asset:img/a.png" )}.c{d:u\\72l(asset:img/b.png)}'
    const found = cssAssetReferences(css)
    expect(found.map((ref) => [css.slice(ref.start, ref.end), ref.quote])).toEqual([
      ['url( "asset:img/a.png" )', '"'],
      ['u\\72l(asset:img/b.png)', ''],
    ])
  })
})
