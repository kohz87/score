import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { THEME_COLOR_TOKENS } from '@score/contract'
import { afterEach, describe, expect, test } from 'vitest'
import {
  applyBuiltin,
  applyCustom,
  backgroundCss,
  clearLook,
  defaultColorPairs,
  failsProtectedContrast,
  fontFaceCss,
  LOOK_ATTRIBUTES,
  themeAttributes,
  tokenCss,
} from './engine.ts'

afterEach(() => {
  clearLook()
  document.head.querySelectorAll('style').forEach((style) => style.remove())
  for (const name of ['data-pack', 'data-layout', 'data-density'])
    document.documentElement.removeAttribute(name)
})

const manifest = {
  colors: {
    light: { ground: '#fafafa', ink: '#101010', card: '#ffffff' },
    dark: { ground: '#000000' },
  },
  fonts: {
    heading: 'Fraunces',
    body: 'Georgia',
    faces: [
      {
        family: 'Fraunces',
        src: 'asset:fonts/f.woff2',
        weight: '400 700',
        style: 'normal' as const,
      },
    ],
  },
  shape: {
    radius: 'sharp' as const,
    density: 'airy' as const,
    border: 'hairline' as const,
    elevation: 'floating' as const,
    surface: 'glass' as const,
  },
  layout: {
    nav: 'left' as const,
    contentWidth: 'narrow' as const,
    chat: { messages: 'bubbles' as const },
  },
}

describe('theme engine', () => {
  test('a manifest becomes the attributes the stylesheets read', () => {
    expect(themeAttributes(manifest)).toEqual({
      'data-look': 'custom',
      'data-radius': 'sharp',
      'data-border': 'hairline',
      'data-elevation': 'floating',
      'data-surface': 'glass',
      'data-nav': 'left',
      'data-width': 'narrow',
      'data-chat': 'bubbles',
    })
    expect(themeAttributes({ shape: { radius: 12 } })['data-radius']).toBe('custom')
  })

  test('tokens are generated for both modes from the public tokens only', () => {
    const css = tokenCss(
      {
        colors: {
          light: { ground: '#fafafa', 'agent-violet': '#ff0000', 'rules-never': '#fff' } as never,
          dark: { ground: '#000000' },
        },
      },
      'harbour',
    )
    expect(css).toContain("[data-theme='light']{--ground:#fafafa;}")
    expect(css).toContain("[data-theme='dark']{--ground:#000000;}")
    expect(css).toContain('@media (prefers-color-scheme: dark)')
    expect(css).not.toContain('agent-violet')
    expect(css).not.toContain('rules-never')
    expect(THEME_COLOR_TOKENS).toHaveLength(38)
  })

  test('a colour that is not a plain colour is ignored (no url(), no var())', () => {
    const css = tokenCss(
      {
        colors: { light: { ground: 'url(https://x.test/a)', card: 'var(--ink)', ink: '#123456' } },
      },
      'x',
    )
    expect(css).not.toContain('url(')
    expect(css).not.toContain('var(')
    expect(css).toContain('--ink:#123456;')
  })

  test('fonts get their own family name, so a theme can never replace one of Score’s fonts', () => {
    const css = tokenCss(manifest, 'harbour')
    expect(css).toContain('--font-heading:"theme-harbour-Fraunces"')
    expect(css).toContain('--font-body:"Georgia"')
    const faces = fontFaceCss(manifest, 'harbour')
    expect(faces).toContain('font-family:"theme-harbour-Fraunces"')
    expect(faces).toContain('url("/api/themes/harbour/assets/fonts/f.woff2")')
    expect(
      fontFaceCss(
        {
          fonts: {
            faces: [
              {
                family: 'Hanken Grotesk',
                src: 'asset:fonts/h.woff2',
                weight: '400',
                style: 'normal',
              },
            ],
          },
        },
        'evil',
      ),
    ).toContain('font-family:"theme-evil-Hanken-Grotesk"')
    expect(
      fontFaceCss(
        {
          fonts: {
            faces: [
              { family: 'X', src: 'asset:../x.woff2' as never, weight: '400', style: 'normal' },
            ],
          },
        },
        'x',
      ),
    ).toBe('')
  })

  test('a background image is a same-origin asset URL with a dimming veil', () => {
    const css = backgroundCss(
      { background: { image: 'asset:img/bg.webp', fit: 'tile', dim: 40 } },
      'harbour',
    )
    expect(css).toContain('url("/api/themes/harbour/assets/img/bg.webp")')
    expect(css).toContain('40%')
    expect(css).toContain('repeat')
    expect(
      backgroundCss(
        { background: { image: 'https://x.test/a.png' as never, fit: 'cover', dim: 0 } },
        'x',
      ),
    ).toBe('')
  })

  test('contrast: a failing pair on a protected surface asks for the default pair', () => {
    expect(
      failsProtectedContrast({ colors: { light: { ink: '#101010', card: '#ffffff' } } }, 'light'),
    ).toBe(false)
    expect(
      failsProtectedContrast({ colors: { light: { ink: '#dddddd', card: '#ffffff' } } }, 'light'),
    ).toBe(true)
    expect(failsProtectedContrast({ colors: { dark: { 'ink-muted': '#222222' } } }, 'dark')).toBe(
      true,
    )
    expect(failsProtectedContrast({}, 'light')).toBe(false)
    expect(failsProtectedContrast({}, 'dark')).toBe(false)
  })

  test('the default pairs match tokens.css', () => {
    const css = readFileSync(join(__dirname, '../styles/tokens.css'), 'utf8')
    const light = /^:root,\n\[data-pack='score'\] \{([^}]*)\}/m.exec(css)?.[1] ?? ''
    const dark = /^:root\[data-theme='dark'\][^{]*\{([^}]*)\}/m.exec(css)?.[1] ?? ''
    for (const [mode, block] of [
      ['light', light],
      ['dark', dark],
    ] as const)
      for (const [token, value] of Object.entries(defaultColorPairs[mode])) {
        const found = new RegExp(`--${token}: (#[0-9a-f]{6});`).exec(block)?.[1]
        // Tokens the dark block leaves alone keep their light value.
        expect(found ?? new RegExp(`--${token}: (#[0-9a-f]{6});`).exec(light)?.[1]).toBe(value)
      }
  })

  test('applying sets attributes and sheets, switching cleans up, a built-in pack restores the pack look', () => {
    const root = document.documentElement
    const result = applyCustom(
      { id: 'harbour', manifest, css: '.now-card { color: red }' },
      'light',
    )
    expect(root.getAttribute('data-look')).toBe('custom')
    expect(root.getAttribute('data-nav')).toBe('left')
    expect(root.getAttribute('data-layout')).toBe('side')
    expect(root.getAttribute('data-density')).toBe('airy')
    expect(root.hasAttribute('data-contrast-fallback')).toBe(false)
    expect(result.cache.css).toContain('--ground:#fafafa')
    const texts = [...document.head.querySelectorAll('style[data-score-look]')].map(
      (s) => s.textContent,
    )
    expect(texts.join('\n')).toContain('.now-card { color: red; }')

    applyBuiltin('night')
    for (const name of LOOK_ATTRIBUTES) expect(root.hasAttribute(name)).toBe(false)
    expect(root.getAttribute('data-pack')).toBe('night')
    expect(document.head.querySelectorAll('style[data-score-look]')).toHaveLength(0)
  })

  test('a theme with failing contrast sets data-contrast-fallback', () => {
    applyCustom(
      { id: 'pale', manifest: { colors: { light: { ink: '#eeeeee' } } }, css: '' },
      'light',
    )
    expect(document.documentElement.hasAttribute('data-contrast-fallback')).toBe(true)
  })

  test('an invalid id throws and leaves the look cleared', () => {
    expect(() => applyCustom({ id: 'Bad Id', manifest: {}, css: '' }, 'light')).toThrow()
    expect(document.documentElement.hasAttribute('data-look')).toBe(false)
  })
})
