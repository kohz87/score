import { describe, expect, test } from 'vitest'
import {
  altFromName,
  chipLabel,
  collapseDataUris,
  dataUriBytes,
  ImageError,
  MAX_IMAGE_BYTES,
  prepareImage,
  sniffImageType,
  type ImageSession,
  type ImageType,
} from './knowledge-images.ts'

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const fileOf = (head: number[], name: string, size = 64) => {
  const bytes = new Uint8Array(size)
  bytes.set(head)
  return new File([bytes], name)
}
const png = (name = 'shot.png') => fileOf(PNG_HEAD, name)

type Encode = (w: number, h: number, type: ImageType, quality: number) => Blob | null
function session(width: number, height: number, encode: Encode, alpha = false) {
  const calls: Array<{ w: number; h: number; type: ImageType; quality: number }> = []
  const fake: ImageSession = {
    width,
    height,
    hasAlpha: async () => alpha,
    encode: async (w, h, type, quality) => {
      calls.push({ w, h, type, quality })
      return encode(w, h, type, quality)
    },
    close: () => undefined,
  }
  return { open: async () => fake, calls }
}
const blob = (size: number, type: string) => new Blob([new Uint8Array(size)], { type })

describe('type check', () => {
  test('magic numbers decide; SVG and unknown files are not images', () => {
    expect(sniffImageType(new Uint8Array(PNG_HEAD))).toBe('image/png')
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImageType(new TextEncoder().encode('GIF89a'))).toBe('image/gif')
    expect(sniffImageType(new TextEncoder().encode('RIFF\0\0\0\0WEBP'))).toBe('image/webp')
    expect(sniffImageType(new TextEncoder().encode('<svg xmlns='))).toBeNull()
    expect(sniffImageType(new TextEncoder().encode('<?xml version'))).toBeNull()
  })

  test('an SVG file, even one named .png, is refused before anything is decoded', async () => {
    const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'logo.png', {
      type: 'image/png',
    })
    let opened = false
    await expect(
      prepareImage(svg, async () => {
        opened = true
        throw new Error('no')
      }),
    ).rejects.toMatchObject({ problem: 'type' })
    expect(opened).toBe(false)
  })
})

describe('downscaling', () => {
  test('the longest side is cut to 1600 px and the aspect ratio is kept', async () => {
    const { open, calls } = session(4000, 2000, (_w, _h, type) => blob(10_000, type))
    const result = await prepareImage(png(), open)
    expect(calls[0]).toMatchObject({ w: 1600, h: 800 })
    expect(result.type).toBe('image/png')
    expect(result.markdown).toMatch(/^!\[shot\]\(data:image\/png;base64,/)
  })

  test('a small image is not enlarged or resized', async () => {
    const { open, calls } = session(300, 200, (_w, _h, type) => blob(5_000, type))
    await prepareImage(png(), open)
    expect(calls[0]).toMatchObject({ w: 300, h: 200 })
  })

  test('an opaque photo-sized PNG becomes the smallest of WebP and JPEG; a small one stays PNG', async () => {
    const sizes: Record<string, number> = {
      'image/png': 900_000,
      'image/webp': 200_000,
      'image/jpeg': 250_000,
    }
    const big = session(1000, 1000, (_w, _h, type) => blob(sizes[type]!, type))
    expect((await prepareImage(png(), big.open)).type).toBe('image/webp')
    const noWebp = session(1000, 1000, (_w, _h, type) =>
      blob(sizes[type]!, type === 'image/webp' ? 'image/png' : type),
    )
    expect((await prepareImage(png(), noWebp.open)).type).toBe('image/jpeg')
    const small = session(100, 100, (_w, _h, type) => blob(20_000, type))
    expect((await prepareImage(png(), small.open)).type).toBe('image/png')
  })

  test('transparency keeps PNG (or WebP), never JPEG', async () => {
    const alpha = session(
      800,
      800,
      (_w, _h, type) => blob(type === 'image/png' ? 2_000_000 : 400_000, type),
      true,
    )
    const result = await prepareImage(png(), alpha.open)
    expect(result.type).toBe('image/webp')
    expect(alpha.calls.some((c) => c.type === 'image/jpeg')).toBe(false)
  })

  test('a JPEG stays a JPEG, re-encoded at 0.85', async () => {
    const { open, calls } = session(800, 600, (_w, _h, type) => blob(50_000, type))
    const result = await prepareImage(fileOf([0xff, 0xd8, 0xff, 0xe0], 'photo.jpg'), open)
    expect(result.type).toBe('image/jpeg')
    expect(calls[0]).toMatchObject({ type: 'image/jpeg', quality: 0.85 })
  })

  test('a small GIF is kept as it is (animation survives)', async () => {
    const { open, calls } = session(100, 100, () => null)
    const gif = fileOf(Array.from(new TextEncoder().encode('GIF89a')), 'anim.gif')
    const result = await prepareImage(gif, open)
    expect(result.type).toBe('image/gif')
    expect(calls).toHaveLength(0)
  })

  test('too large after downscaling: it shrinks further, then gives up with a size error', async () => {
    const shrinks = session(1600, 1600, (w, _h, type) => blob(w > 1000 ? 3_000_000 : 400_000, type))
    const result = await prepareImage(png(), shrinks.open)
    expect(result.bytes).toBeLessThanOrEqual(MAX_IMAGE_BYTES)
    expect(shrinks.calls.some((c) => c.w < 1600)).toBe(true)
    const never = session(1600, 1600, (_w, _h, type) => blob(MAX_IMAGE_BYTES + 1, type))
    const failure = await prepareImage(png(), never.open).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ImageError)
    expect(failure).toMatchObject({ problem: 'size' })
  })
})

describe('helpers', () => {
  test('alt text from a file name', () => {
    expect(altFromName('Team photo.final.PNG')).toBe('Team photo.final')
    expect(altFromName('a[b]c.png')).toBe('a b c')
    expect(altFromName('.png')).toBe('image')
  })
  test('sizes and chip labels', () => {
    const uri = `data:image/png;base64,${'A'.repeat(4000)}`
    expect(dataUriBytes(uri)).toBe(3000)
    expect(chipLabel(uri)).toBe('data:image/png · 3 KB')
    expect(collapseDataUris(`x ![a](${uri}) y`)).toBe('x ![a](data:image/png · 3 KB) y')
    expect(collapseDataUris('plain data:image/png;base64,AAAA')).toBe(
      'plain data:image/png;base64,AAAA',
    )
  })
})
