import { expect, test } from 'vitest'
import { PackRejected, readPack } from '../../src/packs/reader.ts'
import { parseFiles } from '../../src/media/multipart.ts'
import {
  apngImage,
  gifImage,
  jpegImage,
  multipartFiles,
  padTo,
  pngImage,
  webpImage,
  zipOf,
} from '../helpers/pack-images.ts'

const idle = webpImage(128, 128, 'VP8X', { animated: true })
const work = gifImage(128, 128, 4)
const think = apngImage(96, 96)
const file = (name: string, bytes: Buffer) => ({ name, bytes })
const rejection = (run: () => unknown): string[] => {
  try {
    run()
  } catch (error) {
    if (error instanceof PackRejected) return error.reasons
    throw error
  }
  throw new Error('expected the pack to be rejected')
}
const rejectionOf = async (files: { name: string; bytes: Buffer }[]) =>
  rejection(() => readPack(files))
const zipped = async (entries: Record<string, Buffer | string>, options = {}) => [
  file('pack.zip', await zipOf(entries, options)),
]

test('several files: activities in the pack, in the contract’s order, with the manifest', () => {
  const pack = readPack([
    file('work.gif', work),
    file('think.png', think),
    file('idle.webp', idle),
    file(
      'pet.json',
      Buffer.from(JSON.stringify({ name: 'Round', credits: 'made by me', floor: 0.1 })),
    ),
  ])
  expect(pack.files.map((f) => `${f.activity}.${f.ext}`)).toEqual([
    'idle.webp',
    'work.gif',
    'think.png',
  ])
  expect(pack.files[0]!.bytes.equals(idle)).toBe(true)
  expect(pack.manifest).toEqual({ name: 'Round', credits: 'made by me', floor: 0.1 })
  expect(pack.ignored).toEqual([])
})

test('a pack with only idle and no pet.json is a pack', () => {
  const pack = readPack([file('idle.gif', work)])
  expect(pack.files.map((f) => f.activity)).toEqual(['idle'])
  expect(pack.manifest).toEqual({})
})

test('a zip: files at the top level, or inside one top-level folder', async () => {
  for (const prefix of ['', 'luna/']) {
    const pack = readPack(
      await zipped({
        [`${prefix}idle.webp`]: idle,
        [`${prefix}work.gif`]: work,
        [`${prefix}pet.json`]: '{"name":"Zipped"}',
      }),
    )
    expect(pack.files.map((f) => f.activity)).toEqual(['idle', 'work'])
    expect(pack.files[1]!.bytes.equals(work)).toBe(true)
    expect(pack.manifest.name).toBe('Zipped')
    expect(pack.ignored).toEqual([])
  }
  // Folder entries of their own are not files and are not listed.
  const withFolder = readPack(await zipped({ 'luna/': '', 'luna/idle.webp': idle }))
  expect(withFolder.ignored).toEqual([])
})

test('junk is ignored and listed back: __MACOSX, .DS_Store, other files, nested files, nested archives', async () => {
  const pack = readPack(
    await zipped({
      'luna/': '',
      'luna/idle.webp': idle,
      'luna/.DS_Store': 'x',
      'luna/README.txt': 'hello',
      'luna/extra.zip': 'PK',
      'luna/old/idle.png': pngImage(64, 64),
      '__MACOSX/': '',
      '__MACOSX/luna/._idle.webp': 'x',
    }),
  )
  expect(pack.files.map((f) => f.activity)).toEqual(['idle'])
  expect(pack.ignored).toEqual([
    '__MACOSX/luna/._idle.webp',
    'luna/.DS_Store',
    'luna/README.txt',
    'luna/extra.zip',
    'luna/old/idle.png',
  ])
  // Several files in one request: other files are ignored the same way.
  const loose = readPack([
    file('idle.webp', idle),
    file('notes.txt', Buffer.from('x')),
    file('.DS_Store', Buffer.from('x')),
  ])
  expect(loose.ignored).toEqual(['.DS_Store', 'notes.txt'])
})

test('with files at the top level, files in folders are ignored; two folders hold nothing usable', async () => {
  const mixed = readPack(await zipped({ 'idle.webp': idle, 'other/work.gif': work }))
  expect(mixed.files.map((f) => f.activity)).toEqual(['idle'])
  expect(mixed.ignored).toEqual(['other/work.gif'])
  const two = await rejectionOf(await zipped({ 'a/idle.webp': idle, 'b/idle.webp': idle }))
  expect(two.join(' ')).toMatch(/idle/)
})

test('the pack folder is where the activity images and pet.json are: unrelated files at the root do not hide it', async () => {
  const pack = readPack(
    await zipped({
      'README.txt': 'hello',
      'cover.png': pngImage(64, 64),
      'pet/idle.webp': idle,
      'pet/work.gif': work,
      'pet/pet.json': '{"name":"In a folder"}',
      'pet/notes.txt': 'x',
      'other/readme.md': 'x',
    }),
  )
  expect(pack.files.map((f) => f.activity)).toEqual(['idle', 'work'])
  expect(pack.manifest.name).toBe('In a folder')
  expect(pack.ignored).toEqual(['README.txt', 'cover.png', 'other/readme.md', 'pet/notes.txt'])
  // Only pet.json in the folder still names it; the images at the root then win.
  const rootWins = readPack(
    await zipped({ 'idle.webp': idle, 'pet/idle.gif': work, 'pet/pet.json': '{}' }),
  )
  expect(rootWins.files).toEqual([expect.objectContaining({ activity: 'idle', ext: 'webp' })])
  expect(rootWins.ignored).toEqual(['pet/idle.gif', 'pet/pet.json'])
  // Two folders with pack files is still no pack; one without any is just junk.
  expect(
    (await rejectionOf(await zipped({ 'a/idle.webp': idle, 'b/work.gif': work }))).join(' '),
  ).toMatch(/idle/)
  const junkFolder = readPack(
    await zipped({ 'pet/idle.webp': idle, 'docs/guide.pdf': 'x', 'docs/notes.txt': 'x' }),
  )
  expect(junkFolder.files).toHaveLength(1)
  expect(junkFolder.ignored).toEqual(['docs/guide.pdf', 'docs/notes.txt'])
  // The same in a request of several files.
  const loose = readPack([file('luna/idle.webp', idle), file('notes.txt', Buffer.from('x'))])
  expect(loose.files).toHaveLength(1)
  expect(loose.ignored).toEqual(['notes.txt'])
})

test('every rejection of the contract: idle missing, unknown activity, other image types, duplicates', async () => {
  expect((await rejectionOf([file('work.gif', work)])).join(' ')).toMatch(
    /idle.*missing|missing.*idle/i,
  )
  expect(await rejectionOf([])).not.toEqual([])
  const unknown = await rejectionOf([file('idle.webp', idle), file('dance.webp', idle)])
  expect(unknown).toEqual([expect.stringContaining('dance.webp')])
  expect(unknown[0]).toMatch(/activity/)
  expect(
    (await rejectionOf([file('idle.webp', idle), file('walk.jpg', jpegImage(100, 100))]))[0],
  ).toMatch(/walk\.jpg/)
  expect((await rejectionOf([file('idle.webp', idle), file('idle.gif', work)])).join(' ')).toMatch(
    /idle.*one file|one file.*idle/i,
  )
  expect((await rejectionOf([file('idle.webp', idle), file('IDLE.WEBP', idle)])).join(' ')).toMatch(
    /idle/i,
  )
  // Case does not matter for names that are otherwise right.
  expect(readPack([file('Idle.WEBP', idle)]).files[0]).toMatchObject({
    activity: 'idle',
    ext: 'webp',
  })
})

test('a bad image names its file and says why: type, extension, size in pixels, bytes', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')
  const reasons = await rejectionOf([
    file('idle.png', svg),
    file('work.gif', pngImage(128, 128)),
    file('think.png', pngImage(32, 32)),
    file('needs.webp', webpImage(4000, 100)),
  ])
  expect(reasons).toHaveLength(4)
  expect(reasons[0]).toMatch(/^idle\.png: .*SVG/)
  expect(reasons[1]).toMatch(/^work\.gif: .*PNG/)
  expect(reasons[2]).toMatch(/^think\.png: .*between 64 and 2048/)
  expect(reasons[3]).toMatch(/^needs\.webp: .*between 64 and 2048/)
  const big = padTo(idle, 32 * 1024 * 1024 + 2)
  expect((await rejectionOf([file('idle.webp', big)]))[0]).toMatch(/^idle\.webp: .*32 MB/)
})

test('the pack as a whole is at most 256 MB and 24 files', async () => {
  const eight = padTo(idle, 32 * 1024 * 1024)
  const names = ['idle', 'work', 'think', 'needs', 'sleep', 'walk', 'stretch', 'coffee', 'read']
  expect(readPack(names.slice(0, 8).map((n) => file(`${n}.webp`, eight))).files).toHaveLength(8)
  expect((await rejectionOf(names.map((n) => file(`${n}.webp`, eight)))).join(' ')).toMatch(
    /256 MB/,
  )
  const many = Array.from({ length: 25 }, (_, index) => file(`note${index}.txt`, Buffer.from('x')))
  expect((await rejectionOf([file('idle.webp', idle), ...many])).join(' ')).toMatch(/24 files/)
  const entries: Record<string, string | Buffer> = { 'idle.webp': idle }
  for (let index = 0; index < 24; index += 1) entries[`note${index}.txt`] = 'x'
  expect((await rejectionOf(await zipped(entries))).join(' ')).toMatch(/24 files/)
  const edge: Record<string, string | Buffer> = { 'idle.webp': idle }
  for (let index = 0; index < 23; index += 1) edge[`note${index}.txt`] = 'x'
  expect(readPack(await zipped(edge)).ignored).toHaveLength(23)
})

test('pet.json: valid JSON in the contract’s shape, or a reason', async () => {
  const withManifest = (text: string | Buffer) => [
    file('idle.webp', idle),
    file('pet.json', Buffer.from(text)),
  ]
  expect(readPack(withManifest('{}')).manifest).toEqual({})
  expect(readPack(withManifest('{"name":"  Spaced  ","extra":1}')).manifest).toEqual({
    name: 'Spaced',
  })
  for (const bad of [
    '{not json',
    '[]',
    '{"floor":0.5}',
    '{"floor":"high"}',
    `{"name":"${'x'.repeat(81)}"}`,
    '{"credits":' + JSON.stringify('x'.repeat(501)) + '}',
  ]) {
    const reasons = await rejectionOf(withManifest(bad))
    expect(reasons[0], bad).toMatch(/^pet\.json: /)
  }
  expect((await rejectionOf(withManifest(Buffer.alloc(70 * 1024, 0x20))))[0]).toMatch(/pet\.json/)
  expect((await rejectionOf(withManifest(Buffer.from([0xff, 0xfe, 0x7b]))))[0]).toMatch(/pet\.json/)
})

test('a zip goes through the shared zip rules: not a zip, damaged, links, paths, ratio', async () => {
  expect((await rejectionOf([file('pack.zip', Buffer.from('hello'))])).join(' ')).toMatch(/zip/i)
  const good = await zipOf({ 'idle.webp': idle })
  expect(await rejectionOf([file('pack.zip', good.subarray(0, good.length - 10))])).not.toEqual([])
  expect(
    (
      await rejectionOf(
        await zipped({ 'idle.webp': idle, 'link.png': 'idle.webp' }, { links: ['link.png'] }),
      )
    ).join(' '),
  ).toMatch(/symbolic link/)
  expect(
    (await rejectionOf(await zipped({ 'idle.webp': idle, '../work.gif': work }))).join(' '),
  ).toMatch(/leaves the folder|unsafe/)
  expect(
    (await rejectionOf(await zipped({ 'idle.webp': idle, '/abs.png': work }))).join(' '),
  ).toMatch(/absolute/)
  // 4 MB of zeros after a real header compresses a thousandfold: a zip bomb, not a picture.
  const bomb = padTo(pngImage(64, 64), 4 * 1024 * 1024)
  expect((await rejectionOf(await zipped({ 'idle.png': bomb }))).join(' ')).toMatch(/zip bomb/)
  // The same with the zip lying about its sizes cannot unpack more than it declared.
  const lying = Buffer.from(await zipOf({ 'idle.webp': idle }))
  const header = lying.indexOf(Buffer.from('PK\x01\x02', 'latin1'))
  lying.writeUInt32LE(5, header + 24)
  expect(await rejectionOf([file('pack.zip', lying)])).not.toEqual([])
})

test('a zip comes alone: with another file, or with a second zip, it is refused', async () => {
  const [zip] = await zipped({ 'idle.webp': idle })
  expect((await rejectionOf([zip!, file('work.gif', work)])).join(' ')).toMatch(/one zip|either/i)
  expect((await rejectionOf([zip!, zip!])).join(' ')).toMatch(/one zip|either/i)
})

test('a duplicate file name is refused, and a name carrying its one folder is read like a zip’s', async () => {
  expect((await rejectionOf([file('idle.webp', idle), file('idle.webp', idle)])).join(' ')).toMatch(
    /idle\.webp/,
  )
  expect(readPack([file('luna/idle.webp', idle)]).files).toHaveLength(1)
})

test('parseFiles reads every file part, whatever its field name, and refuses a body with none or too many', () => {
  const body = multipartFiles([file('idle.webp', idle), file('work.gif', work)])
  const parts = parseFiles(body.payload, body.headers['content-type'], 40)
  expect(parts.map((part) => part.filename)).toEqual(['idle.webp', 'work.gif'])
  expect(parts[1]!.bytes.equals(work)).toBe(true)
  expect(() =>
    parseFiles(Buffer.from('--x--\r\n'), 'multipart/form-data; boundary=x', 40),
  ).toThrow()
  expect(() => parseFiles(body.payload, body.headers['content-type'], 1)).toThrow()
  expect(() => parseFiles(body.payload, 'multipart/form-data', 40)).toThrow()
})
