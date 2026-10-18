import { describe, expect, it } from 'vitest'
import { buildZip, unicodePathExtra } from '@score/contract/test/theme-package-zip'
import { emptyManifest } from './draft.ts'
import { buildThemePackage, readThemePackage } from './package.ts'
import { readZip, writeZip } from './zip.ts'

const text = (value: string) => new TextEncoder().encode(value)
const manifest = { ...emptyManifest('harbour', 'Harbour'), shape: { radius: 'round' as const } }

describe('theme packages', () => {
  it('round-trips what the server’s layout holds', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1])
    const zip = buildThemePackage({
      manifest: { ...manifest, background: { image: 'asset:img/b.png', fit: 'cover', dim: 10 } },
      css: '.a { color: red }',
      assets: new Map([['img/b.png', png]]),
      licenses: {},
    })
    const read = await readThemePackage(zip)
    expect(read.ok).toBe(true)
    if (read.ok) {
      expect(read.pkg.manifest.id).toBe('harbour')
      expect(read.pkg.css).toBe('.a { color: red }')
      expect([...read.pkg.assets.keys()]).toEqual(['img/b.png'])
    }
  })

  it('keeps the licence texts of a package: imports them and writes them back', async () => {
    const files: [string, Uint8Array][] = [
      ['theme.json', text(JSON.stringify(manifest))],
      ['OFL.txt', text('SIL Open Font License 1.1 — Copyright 2024 The Fonts Project')],
      ['LICENSE', text('MIT')],
    ]
    const read = await readThemePackage(writeZip(files))
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.pkg.licenses).toEqual({
      LICENSE: 'MIT',
      'OFL.txt': 'SIL Open Font License 1.1 — Copyright 2024 The Fonts Project',
    })
    const again = await readThemePackage(buildThemePackage(read.pkg))
    expect(again.ok && again.pkg.licenses).toEqual(read.pkg.licenses)
    const names = [...(await readZip(buildThemePackage(read.pkg))).keys()]
    expect(names).toEqual(['theme.json', 'LICENSE', 'OFL.txt'])
  })

  it('refuses other root files, oversize licences and licences that aren’t text', async () => {
    const bad = async (files: [string, Uint8Array][]) => {
      const read = await readThemePackage(
        writeZip([['theme.json', text(JSON.stringify(manifest))], ...files]),
      )
      return read.ok ? [] : read.reasons
    }
    expect(await bad([['COPYING', text('x')]])).toEqual([
      '“COPYING” isn’t part of a theme package.',
    ])
    expect(await bad([['OFL.txt', new Uint8Array(64 * 1024 + 1).fill(97)]])).toEqual([
      'OFL.txt is larger than 64 KB.',
    ])
    expect(await bad([['LICENSE', Uint8Array.from([0xff, 0xfe, 0xfd])]])).toEqual([
      'LICENSE isn’t valid UTF-8 text.',
    ])
    expect((await bad([['OFL.txt', new Uint8Array(64 * 1024).fill(97)]])).length).toBe(0)
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

  // Re-gate finding 1: the Customizer previews `theme.json` as the reviewed manifest while a reader that honours
  // Info-ZIP Unicode Path fields would install the other file as `theme.json`.
  it('refuses a package whose Unicode path fields rename its entries', async () => {
    const crafted = buildZip([
      {
        name: 'theme.json',
        data: JSON.stringify(manifest),
        centralExtra: unicodePathExtra('theme.json', 'LICENSE'),
        localExtra: unicodePathExtra('theme.json', 'LICENSE'),
      },
      {
        name: 'OFL.txt',
        data: JSON.stringify({ ...manifest, id: 'other-theme' }),
        centralExtra: unicodePathExtra('OFL.txt', 'theme.json'),
        localExtra: unicodePathExtra('OFL.txt', 'theme.json'),
      },
    ])
    const read = await readThemePackage(crafted)
    expect(read.ok).toBe(false)
  })
})
