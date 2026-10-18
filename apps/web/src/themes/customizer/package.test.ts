import { describe, expect, it } from 'vitest'
import { emptyManifest } from './draft.ts'
import { buildThemePackage, readThemePackage } from './package.ts'
import { writeZip } from './zip.ts'

const text = (value: string) => new TextEncoder().encode(value)
const manifest = { ...emptyManifest('harbour', 'Harbour'), shape: { radius: 'round' as const } }

describe('theme packages', () => {
  it('round-trips what the server’s layout holds', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1])
    const zip = buildThemePackage({
      manifest: { ...manifest, background: { image: 'asset:img/b.png', fit: 'cover', dim: 10 } },
      css: '.a { color: red }',
      assets: new Map([['img/b.png', png]]),
    })
    const read = await readThemePackage(zip)
    expect(read.ok).toBe(true)
    if (read.ok) {
      expect(read.pkg.manifest.id).toBe('harbour')
      expect(read.pkg.css).toBe('.a { color: red }')
      expect([...read.pkg.assets.keys()]).toEqual(['img/b.png'])
    }
  })

  it('says what is wrong with a package, in words', async () => {
    const bad = async (files: [string, Uint8Array][]) => {
      const read = await readThemePackage(writeZip(files))
      return read.ok ? [] : read.reasons
    }
    expect(await bad([['style.css', text('a{}')]])).toContain('theme.json is missing.')
    expect(await bad([['theme.json', text('{nope')]])).toContain('theme.json isn’t valid JSON.')
    expect(await bad([['theme.json', text(JSON.stringify({ ...manifest, format: 2 }))]])).toContain(
      'This theme was made for a newer Score. Update Score to use it.',
    )
    expect(
      await bad([
        ['theme.json', text(JSON.stringify(manifest))],
        ['notes.txt', text('x')],
      ]),
    ).toEqual(['“notes.txt” isn’t part of a theme package.'])
    expect(
      await bad([
        ['theme.json', text(JSON.stringify(manifest))],
        ['style.css', text('.a { background: url(asset:img/gone.png) }')],
      ]),
    ).toEqual(['asset:img/gone.png is used but isn’t in the package.'])
    expect(await bad([['theme.json', text(JSON.stringify({ ...manifest, name: '' }))]])).toEqual([
      'Give the theme a name (1–60 characters).',
    ])
  })
})
