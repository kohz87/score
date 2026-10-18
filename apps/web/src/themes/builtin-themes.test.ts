import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUILTIN_THEME_IDS, THEME_COLOR_TOKENS, ThemeManifestSchema } from '@score/contract'
import { baseTokens, contrast, pairs, resolve } from '../styles/contrast-pairs.ts'
import { failsProtectedContrast, tokenCss } from './engine.ts'
import { sanitiseCss } from './sanitise.ts'

// The built-in themes of 9.5 (Harbour, Ledger, Studio) are packages in apps/server/themes. Whatever they look like,
// they must pass WCAG AA in both modes, keep Score's protected-surface guarantees and carry nothing the sanitiser
// would drop.
const root = join(import.meta.dirname, '../../../..')
const ids = BUILTIN_THEME_IDS.slice(4)
// The example theme of the author guide (docs/themes/example-theme) has to be just as safe: people start from it.
const folders: Record<string, string> = {
  ...Object.fromEntries(ids.map((id) => [id, join(root, 'apps/server/themes', id)])),
  sandbar: join(root, 'docs/themes/example-theme'),
}

function load(id: string) {
  const manifest = ThemeManifestSchema.parse(
    JSON.parse(readFileSync(join(folders[id]!, 'theme.json'), 'utf8')),
  )
  const css = readFileSync(join(folders[id]!, 'style.css'), 'utf8')
  return { manifest, css }
}

/** Score's tokens with the theme's colours laid over, as the page resolves them. */
function tokensFor(id: string, mode: 'light' | 'dark'): Record<string, string> {
  const colors = load(id).manifest.colors?.[mode] ?? {}
  return {
    ...baseTokens(mode),
    ...Object.fromEntries(Object.entries(colors).map(([name, value]) => [`--${name}`, value])),
  }
}

describe('the built-in themes of 9.5 and the example theme', () => {
  it('are the three ids after the four packs', () => {
    expect(ids).toEqual(['harbour', 'ledger', 'studio'])
  })

  describe.each(Object.keys(folders))('%s', (id) => {
    const { manifest, css } = load(id)

    it('is a valid manifest with its own id', () => {
      expect(manifest.id).toBe(id)
      if (id !== 'sandbar') expect(manifest.author).toBe('Score')
      expect(manifest.description).toBeTruthy()
    })

    it('sets both modes with plain hex colours from the public list', () => {
      for (const mode of ['light', 'dark'] as const) {
        const colors = manifest.colors?.[mode] ?? {}
        expect(Object.keys(colors).length).toBeGreaterThan(10)
        for (const [token, value] of Object.entries(colors)) {
          expect(THEME_COLOR_TOKENS as readonly string[]).toContain(token)
          expect(value).toMatch(/^#[0-9a-f]{6}$/)
        }
      }
    })

    it('has a stylesheet the sanitiser keeps whole', () => {
      const result = sanitiseCss(css, { themeId: id })
      expect(result.report.dropped).toEqual([])
    })

    it('leaves the protected surfaces on their own colours only when it must (no fallback)', () => {
      const look = { colors: manifest.colors }
      expect(failsProtectedContrast(look, 'light')).toBe(false)
      expect(failsProtectedContrast(look, 'dark')).toBe(false)
    })

    it('writes only public tokens into its generated sheet', () => {
      const sheet = tokenCss({ colors: manifest.colors, fonts: manifest.fonts }, id)
      for (const name of sheet.matchAll(/--([a-z0-9-]+):/g))
        expect([...THEME_COLOR_TOKENS, 'font-heading', 'font-body', 'font-code']).toContain(name[1])
    })

    describe.each(['light', 'dark'] as const)('%s', (mode) => {
      const tokens = tokensFor(id, mode)
      it.each(pairs)('%s on %s is at least %s:1 (%s)', (fg, bg, min) => {
        expect(contrast(resolve(tokens, fg), resolve(tokens, bg))).toBeGreaterThanOrEqual(min)
      })

      it('draws its own chat bubbles at AA', () => {
        const own = tokens['--bubble-own'] ?? tokens['--ink']
        const ink = tokens['--bubble-own-ink'] ?? tokens['--card']
        expect(
          contrast(resolve({ '--a': ink! }, 'a'), resolve({ '--b': own! }, 'b')),
        ).toBeGreaterThanOrEqual(4.5)
      })
    })
  })
})
