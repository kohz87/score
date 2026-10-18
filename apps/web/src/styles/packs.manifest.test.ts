import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { THEME_COLOR_TOKENS, ThemeManifestSchema } from '@score/contract'
import { declarations } from './contrast-pairs.ts'
import { packs } from './packs.ts'

// C4 #1: Paper, Night shift and Dense are worn through styles/packs/<id>.css (unchanged, pixel-identical) and are also
// full theme packages in apps/server/themes/<id>/, so the Customizer's "Start from" copies them exactly. The two must
// say the same thing; this is the test that keeps them from drifting.
const root = join(import.meta.dirname, '../../../..')
const read = (...parts: string[]) => readFileSync(join(root, ...parts), 'utf8')

describe.each(packs.filter((pack) => pack.id !== 'score'))(
  'pack $id as a theme package',
  (pack) => {
    const folder = join('apps/server/themes', pack.id)
    const manifest = ThemeManifestSchema.parse(JSON.parse(read(folder, 'theme.json')))
    const css = read('apps/web/src/styles/packs', `${pack.id}.css`)
    const sel = `[data-pack='${pack.id}']`
    const light = declarations(css, sel)
    const dark = declarations(css, `${sel}[data-theme='dark']`)
    const colors = (set: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(set)
          .filter(([name]) => (THEME_COLOR_TOKENS as readonly string[]).includes(name.slice(2)))
          .map(([name, value]) => [name.slice(2), value]),
      )

    it('has the pack’s id, name and blurb-level facts', () => {
      expect(manifest.id).toBe(pack.id)
      expect(manifest.name).toBe(pack.name)
      expect(manifest.layout?.nav ?? 'top').toBe(pack.layout === 'side' ? 'left' : 'top')
      expect(manifest.shape?.density ?? 'comfortable').toBe(pack.density)
    })

    it('carries every public colour the pack sets, in both modes', () => {
      expect(manifest.colors?.light).toEqual(colors(light))
      expect(manifest.colors?.dark).toEqual(colors({ ...light, ...dark }))
    })

    it('has the pack’s card radius and fonts', () => {
      expect(`${manifest.shape?.radius}px`).toBe(light['--radius-card'])
      for (const key of ['heading', 'body'] as const) {
        const stack = light[`--font-${key}`]
        expect(manifest.fonts?.[key]).toBe(stack ? /^'([^']+)'/.exec(stack)![1] : undefined)
      }
    })

    it('sets the type scale the pack sets, in style.css', () => {
      const file = join(root, folder, 'style.css')
      const sheet = existsSync(file) ? readFileSync(file, 'utf8') : ''
      for (const name of ['--h1-size', '--body-size']) {
        const value = light[name]
        if (value) expect(sheet).toContain(`${name}: ${value};`)
        else expect(sheet).not.toContain(name)
      }
    })
  },
)
