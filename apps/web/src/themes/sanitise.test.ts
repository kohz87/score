import { describe, expect, test } from 'vitest'
import { OUTSIDE_PROTECTED, confineSelector, sanitiseCss, splitDeclarations } from './sanitise.ts'

const reasons = (css: string) => sanitiseCss(css).report.dropped.map((item) => item.reason)

describe('sanitiseCss', () => {
  test('keeps plain rules and drops nothing', () => {
    const result = sanitiseCss('.now-card { color: red; border-radius: 4px }')
    expect(result.css).toContain('.now-card { color: red; border-radius: 4px; }')
    expect(result.report.dropped).toEqual([])
  })

  test('drops each reason and reports it', () => {
    expect(reasons('@import url("https://x.test/a.css"); a { color: red }')).toEqual(['import'])
    expect(reasons('a { background: url(https://x.test/a.png) }')).toEqual(['external_url'])
    expect(reasons('a::after { content: "Approve" }')).toEqual(['content'])
    expect(reasons('a { position: fixed }')).toEqual(['property_not_allowed'])
    expect(reasons('a { position: sticky; top: 0 }')).toEqual([
      'property_not_allowed',
      'property_not_allowed',
    ])
    expect(reasons('a { z-index: 51 }')).toEqual(['property_not_allowed'])
    expect(reasons('a { z-index: var(--x) }')).toEqual(['property_not_allowed'])
    expect(reasons('a { pointer-events: none }')).toEqual(['property_not_allowed'])
    expect(reasons('a { color: var(--x) }')).toEqual(['value_not_allowed'])
    expect(reasons('a { color: red !important }')).toEqual(['important'])
    expect(reasons('[data-protected] { opacity: 0 }')).toEqual(['protected_selector'])
    expect(reasons('.chat-approval button { display: none }')).toEqual(['protected_selector'])
    expect(reasons('.orch-decision--gate { color: red }')).toEqual(['protected_selector'])
    expect(reasons('.agent-glyph__ring { fill: none }')).toEqual(['protected_selector'])
    // The room stage and every part of it (PLAN 10.10).
    expect(reasons('.room-stage { display: none }')).toEqual(['protected_selector'])
    expect(reasons('.room-stage__body { color: red }')).toEqual(['protected_selector'])
    expect(reasons('.chat-thread .room-stage__badge { display: none }')).toEqual([
      'protected_selector',
    ])
    expect(reasons('.orch-decisions { color: red }')).toEqual(['protected_selector'])
    // Gate #2: the task drawer's approval and the add-coding-agent permission controls are protected too.
    expect(reasons('.task-drawer-approval { display: none }')).toEqual(['protected_selector'])
    expect(reasons('.task-drawer-buttons button { display: none }')).toEqual(['protected_selector'])
    expect(reasons('.team-coding-permission { display: none }')).toEqual(['protected_selector'])
    expect(reasons('.coding-reach, .coding-acknowledge { display: none }')).toEqual([
      'protected_selector',
    ])
    expect(reasons('.watch-approval button { display: none }')).toEqual(['protected_selector'])
    expect(reasons('.orch-ack { display: none }')).toEqual(['protected_selector'])
    // Gate #8: the way back.
    expect(reasons('.command-run, .command-palette { display: none }')).toEqual([
      'protected_selector',
    ])
    expect(reasons('.menu-trigger { display: none }')).toEqual(['protected_selector'])
    expect(reasons('.settings-card { color: red }')).toEqual([])
    expect(reasons('@font-face { font-family: x; src: url(a.woff2) }')).toEqual(['font_face'])
  })

  test('keeps asset: urls and rewrites them for the theme', () => {
    const css = 'a { background-image: url(asset:img/bg.webp) }'
    expect(sanitiseCss(css).css).toContain('url("asset:img/bg.webp")')
    const rev = 'cd'.repeat(32)
    expect(sanitiseCss(css, { themeId: 'harbour', rev }).css).toContain(
      `url("/api/themes/harbour/assets/img/bg.webp?rev=${rev}")`,
    )
    // No revision, no URL: the reference stays an `asset:` one rather than becoming an unversioned address.
    expect(sanitiseCss(css, { themeId: 'harbour' }).css).toContain('url("asset:img/bg.webp")')
    expect(reasons('a { background: url(asset:../../etc/passwd) }')).toEqual(['external_url'])
    expect(reasons('a { background: url(asset:img/a.svg) }')).toEqual(['external_url'])
  })

  test('keeps the safe declarations of a rule and drops the rest', () => {
    const result = sanitiseCss('.x { color: blue; z-index: 999; margin: 4px }')
    expect(result.css).toContain('color: blue')
    expect(result.css).not.toContain('margin')
    expect(result.css).not.toContain('z-index')
  })

  test('walks nested at-rules', () => {
    const css = `
      @media (min-width: 600px) {
        @supports (display: grid) {
          .a { color: red; position: fixed }
          .chat-approval { opacity: 0 }
        }
      }
      @layer theme { .b { pointer-events: none; color: green } }
    `
    const result = sanitiseCss(css)
    expect(result.css).toContain('@media (min-width: 600px)')
    expect(result.css).toContain('.a { color: red; }')
    expect(result.css).not.toContain('chat-approval')
    expect(result.css).not.toContain('pointer-events')
    expect(result.css).toContain('.b { color: green; }')
    expect(result.report.dropped.map((item) => item.reason).sort()).toEqual([
      'property_not_allowed',
      'property_not_allowed',
      'protected_selector',
    ])
  })

  test('drops :has() that reaches a protected element, at any depth', () => {
    expect(reasons('.card:has([data-protected]) { opacity: 0 }')).toEqual(['protected_selector'])
    expect(reasons('main:has(.chat-approval) { display: none }')).toEqual(['protected_selector'])
    expect(
      reasons('@media (min-width: 1px) { body:has(.now-asking) { filter: blur(3px) } }'),
    ).toEqual(['protected_selector'])
    expect(reasons('.card:has(.plain) { opacity: 0.5 }')).toEqual([])
  })

  test('refuses the protected layer and agent identity or rules colours', () => {
    expect(reasons('@layer score-protected { a { color: red } }')).toEqual(['protected_selector'])
    expect(
      reasons(':root { --agent-violet: #fff; --rules-never: #fff; --link-hover: #fff }'),
    ).toEqual(['protected_selector', 'protected_selector'])
    // The pairs a protected surface draws are set in the manifest, where the contrast check sees them.
    expect(reasons(':root { --ground: #fff; --ink: #000 }')).toEqual([
      'property_not_allowed',
      'property_not_allowed',
    ])
  })

  test('drops everything where the browser cannot parse a constructed sheet', () => {
    const original = CSSStyleSheet.prototype.replaceSync
    // @ts-expect-error simulating an old browser
    delete CSSStyleSheet.prototype.replaceSync
    try {
      const result = sanitiseCss('a { color: red }')
      expect(result.css).toBe('')
      expect(result.report.dropped.length).toBe(1)
    } finally {
      CSSStyleSheet.prototype.replaceSync = original
    }
  })
})

describe('splitDeclarations', () => {
  test('ignores semicolons inside urls and strings', () => {
    expect(splitDeclarations('a: url(data:image/png;base64,xx); b: "x;y"; c: d')).toEqual([
      'a: url(data:image/png;base64,xx)',
      'b: "x;y"',
      'c: d',
    ])
  })
})

describe('confining theme rules to the outside of protected subtrees (gate #3, #5)', () => {
  const guard = OUTSIDE_PROTECTED

  test('every selector of a list gets the guard, before a pseudo-element', () => {
    expect(confineSelector('.a')).toBe(`.a${guard}`)
    expect(confineSelector('.a > b, c d')).toBe(`.a > b${guard}, c d${guard}`)
    expect(confineSelector('.a::before')).toBe(`.a${guard}::before`)
    expect(confineSelector('.a:hover::after, b:first-line')).toBe(
      `.a:hover${guard}::after, b${guard}:first-line`,
    )
    // Commas, colons and brackets inside attribute values and functions are not separators.
    expect(confineSelector('a[href="x,y::z"], :is(b, c) d')).toBe(
      `a[href="x,y::z"]${guard}, :is(b, c) d${guard}`,
    )
  })

  test('the guard has no specificity of its own', () => {
    expect(guard.startsWith(':where(')).toBe(true)
  })

  test('sanitiseCss confines on request only, and nested rules too', () => {
    const css = 'svg path { color: red } .card { color: blue; & .x { color: red } }'
    expect(sanitiseCss(css).css).not.toContain('data-protected')
    const confined = sanitiseCss(css, { confine: true }).css
    expect(confined).toContain(`svg path${guard} {`)
    expect(confined).toContain(`.card${guard} {`)
  })

  test('media and layer blocks are confined inside', () => {
    const confined = sanitiseCss('@media (min-width: 1px) { .a b { color: red } }', {
      confine: true,
    }).css
    expect(confined).toContain(`.a b${guard} { color: red; }`)
  })

  test('animation, transition and keyframes are dropped (gate #6)', () => {
    expect(reasons('@keyframes fade { to { opacity: 0 } }')).toEqual(['other_at_rule'])
    expect(reasons('.a { animation: fade 1s 3s forwards }')).toEqual(['property_not_allowed'])
    expect(reasons('.a { animation-name: score-fade-in; animation-delay: 3s }')).toEqual([
      'property_not_allowed',
      'property_not_allowed',
    ])
    expect(reasons('.a { -webkit-animation: x 1s; transition: opacity 1s }')).toEqual([
      'property_not_allowed',
      'property_not_allowed',
    ])
    expect(reasons('.a { transition-property: opacity; transition-delay: 2s }')).toEqual([
      'property_not_allowed',
      'property_not_allowed',
    ])
    const kept = sanitiseCss(
      '.a { animation: fade 1s; color: red } @keyframes fade { to { opacity: 0 } }',
    )
    expect(kept.css).toContain('.a { color: red; }')
    expect(kept.css).not.toMatch(/animation|keyframes|fade/)
  })

  test('a theme can’t replace the geometry of a path', () => {
    expect(reasons('path { d: path("M0 0 L1 1") }')).toEqual(['property_not_allowed'])
  })
})
