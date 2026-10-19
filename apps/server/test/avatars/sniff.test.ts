import { expect, test } from 'vitest'
import { AVATAR_MAX_BYTES, sniffAvatar } from '../../src/avatars/sniff.ts'
import { jpegImage, pngChunk, pngImage, webpImage } from '../helpers/avatar-images.ts'

test('PNG, JPEG (baseline and progressive) and WebP (lossy, lossless, extended) are read from the bytes', () => {
  expect(sniffAvatar(pngImage(64, 48), 'a.png')).toEqual({
    ok: true,
    ext: 'png',
    width: 64,
    height: 48,
  })
  expect(sniffAvatar(jpegImage(300, 200), 'a.jpg')).toEqual({
    ok: true,
    ext: 'jpg',
    width: 300,
    height: 200,
  })
  expect(sniffAvatar(jpegImage(300, 200, 0xc2), 'a.JPEG')).toEqual({
    ok: true,
    ext: 'jpg',
    width: 300,
    height: 200,
  })
  for (const kind of ['VP8 ', 'VP8L', 'VP8X'] as const)
    expect(sniffAvatar(webpImage(640, 480, kind), 'a.webp'), kind).toEqual({
      ok: true,
      ext: 'webp',
      width: 640,
      height: 480,
    })
})

test('the limits are inclusive: 32 and 2048 pass, 31 and 2049 do not, on either side', () => {
  expect(sniffAvatar(pngImage(32, 32), 'a.png').ok).toBe(true)
  expect(sniffAvatar(webpImage(2048, 2048), 'a.webp').ok).toBe(true)
  for (const [w, h] of [
    [31, 64],
    [64, 31],
    [2049, 64],
    [64, 2049],
  ] as const) {
    const result = sniffAvatar(webpImage(w, h), 'a.webp')
    expect(result, `${w}x${h}`).toMatchObject({ ok: false })
    expect(JSON.stringify(result)).toContain('between 32 and 2048')
  }
})

test('more than 2 MB is refused with a reason, however small its header says it is', () => {
  const big = Buffer.concat([webpImage(64, 64), Buffer.alloc(AVATAR_MAX_BYTES)])
  expect(sniffAvatar(big, 'a.webp')).toMatchObject({
    ok: false,
    reasons: [expect.stringContaining('2 MB')],
  })
  const png = pngImage(64, 64)
  const exactly = Buffer.concat([png, Buffer.alloc(AVATAR_MAX_BYTES - png.length)])
  expect(sniffAvatar(exactly, 'a.png').ok).toBe(true)
  expect(sniffAvatar(Buffer.concat([exactly, Buffer.alloc(1)]), 'a.png').ok).toBe(false)
})

test('the extension must agree with the bytes, and a missing or unknown one is refused', () => {
  expect(sniffAvatar(pngImage(64, 64), 'a.jpg')).toMatchObject({ ok: false })
  expect(sniffAvatar(jpegImage(64, 64), 'a.png')).toMatchObject({ ok: false })
  expect(sniffAvatar(webpImage(64, 64), 'a.png')).toMatchObject({ ok: false })
  expect(sniffAvatar(pngImage(64, 64), 'picture')).toMatchObject({ ok: false })
  expect(sniffAvatar(pngImage(64, 64), 'a.gif')).toMatchObject({ ok: false })
})

test('SVG, GIF, text and empty files are refused, whatever they are called', () => {
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><script>1</script></svg>',
  )
  expect(sniffAvatar(svg, 'a.png')).toMatchObject({
    ok: false,
    reasons: [expect.stringContaining('SVG')],
  })
  expect(sniffAvatar(svg, 'a.svg')).toMatchObject({
    ok: false,
    reasons: [expect.stringContaining('SVG')],
  })
  expect(sniffAvatar(Buffer.from('<?xml version="1.0"?><svg/>'), 'a.webp')).toMatchObject({
    ok: false,
  })
  expect(sniffAvatar(Buffer.from('GIF89a\x40\x00\x40\x00'), 'a.gif')).toMatchObject({ ok: false })
  expect(sniffAvatar(Buffer.from('hello'), 'a.png')).toMatchObject({ ok: false })
  expect(sniffAvatar(Buffer.alloc(0), 'a.png')).toMatchObject({ ok: false })
})

test('animated PNG and animated WebP are refused', () => {
  const actl = pngChunk('acTL', Buffer.from([0, 0, 0, 2, 0, 0, 0, 0]))
  expect(sniffAvatar(pngImage(64, 64, [actl]), 'a.png')).toMatchObject({
    ok: false,
    reasons: [expect.stringContaining('Animated')],
  })
  expect(sniffAvatar(webpImage(64, 64, 'VP8X', { animated: true }), 'a.webp')).toMatchObject({
    ok: false,
    reasons: [expect.stringContaining('Animated')],
  })
})

test('truncated and damaged headers are refused, not guessed at', () => {
  expect(sniffAvatar(pngImage(64, 64).subarray(0, 20), 'a.png')).toMatchObject({ ok: false })
  expect(sniffAvatar(jpegImage(64, 64).subarray(0, 10), 'a.jpg')).toMatchObject({ ok: false })
  expect(sniffAvatar(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff]), 'a.jpg')).toMatchObject({
    ok: false,
  })
  expect(sniffAvatar(webpImage(64, 64).subarray(0, 24), 'a.webp')).toMatchObject({ ok: false })
  const lossless = webpImage(64, 64)
  lossless[20] = 0
  expect(sniffAvatar(lossless, 'a.webp')).toMatchObject({ ok: false })
  // An unsupported JPEG process (SOF3, lossless) is named, not read as a size.
  expect(sniffAvatar(jpegImage(64, 64, 0xc3), 'a.jpg')).toMatchObject({ ok: false })
})
