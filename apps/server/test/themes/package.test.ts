import JSZip from 'jszip'
import { describe, expect, test } from 'vitest'
import { ThemeManifestSchema } from '@score/contract'
import {
  MAX_UPLOAD_BYTES,
  ThemeRejected,
  buildThemePackage,
  readThemePackage,
} from '../../src/themes/package.ts'
import { AVIF, JPEG, PNG, WEBP, WOFF2, manifestJson, zipOf, type Entry } from './helpers.ts'

async function reasonsOf(bytes: Buffer): Promise<string[]> {
  try {
    await readThemePackage(bytes)
  } catch (error) {
    if (error instanceof ThemeRejected) return error.reasons
    throw error
  }
  throw new Error('the package was accepted')
}
const base = { 'theme.json': manifestJson() }
const rejected = async (entries: Record<string, Entry>, match: RegExp) => {
  const reasons = await reasonsOf(await zipOf(entries))
  expect(reasons.join('\n')).toMatch(match)
}

describe('a valid package', () => {
  test('reads manifest defaults, CSS and every asset type', async () => {
    const pkg = await readThemePackage(
      await zipOf({
        'theme.json': manifestJson({
          fonts: { faces: [{ family: 'Brand', src: 'asset:fonts/brand.woff2' }] },
          background: { image: 'asset:img/bg.webp' },
        }),
        'style.css': '.a{background:url(asset:img/a.png)}',
        'assets/fonts/brand.woff2': WOFF2,
        'assets/img/bg.webp': WEBP,
        'assets/img/a.png': PNG,
        'assets/img/b.avif': AVIF,
        'assets/img/c.jpg': JPEG,
        'assets/img/d.jpeg': JPEG,
      }),
    )
    expect(pkg.manifest).toMatchObject({ id: 'seaside', version: '1.0.0' })
    expect(pkg.css).toBe('.a{background:url(asset:img/a.png)}')
    expect([...pkg.assets.keys()].sort()).toEqual([
      'fonts/brand.woff2',
      'img/a.png',
      'img/b.avif',
      'img/bg.webp',
      'img/c.jpg',
      'img/d.jpeg',
    ])
  })

  test('LICENSE and OFL.txt at the root are read, kept and exported', async () => {
    const pkg = await readThemePackage(
      await zipOf({ ...base, LICENSE: 'MIT\r\nCopyright © Me\n', 'OFL.txt': '\uFEFFSIL OFL é\n' }),
    )
    expect(pkg.licenses).toEqual({ LICENSE: 'MIT\r\nCopyright © Me\n', 'OFL.txt': 'SIL OFL é\n' })
    const exported = await JSZip.loadAsync(
      await buildThemePackage(pkg.manifest, pkg.css, pkg.assets, pkg.licenses),
    )
    expect(await exported.file('OFL.txt')!.async('string')).toBe('SIL OFL é\n')
    expect(await exported.file('LICENSE')!.async('string')).toBe('MIT\r\nCopyright © Me\n')
    expect(
      (await readThemePackage(await exported.generateAsync({ type: 'nodebuffer' }))).licenses,
    ).toEqual(pkg.licenses)
    expect((await readThemePackage(await zipOf(base))).licenses).toEqual({})
  })

  test('theme.json alone is a theme, and folder entries are tolerated', async () => {
    const pkg = await readThemePackage(await zipOf({ ...base, 'assets/': '' }))
    expect(pkg.css).toBe('')
    expect(pkg.assets.size).toBe(0)
  })

  test('export is deterministic and round-trips', async () => {
    const manifest = ThemeManifestSchema.parse(JSON.parse(manifestJson()))
    const assets = new Map([
      ['img/z.png', PNG],
      ['fonts/a.woff2', WOFF2],
    ])
    const first = await buildThemePackage(manifest, 'a{color:red}', assets)
    const second = await buildThemePackage(manifest, 'a{color:red}', new Map([...assets].reverse()))
    expect(first.equals(second)).toBe(true)
    const zip = await JSZip.loadAsync(first)
    expect(Object.keys(zip.files)).toEqual([
      'theme.json',
      'style.css',
      'assets/fonts/a.woff2',
      'assets/img/z.png',
    ])
    const back = await readThemePackage(first)
    expect(back.manifest).toEqual(manifest)
    expect(back.css).toBe('a{color:red}')
    expect([...back.assets.keys()]).toEqual(['fonts/a.woff2', 'img/z.png'])
    expect((await buildThemePackage(back.manifest, back.css, back.assets)).equals(first)).toBe(true)
  })

  test('a theme without CSS exports no style.css', async () => {
    const zip = await JSZip.loadAsync(
      await buildThemePackage(
        ThemeManifestSchema.parse({ format: 1, id: 'x', name: 'X' }),
        '',
        new Map(),
      ),
    )
    expect(Object.keys(zip.files)).toEqual(['theme.json'])
  })
})

describe('adversarial packages', () => {
  test('bytes that are not a zip (wrong magic)', async () => {
    expect((await reasonsOf(PNG)).join()).toMatch(/isn’t a zip/)
    expect((await reasonsOf(Buffer.from('PK\x05\x06' + '\0'.repeat(18), 'latin1'))).join()).toMatch(
      /isn’t a zip/,
    )
    expect((await reasonsOf(Buffer.alloc(0))).join()).toMatch(/isn’t a zip/)
  })

  test('a truncated zip', async () => {
    const whole = await zipOf(base)
    expect((await reasonsOf(whole.subarray(0, whole.length - 30))).join()).toMatch(
      /couldn’t be read/,
    )
  })

  test('an upload over 5 MB', async () => {
    expect((await reasonsOf(Buffer.alloc(MAX_UPLOAD_BYTES + 1, 1))).join()).toMatch(
      /larger than 5 MB/,
    )
  })

  test.each([
    ['dot-dot traversal', '../evil.css'],
    ['dot-dot traversal inside the layout', 'assets/img/../../../evil.png'],
    ['absolute path', '/etc/passwd'],
    ['drive letter', 'C:/evil.css'],
    ['backslash path', 'assets\\img\\a.png'],
    ['backslash traversal', '..\\evil.css'],
    ['dot segment', 'assets/./img/a.png'],
    ['double slash', 'assets//img/a.png'],
  ])('%s', async (_name, name) => {
    await rejected({ ...base, [name]: PNG }, /./)
  })

  test('traversal and absolute entries name the problem', async () => {
    await rejected({ ...base, '../evil.css': 'x' }, /path leaves the folder/)
    await rejected({ ...base, '/abs.css': 'x' }, /absolute path/)
    await rejected({ ...base, 'assets\\img\\a.png': PNG }, /backslash/)
  })

  test('symlink entries, in any allowed slot', async () => {
    await rejected(
      { ...base, 'assets/img/a.png': { data: '/etc/passwd', unixPermissions: 0o120777 } },
      /symbolic links/,
    )
    await rejected(
      { 'theme.json': { data: 'theme.json.real', unixPermissions: 0o120777 } },
      /symbolic links/,
    )
  })

  test('nested archives by name and by content', async () => {
    const inner = await zipOf({ a: 'b' })
    await rejected({ ...base, 'assets/img/inner.zip': inner }, /archives inside/)
    await rejected({ ...base, 'assets/img/a.png': inner }, /archives inside/)
    await rejected({ ...base, 'style.css': inner }, /archives inside/)
    await rejected(
      { ...base, 'assets/img/a.png': Buffer.from([0x1f, 0x8b, 8, 0, 0, 0]) },
      /archives inside/,
    )
  })

  test.each([
    ['png that is text', 'assets/img/a.png', Buffer.from('not a png')],
    ['png that is a jpeg', 'assets/img/a.png', JPEG],
    ['jpg that is a png', 'assets/img/a.jpg', PNG],
    ['webp without WEBP', 'assets/img/a.webp', Buffer.from('RIFF\0\0\0\0WAVEfmt ')],
    ['webp that is a png', 'assets/img/a.webp', PNG],
    ['avif without ftypavif', 'assets/img/a.avif', Buffer.from('\0\0\0\x1cftypheic....')],
    ['woff2 that is a woff', 'assets/fonts/a.woff2', Buffer.from('wOFF....')],
    ['woff2 that is html', 'assets/fonts/a.woff2', Buffer.from('<html></html>')],
    ['empty png', 'assets/img/a.png', Buffer.alloc(0)],
  ])('wrong magic bytes: %s', async (_name, name, bytes) => {
    await rejected({ ...base, [name]: bytes }, /isn’t really a/)
  })

  test.each([
    ['a stray top-level file', 'README.md'],
    ['a script', 'run.js'],
    ['an svg image', 'assets/img/a.svg'],
    ['an html file', 'assets/img/a.html'],
    ['a font in the image folder', 'assets/img/a.woff2'],
    ['an image in the font folder', 'assets/fonts/a.png'],
    ['a woff', 'assets/fonts/a.woff'],
    ['a deeper folder', 'assets/img/sub/a.png'],
    ['a file in assets itself', 'assets/a.png'],
    ['a hidden file', 'assets/img/.a.png'],
    ['a name that is too long', `assets/img/${'a'.repeat(90)}.png`],
    ['a theme.json in a subfolder', 'sub/theme.json'],
    ['an upper-case THEME.JSON', 'THEME.JSON'],
    ['a name with a space', 'assets/img/a b.png'],
  ])('layout: %s', async (_name, name) => {
    await rejected({ ...base, [name]: PNG }, /not part of a theme package/)
  })

  test('an odd folder entry', async () => {
    await rejected({ ...base, 'other/': '' }, /not part of a theme package/)
  })

  test('duplicate names that differ only in case', async () => {
    await rejected({ ...base, 'assets/img/a.png': PNG, 'assets/img/A.png': PNG }, /duplicate name/)
  })

  test('licence files are bounded text, and only those two names are allowed', async () => {
    await rejected(
      { ...base, 'OFL.txt': 'x'.repeat(64 * 1024 + 1) },
      /OFL\.txt: file too large|larger than the zip/,
    )
    await readThemePackage(await zipOf({ ...base, LICENSE: 'x'.repeat(64 * 1024) }))
    await rejected(
      { ...base, LICENSE: Buffer.from([0x4d, 0x49, 0xff, 0xfe, 0x54]) },
      /LICENSE isn’t valid UTF-8/,
    )
    await rejected({ ...base, 'OFL.txt': 'text\u0000more' }, /OFL\.txt isn’t plain text/)
    for (const name of [
      'LICENSE.md',
      'license',
      'COPYING',
      'README.txt',
      'assets/OFL.txt',
      'assets/img/OFL.txt',
      'sub/LICENSE',
    ])
      await rejected({ ...base, [name]: 'text' }, /not part of a theme package/)
  })

  test('more than 41 files', async () => {
    const entries: Record<string, Entry> = { ...base }
    for (let n = 0; n < 41; n += 1) entries[`assets/img/a${n}.png`] = PNG
    await rejected(entries, /more than 41 files/)
  })

  test('a zip bomb is refused by the compression ratio', async () => {
    await rejected(
      { ...base, 'assets/img/a.png': Buffer.concat([PNG, Buffer.alloc(7_000_000)]) },
      /suspiciously well/,
    )
    await rejected({ ...base, 'style.css': ' '.repeat(250_000) }, /suspiciously well/)
  })

  test('a file over its own cap', async () => {
    const big = Buffer.alloc(8 * 1024 * 1024 + 1)
    for (let i = 0; i < big.length; i += 4096) big[i] = (i / 4096) & 0xff
    PNG.copy(big)
    const reasons = await reasonsOf(
      await zipOf({ ...base, 'assets/img/a.png': big }, { compression: 'STORE' }),
    )
    expect(reasons.join()).toMatch(/file too large|larger than 5 MB/)
  })
})

describe('manifest and CSS in a package', () => {
  test('theme.json is required, valid JSON and valid against the schema', async () => {
    await rejected({ 'style.css': 'a{}' }, /theme.json is missing/)
    await rejected({ 'theme.json': '{nope' }, /isn’t valid JSON/)
    await rejected({ 'theme.json': JSON.stringify({ format: 1, id: 'x' }) }, /theme.json: name/)
    await rejected({ 'theme.json': manifestJson({ surprise: true }) }, /theme.json/)
    await rejected({ 'theme.json': manifestJson({ id: '../x' }) }, /theme.json: id/)
    await rejected(
      { 'theme.json': manifestJson({ colors: { light: { ground: 'url(asset:img/a.png)' } } }) },
      /theme.json/,
    )
  })

  test('a newer format says so in plain words', async () => {
    await rejected({ 'theme.json': manifestJson({ format: 2 }) }, /made for a newer Score/)
    await rejected(
      { 'theme.json': JSON.stringify({ format: 9, id: 'x', name: 'X', future: {} }) },
      /newer Score/,
    )
  })

  test.each(['score', 'paper', 'night', 'dense'])('the built-in id %s is refused', async (id) => {
    await rejected({ 'theme.json': manifestJson({ id }) }, /belongs to a built-in theme/)
  })

  test('every asset: the manifest or the CSS uses must be in the package', async () => {
    await rejected(
      { 'theme.json': manifestJson({ background: { image: 'asset:img/bg.webp' } }) },
      /asset:img\/bg.webp is used but not in the package/,
    )
    await rejected(
      { ...base, 'style.css': '.a{background:url(asset:img/gone.png)}' },
      /asset:img\/gone.png is used but not in the package/,
    )
    await rejected(
      {
        'theme.json': manifestJson({
          views: { user: { background: { image: 'asset:img/u.png' } } },
        }),
      },
      /asset:img\/u.png is used/,
    )
  })

  test('CSS the server refuses rejects the package, with the file named', async () => {
    await rejected(
      { ...base, 'style.css': 'a::before{\\63 ontent:"x"}' },
      /style.css: the content property/,
    )
    await rejected({ ...base, 'style.css': '@import "x.css";' }, /style.css: @import/)
  })

  test('style.css must be UTF-8 text and at most 256 KB', async () => {
    await rejected({ ...base, 'style.css': Buffer.from([0x61, 0xff, 0xfe, 0x7b]) }, /valid UTF-8/)
    const noisy = Buffer.alloc(262_145)
    for (let i = 0; i < noisy.length; i += 1) noisy[i] = 97 + ((i * 7919) % 26)
    await rejected({ ...base, 'style.css': noisy }, /file too large|larger than 256 KB/)
  })

  test('every reason is reported, not only the first', async () => {
    const reasons = await reasonsOf(
      await zipOf({
        'theme.json': manifestJson({ id: 'score' }),
        'style.css': '@import "x";',
        'assets/img/a.png': Buffer.from('nope'),
      }),
    )
    expect(reasons.length).toBeGreaterThanOrEqual(3)
  })
})
