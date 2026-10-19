import { expect, test } from 'vitest'
import { PACK_IMAGE_MAX_BYTES, sniffPackImage } from '../../src/packs/sniff.ts'
import {
  anmfBody,
  apngImage,
  gifImage,
  jpegImage,
  padTo,
  pngChunk,
  pngImage,
  riffOf,
  vp8Of,
  vp8lOf,
  vp8xBody,
  webpImage,
} from '../helpers/pack-images.ts'

test('PNG, APNG, GIF and WebP (lossy, lossless, extended, animated) are read from the bytes', () => {
  expect(sniffPackImage(pngImage(64, 80), 'a.png')).toEqual({
    ok: true,
    ext: 'png',
    width: 64,
    height: 80,
  })
  expect(sniffPackImage(apngImage(128, 128), 'a.png')).toEqual({
    ok: true,
    ext: 'png',
    width: 128,
    height: 128,
  })
  expect(sniffPackImage(gifImage(200, 100, 3), 'A.GIF')).toEqual({
    ok: true,
    ext: 'gif',
    width: 200,
    height: 100,
  })
  for (const kind of ['VP8 ', 'VP8L', 'VP8X'] as const)
    expect(sniffPackImage(webpImage(640, 480, kind), 'a.webp'), kind).toEqual({
      ok: true,
      ext: 'webp',
      width: 640,
      height: 480,
    })
  // Animation is what a pack is made of.
  expect(
    sniffPackImage(webpImage(256, 256, 'VP8X', { animated: true }), 'idle.webp'),
  ).toMatchObject({ ok: true })
})

test('the limits are inclusive: 64 and 2048 pass, 63 and 2049 do not, on either side', () => {
  expect(sniffPackImage(pngImage(64, 64), 'a.png').ok).toBe(true)
  expect(sniffPackImage(webpImage(2048, 2048), 'a.webp').ok).toBe(true)
  for (const [w, h] of [
    [63, 100],
    [100, 63],
    [2049, 100],
    [100, 2049],
  ] as const) {
    const result = sniffPackImage(gifImage(w, h), 'a.gif')
    expect(result, `${w}x${h}`).toMatchObject({ ok: false })
    expect(JSON.stringify(result)).toContain('between 64 and 2048')
  }
})

test('32 MB is the most one image may be', () => {
  const exactly = padTo(pngImage(64, 64), PACK_IMAGE_MAX_BYTES)
  expect(sniffPackImage(exactly, 'a.png').ok).toBe(true)
  expect(sniffPackImage(padTo(pngImage(64, 64), PACK_IMAGE_MAX_BYTES + 1), 'a.png')).toMatchObject({
    ok: false,
    reasons: [expect.stringContaining('32 MB')],
  })
})

test('the extension must agree with the bytes, and a missing or other one is refused', () => {
  expect(sniffPackImage(pngImage(64, 64), 'a.gif')).toMatchObject({ ok: false })
  expect(sniffPackImage(gifImage(64, 64), 'a.png')).toMatchObject({ ok: false })
  expect(sniffPackImage(webpImage(64, 64), 'a.png')).toMatchObject({ ok: false })
  expect(sniffPackImage(pngImage(64, 64), 'a')).toMatchObject({ ok: false })
  expect(sniffPackImage(pngImage(64, 64), 'a.jpg')).toMatchObject({ ok: false })
})

test('JPEG, SVG, text and empty files are refused, whatever they are called', () => {
  expect(sniffPackImage(jpegImage(100, 100), 'a.jpg')).toMatchObject({
    ok: false,
    reasons: [expect.stringContaining('PNG, GIF or WebP')],
  })
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><script>1</script></svg>',
  )
  expect(sniffPackImage(svg, 'a.png')).toMatchObject({
    ok: false,
    reasons: [expect.stringContaining('SVG')],
  })
  expect(sniffPackImage(svg, 'a.svg')).toMatchObject({
    ok: false,
    reasons: [expect.stringContaining('SVG')],
  })
  expect(sniffPackImage(Buffer.from('hello'), 'a.png')).toMatchObject({ ok: false })
  expect(sniffPackImage(Buffer.alloc(0), 'a.png')).toMatchObject({
    ok: false,
    reasons: [expect.stringContaining('empty')],
  })
})

test('truncated and damaged headers are refused, not guessed at', () => {
  expect(sniffPackImage(pngImage(64, 64).subarray(0, 20), 'a.png')).toMatchObject({ ok: false })
  expect(sniffPackImage(gifImage(64, 64).subarray(0, 8), 'a.gif')).toMatchObject({ ok: false })
  expect(sniffPackImage(Buffer.from('GIF89a'), 'a.gif')).toMatchObject({ ok: false })
  expect(sniffPackImage(webpImage(64, 64).subarray(0, 24), 'a.webp')).toMatchObject({ ok: false })
  const lossless = webpImage(64, 64)
  lossless[20] = 0
  expect(sniffPackImage(lossless, 'a.webp')).toMatchObject({ ok: false })
})

// A header that says "64 × 64" is not an image: the structure each format needs has to be there, in bounds, to the end.
const damaged = (bytes: Buffer, name: string) =>
  expect(sniffPackImage(bytes, name), name).toMatchObject({ ok: false })

test('PNG: a complete header with the image data missing, or a broken chunk structure, is refused', () => {
  const png = pngImage(64, 64)
  damaged(png.subarray(0, 33), 'a.png') // IHDR and nothing after
  const idat = png.indexOf('IDAT') - 4
  damaged(png.subarray(0, idat), 'a.png') // no IDAT
  damaged(png.subarray(0, png.length - 12), 'a.png') // no IEND
  damaged(png.subarray(0, png.length - 5), 'a.png') // IEND cut short
  damaged(Buffer.concat([png, Buffer.from('trailing')]), 'a.png') // data after IEND
  const long = Buffer.from(png)
  long.writeUInt32BE(0x7fffffff, idat) // an IDAT longer than the file
  damaged(long, 'a.png')
  // IHDR must come first and be 13 bytes.
  const second = Buffer.concat([
    png.subarray(0, 8),
    pngChunk('tEXt', Buffer.from('a\0b')),
    png.subarray(8),
  ])
  damaged(second, 'a.png')
  // An animation declares itself before the first IDAT, not after.
  const late = Buffer.concat([
    png.subarray(0, png.length - 12),
    pngChunk('acTL', Buffer.alloc(8)),
    png.subarray(png.length - 12),
  ])
  damaged(late, 'a.png')
  expect(sniffPackImage(apngImage(64, 64), 'a.png').ok).toBe(true)
})

test('GIF: a complete header with no frame, no frame data or no trailer is refused', () => {
  const gif = gifImage(64, 64, 2)
  damaged(gif.subarray(0, 13), 'a.gif') // header and screen only
  damaged(gif.subarray(0, 14), 'a.gif')
  damaged(gif.subarray(0, gif.length - 1), 'a.gif') // no trailer
  damaged(gif.subarray(0, gif.length - 6), 'a.gif') // cut in the image data
  damaged(Buffer.concat([gif, Buffer.from([0])]), 'a.gif') // data after the trailer
  const noData = Buffer.concat([
    gif.subarray(0, 13),
    Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 0, 0x3b]),
  ])
  damaged(noData, 'a.gif') // a frame whose image data is empty
  damaged(
    Buffer.concat([gif.subarray(0, 13), Buffer.from([0x21, 0xf9, 4, 0, 0, 0, 0, 0, 0x3b])]),
    'a.gif',
  ) // only an extension
  damaged(Buffer.concat([gif.subarray(0, 13), Buffer.from([0x99, 0x3b])]), 'a.gif') // an unknown block
  // A global colour table is walked, not mistaken for blocks.
  const table = Buffer.from(gifImage(64, 64))
  table[10] = 0x80
  damaged(table, 'a.gif') // says there is a table that isn't there
  const withTable = Buffer.concat([table.subarray(0, 13), Buffer.alloc(6), table.subarray(13)])
  expect(sniffPackImage(withTable, 'a.gif').ok).toBe(true)
})

test('WebP: the RIFF size must match the file, and the chunks must hold the image data', () => {
  const lossless = webpImage(64, 64)
  const bigger = Buffer.from(lossless)
  bigger.writeUInt32LE(lossless.length, 4) // says more than there is
  damaged(bigger, 'a.webp')
  const smaller = Buffer.from(lossless)
  smaller.writeUInt32LE(lossless.length - 12, 4)
  damaged(smaller, 'a.webp')
  damaged(Buffer.concat([lossless, Buffer.from([0, 0])]), 'a.webp') // data after the RIFF
  // A chunk longer than the file.
  const long = Buffer.from(lossless)
  long.writeUInt32LE(0x7fffff00, 16)
  damaged(long, 'a.webp')
  // A VP8 / VP8L chunk with only the start of its header.
  damaged(riffOf([['VP8L', Buffer.from([0x2f, 63, 0xc0, 0x0f])]]), 'a.webp')
  damaged(
    riffOf([['VP8 ', Buffer.from([0x10, 0, 0, 0x9d, 0x01, 0x2a, 64, 0, 64, 0])]]).subarray(0, 28),
    'a.webp',
  )
  // Extended: only the VP8X header, or only an ALPH, is not an image.
  damaged(riffOf([['VP8X', vp8xBody(64, 64)]]), 'a.webp')
  damaged(
    riffOf([
      ['VP8X', vp8xBody(64, 64)],
      ['ALPH', Buffer.alloc(8)],
    ]),
    'a.webp',
  )
  damaged(
    riffOf([
      ['VP8X', vp8xBody(64, 64)],
      ['EXIF', Buffer.alloc(8)],
    ]),
    'a.webp',
  )
  // An unknown first chunk.
  damaged(riffOf([['JUNK', Buffer.alloc(30)]]), 'a.webp')
  // Animated: ANIM and at least one ANMF that holds VP8 / VP8L data.
  damaged(
    riffOf([
      ['VP8X', vp8xBody(64, 64, 0x02)],
      ['ANIM', Buffer.alloc(6)],
    ]),
    'a.webp',
  ) // no frame
  damaged(
    riffOf([
      ['VP8X', vp8xBody(64, 64, 0x02)],
      ['ANMF', anmfBody(64, 64, [['VP8L', vp8lOf(64, 64)]])],
    ]),
    'a.webp',
  ) // no ANIM
  damaged(
    riffOf([
      ['VP8X', vp8xBody(64, 64, 0x02)],
      ['ANIM', Buffer.alloc(6)],
      ['ANMF', anmfBody(64, 64, [['ALPH', Buffer.alloc(8)]])],
    ]),
    'a.webp',
  ) // a frame with no image data
  damaged(
    riffOf([
      ['VP8X', vp8xBody(64, 64, 0x02)],
      ['ANIM', Buffer.alloc(6)],
      ['ANMF', Buffer.alloc(10)],
    ]),
    'a.webp',
  ) // a frame shorter than its header
  damaged(
    riffOf([
      ['VP8X', vp8xBody(64, 64, 0x02)],
      ['ANIM', Buffer.alloc(6)],
      ['VP8L', vp8lOf(64, 64)],
    ]),
    'a.webp',
  ) // flagged animated, but a still inside
  damaged(
    riffOf([
      ['VP8X', vp8xBody(64, 64)],
      ['ANIM', Buffer.alloc(6)],
      ['ANMF', anmfBody(64, 64, [['VP8L', vp8lOf(64, 64)]])],
    ]),
    'a.webp',
  ) // frames without the flag
  // Still fine: ALPH before a lossy image, and chunks we don't use around the image.
  expect(
    sniffPackImage(
      riffOf([
        ['VP8X', vp8xBody(64, 64, 0x10)],
        ['ICCP', Buffer.alloc(6)],
        ['ALPH', Buffer.alloc(8)],
        ['VP8 ', vp8Of(64, 64)],
        ['EXIF', Buffer.alloc(4)],
      ]),
      'a.webp',
    ).ok,
  ).toBe(true)
})

test('a WebP whose header disagrees with its size says where it breaks off, in numbers (owner, 2026-10-19)', () => {
  const whole = webpImage(64, 64, 'VP8X', { animated: true })
  // Stray bytes after the frames the header covers, as an exporter that stopped early leaves them.
  const broken = Buffer.concat([whole, Buffer.alloc(1024 * 1024)])
  expect(sniffPackImage(broken, 'idle.webp')).toEqual({
    ok: false,
    reasons: [
      expect.stringMatching(
        /^This WebP breaks off: its header says it ends at 0\.0 MB, but the file is 1\.0 MB, so only its first 2 frames would play\. Export it again\.$/,
      ),
    ],
  })
  const short = whole.subarray(0, whole.length - 10)
  expect(sniffPackImage(short, 'idle.webp')).toMatchObject({
    ok: false,
    reasons: [expect.stringMatching(/^This WebP is cut short: .* Export it again\.$/)],
  })
})
