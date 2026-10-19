import { expect, test } from 'vitest'
import { PACK_IMAGE_MAX_BYTES, sniffPackImage } from '../../src/packs/sniff.ts'
import { apngImage, gifImage, jpegImage, pngImage, webpImage } from '../helpers/pack-images.ts'

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

test('8 MB is the most one image may be', () => {
  const png = pngImage(64, 64)
  const exactly = Buffer.concat([png, Buffer.alloc(PACK_IMAGE_MAX_BYTES - png.length)])
  expect(sniffPackImage(exactly, 'a.png').ok).toBe(true)
  expect(sniffPackImage(Buffer.concat([exactly, Buffer.alloc(1)]), 'a.png')).toMatchObject({
    ok: false,
    reasons: [expect.stringContaining('8 MB')],
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
