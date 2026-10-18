// One accept/reject corpus for theme packages. The browser reader (apps/web) and the server reader (apps/server) both
// run every case, so a package one of them takes and the other refuses fails a test on one side or the other. Packages
// are built with `buildZip`, so headers, flags and extra fields can be made to disagree on purpose.
// (Re-gate finding 10.) Not in the corpus: the manifest id being a built-in's (the import dialog treats that as a
// naming conflict, the server as a conflict too) and CSS content (the browser sanitises, the server refuses; both
// stages are covered by their own tests).

import {
  buildZip,
  unicodeCommentExtra,
  unicodePathExtra,
  type ZipSpec,
} from './theme-package-zip.ts'

export interface CorpusCase {
  name: string
  bytes: Uint8Array
  accept: boolean
  /** For accepted cases: what both readers must report. */
  expect?: { id: string; assets: string[]; licenses: string[]; css: string }
}

const text = (value: string) => new TextEncoder().encode(value)
const bytesOf = (...values: number[]) => Uint8Array.from(values)
const ascii = (value: string) => Uint8Array.from([...value].map((c) => c.charCodeAt(0)))
const concat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]))

const PNG = concat(bytesOf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), text('body'))
const WOFF2 = concat(ascii('wOF2'), text('font'))
const JPEG = bytesOf(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3)
const WEBP = concat(ascii('RIFF'), bytesOf(1, 0, 0, 0), ascii('WEBPVP8 '))
const AVIF = concat(bytesOf(0, 0, 0, 0x1c), ascii('ftypavif'), ascii('....'))

export const manifest = (extra: object = {}, id = 'seaside') =>
  JSON.stringify({ format: 1, id, name: 'Seaside', ...extra })
const base: ZipSpec = { name: 'theme.json', data: manifest() }

const ok = (
  name: string,
  entries: ZipSpec[],
  expect: Partial<NonNullable<CorpusCase['expect']>> = {},
): CorpusCase => ({
  name,
  bytes: buildZip(entries),
  accept: true,
  expect: { id: 'seaside', assets: [], licenses: [], css: '', ...expect },
})
const bad = (name: string, entries: ZipSpec[] | Uint8Array): CorpusCase => ({
  name,
  bytes: entries instanceof Uint8Array ? entries : buildZip(entries),
  accept: false,
})

const withBackground = manifest({ background: { image: 'asset:img/a.png', fit: 'cover', dim: 0 } })
const many = (count: number): ZipSpec[] => [
  base,
  ...Array.from({ length: count - 1 }, (_, i) => ({ name: `assets/img/p${i}.png`, data: PNG })),
]

export const corpus: CorpusCase[] = [
  // ---- accepted
  ok('theme.json alone', [base]),
  ok(
    'every asset type, both licences, CSS and folder entries',
    [
      { name: 'theme.json', data: withBackground },
      { name: 'style.css', data: '.x{color:red}' },
      { name: 'LICENSE', data: 'MIT' },
      { name: 'OFL.txt', data: 'SIL Open Font License 1.1' },
      { name: 'assets/', data: '' },
      { name: 'assets/fonts/', data: '' },
      { name: 'assets/img/', data: '' },
      { name: 'assets/fonts/f.woff2', data: WOFF2 },
      { name: 'assets/img/a.png', data: PNG },
      { name: 'assets/img/b.jpg', data: JPEG },
      { name: 'assets/img/c.jpeg', data: JPEG },
      { name: 'assets/img/d.webp', data: WEBP },
      { name: 'assets/img/e.avif', data: AVIF },
    ],
    {
      assets: ['fonts/f.woff2', 'img/a.png', 'img/b.jpg', 'img/c.jpeg', 'img/d.webp', 'img/e.avif'],
      licenses: ['LICENSE', 'OFL.txt'],
      css: '.x{color:red}',
    },
  ),
  ok('a licence file with a byte order mark', [base, { name: 'LICENSE', data: '﻿MIT' }], {
    licenses: ['LICENSE'],
  }),
  ok('an extra field that renames nothing (Unicode comment)', [
    { ...base, centralExtra: unicodeCommentExtra('note'), localExtra: unicodeCommentExtra('note') },
  ]),
  ok('exactly 41 files', many(41), {
    assets: Array.from({ length: 40 }, (_, i) => `img/p${i}.png`).sort(),
  }),

  // ---- names and layout
  bad('42 files', many(42)),
  bad('a file outside the layout', [base, { name: 'notes.txt', data: 'hi' }]),
  bad('a folder outside the layout', [base, { name: 'evil/', data: '' }]),
  bad('traversal', [base, { name: 'assets/img/../../x.png', data: PNG }]),
  bad('an absolute path', [base, { name: '/etc/passwd', data: 'x' }]),
  bad('a backslash path', [base, { name: 'assets\\img\\a.png', data: PNG }]),
  bad('a nested archive by name', [base, { name: 'assets/img/x.zip', data: PNG }]),
  bad('names that differ only in case', [base, { name: 'Theme.json', data: manifest() }]),
  bad('the same name twice', [base, base]),
  bad('a PNG under assets/fonts', [base, { name: 'assets/fonts/a.png', data: PNG }]),
  bad('a woff2 under assets/img', [base, { name: 'assets/img/a.woff2', data: WOFF2 }]),
  bad('a font in a place the layout does not know', [
    base,
    { name: 'assets/f.woff2', data: WOFF2 },
  ]),
  bad('an asset name with odd characters', [base, { name: 'assets/img/a b.png', data: PNG }]),

  // ---- bytes
  bad('fake PNG bytes', [base, { name: 'assets/img/a.png', data: text('not a png at all') }]),
  bad('a woff2 that is not one', [base, { name: 'assets/fonts/f.woff2', data: PNG }]),
  bad('an archive posing as an image', [
    base,
    { name: 'assets/img/a.avif', data: concat(ascii('PK\x03\x04'), ascii('ftypavif')) },
  ]),
  bad('a NUL byte in a licence', [base, { name: 'LICENSE', data: 'MIT\0hidden' }]),
  bad('invalid UTF-8 in a licence', [base, { name: 'OFL.txt', data: bytesOf(0xff, 0xfe, 0x41) }]),
  bad('a licence over 64 KB', [base, { name: 'LICENSE', data: 'x'.repeat(64 * 1024 + 1) }]),
  bad('a stylesheet that is not UTF-8', [
    base,
    { name: 'style.css', data: bytesOf(0xff, 0xfe, 0x41) },
  ]),
  bad('a manifest over 128 KB', [
    { name: 'theme.json', data: manifest({ description: 'x'.repeat(130_000) }) },
  ]),

  // ---- manifest
  bad('no theme.json', [{ name: 'style.css', data: '.x{color:red}' }]),
  bad('theme.json that is not JSON', [{ name: 'theme.json', data: '{nope' }]),
  bad('theme.json that fails the schema', [
    { name: 'theme.json', data: '{"format":1,"id":"A B"}' },
  ]),
  bad('a newer format', [{ name: 'theme.json', data: manifest({ format: 99 }) }]),
  bad('an asset the manifest names but the package lacks', [
    { name: 'theme.json', data: withBackground },
  ]),

  // ---- zip structure
  bad('a symlink entry', [base, { name: 'assets/img/a.png', data: 'target', unixMode: 0o120777 }]),
  bad('an encrypted entry', [{ ...base, flags: 0x801, localFlags: 0x801 }]),
  bad('local and central names that disagree', [
    { ...base, localName: 'style.css' },
    { name: 'style.css', data: '.x{color:red}', localName: 'theme.json' },
  ]),
  bad('local and central sizes that disagree', [{ ...base, localSize: 3 }]),
  bad('a different method in the local header', [{ ...base, localMethod: 8 }]),
  bad('a name overridden by a Unicode path field, in both headers', [
    {
      name: 'theme.json',
      data: manifest(),
      centralExtra: unicodePathExtra('theme.json', 'LICENSE'),
      localExtra: unicodePathExtra('theme.json', 'LICENSE'),
    },
    {
      name: 'OFL.txt',
      data: manifest({}, 'other-theme'),
      centralExtra: unicodePathExtra('OFL.txt', 'theme.json'),
      localExtra: unicodePathExtra('OFL.txt', 'theme.json'),
    },
  ]),
  bad('a Unicode path field in the local header only', [
    { ...base, localExtra: unicodePathExtra('theme.json', 'theme.json') },
  ]),
  bad('a Unicode path field in the central header only', [
    { ...base, centralExtra: unicodePathExtra('theme.json', 'theme.json') },
  ]),
  bad('an extra field that runs past its header', [
    { ...base, centralExtra: bytesOf(0x01, 0x00, 0xff, 0x00, 1) },
  ]),
  bad('not a zip', text('this is not a zip file')),
  bad('a truncated zip', buildZip([base]).subarray(0, 40)),
]
