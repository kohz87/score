import { describe, expect, test } from 'vitest'
import { checkThemeCss, rewriteAssetUrls, unescapeCss } from '../../src/themes/css-check.ts'

const rejects = (css: string) => expect(checkThemeCss(css).reasons.length).toBeGreaterThan(0)
const accepts = (css: string) => expect(checkThemeCss(css).reasons).toEqual([])

describe('accepted CSS', () => {
  test('ordinary rules, comments and asset urls pass', () => {
    accepts(`/* the content and position: fixed words in a comment are fine */ a{color:red}`)
    accepts(`.card { color: red; background: url(asset:img/bg.webp); border-radius: 4px }`)
    accepts(`.content:hover { color: red } .a-content { color: red } .b { opacity: .5 }`)
    expect(
      checkThemeCss(
        `a{background:url('asset:img/a.png')} b{background-image:url(asset:img/f.webp)}`,
      ).assets,
    ).toEqual(['img/a.png', 'img/f.webp'])
  })
})

describe('rejected CSS', () => {
  test.each([
    ['@import', `@import "x.css";`],
    ['@IMPORT upper case', `@IMPORT url(asset:img/a.png);`],
    ['escaped @import', `@\\69mport "x";`],
    ['@namespace', `@namespace svg url(http://x);`],
    ['content property', `a::before{content:"x"}`],
    ['content with space before colon', `a::before{ content :"x"}`],
    ['escaped content with hex and space', `a::before{\\63 ontent:"x"}`],
    ['escaped content with 6 digits', `a::before{\\000063ontent:"x"}`],
    ['escaped content with backslash-letter', `a::before{con\\tent:"x"}`],
    ['comment-split content', `a::before{con/**/tent:"x"}`],
    ['content after a comment', `a{color:red;/* x */content:"x"}`],
    ['!important', `a{color:red!important}`],
    ['! important with space', `a{color:red ! important}`],
    ['comment-split important', `a{color:red!imp/**/ortant}`],
    ['escaped important', `a{color:red!\\69mportant}`],
    ['position fixed', `a{position:fixed}`],
    ['position: sticky', `a{position : sticky}`],
    ['position -webkit-sticky', `a{position:-webkit-sticky}`],
    ['escaped position', `a{\\70 osition:fixed}`],
    ['escaped fixed value', `a{position:\\66ixed}`],
    ['url external', `a{background:url(http://evil.example/x.png)}`],
    ['url relative', `a{background:url(x.png)}`],
    ['url data', `a{background:url("data:image/png;base64,AAAA")}`],
    ['url with escaped name', `a{background:u\\72l(http://x/y)}`],
    ['url comment split', `a{background:u/**/rl(http://x/y)}`],
    ['url comment inside argument', `a{background:url(/**/http://x/y)}`],
    ['url with an asset prefix hiding a traversal', `a{background:url(asset:img/../../x.png)}`],
    ['url asset outside fonts and img', `a{background:url(asset:other/x.png)}`],
    ['url asset svg', `a{background:url(asset:img/x.svg)}`],
    ['image-set with a bare string', `a{background:image-set("http://x/y.png" 1x)}`],
    ['-webkit-image-set', `a{background:-webkit-image-set("http://x/y.png" 1x)}`],
    ['image() with a bare string', `a{background:image("http://x/y.png")}`],
    [
      'cross-fade()',
      `a{background:cross-fade(url(asset:img/a.png), image("http://x/y.png"), 50%)}`,
    ],
    ['-moz-element() copies another element', `a{background:-moz-element(#approve)}`],
    ['element() escaped', `a{background:\\65 lement(#approve)}`],
    ['expression()', `a{width:expression(alert(1))}`],
    ['expression comment split', `a{width:expr/**/ession(alert(1))}`],
    ['behavior', `a{behavior:url(asset:img/x.png)}`],
    ['-moz-binding', `a{-moz-binding:url(asset:img/x.png)}`],
    ['javascript:', `a{background:url(javascript:alert(1))}`],
    ['escaped javascript:', `a{x:\\6a avascript:1}`],
    ['a fake comment opener the parser does not see', `/\\* */ a::before{content:"x"} /* */`],
    ['an unterminated comment does not hide earlier code', `a{content:"x"} /* never closed`],
    [
      '@font-face (fonts belong to the manifest)',
      `@font-face { font-family: X; src: url("asset:fonts/x.woff2") }`,
    ],
    ['a property off the allowlist', `a{z-index:3}`],
    ['nested off the allowlist', `@media (width<1px){ a{ b{ word-spacing:-9px } } }`],
    ['escaped property off the allowlist', `a{\\77 ord-spacing:-9px}`],
    ['too large', `a{color:red}${' '.repeat(262_145)}`],
  ])('%s', (_name, css) => rejects(css))
})

describe('helpers', () => {
  test('unescape handles hex, optional whitespace, continuations and plain escapes', () => {
    expect(unescapeCss('\\63 ontent')).toBe('content')
    expect(unescapeCss('\\63ontent')).toBe('content')
    expect(unescapeCss('a\\\nb')).toBe('ab')
    expect(unescapeCss('\\@import')).toBe('@import')
    expect(unescapeCss('\\0 x')).toBe('\uFFFDx')
    expect(unescapeCss('\\110000 x')).toBe('\uFFFDx')
  })

  test('serving rewrites asset: references to the asset URLs and leaves the rest alone', () => {
    expect(
      rewriteAssetUrls(
        `a{background:url(asset:img/bg.webp)} @font-face{src:url("asset:fonts/x.woff2")} b{color:red}`,
        'seaside',
        'f'.repeat(64),
      ),
    ).toBe(
      `a{background:url(/api/themes/seaside/assets/img/bg.webp?rev=${'f'.repeat(64)})} @font-face{src:url("/api/themes/seaside/assets/fonts/x.woff2?rev=${'f'.repeat(64)}")} b{color:red}`,
    )
  })

  // Third gate finding 6: references are read as CSS (the browser's draft check uses the same function).
  test('asset references ignore comments and decode escapes', () => {
    expect(checkThemeCss('/* Example asset:img/missing.png */ a{color:red}').assets).toEqual([])
    expect(checkThemeCss('a{background-image:url(asset\\3a img/a.png)}').assets).toEqual([
      'img/a.png',
    ])
    expect(checkThemeCss('a{background-image:u\\72 l("asset\\:img/a.png")}').assets).toEqual([
      'img/a.png',
    ])
  })

  test('serving rewrites escaped references too, and leaves comments alone', () => {
    expect(
      rewriteAssetUrls(
        'a{background-image:url(asset\\3a img/a.png)} /* url(asset:img/b.png) is a note */',
        'seaside',
        'f'.repeat(64),
      ),
    ).toBe(
      `a{background-image:url(/api/themes/seaside/assets/img/a.png?rev=${'f'.repeat(64)})} /* url(asset:img/b.png) is a note */`,
    )
  })
})
