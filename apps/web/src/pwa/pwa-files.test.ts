import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

const pub = join(import.meta.dirname, '..', '..', 'public')
const manifest = JSON.parse(readFileSync(join(pub, 'manifest.webmanifest'), 'utf8')) as {
  name: string
  short_name: string
  start_url: string
  scope: string
  display: string
  theme_color: string
  background_color: string
  icons: { src: string; sizes: string; type: string; purpose: string }[]
}

function pngSize(path: string): string {
  const data = readFileSync(path)
  // PNG signature, then the IHDR chunk: width and height are big-endian at bytes 16 and 20.
  expect(data.subarray(1, 4).toString('latin1')).toBe('PNG')
  return `${data.readUInt32BE(16)}x${data.readUInt32BE(20)}`
}

test('the manifest names the app, starts at /b and is installable', () => {
  expect(manifest.name).toBe('Score')
  expect(manifest.short_name).toBe('Score')
  expect(manifest.display).toBe('standalone')
  expect(manifest.start_url).toBe('/b')
  expect(manifest.scope).toBe('/')
  expect(manifest.theme_color).toBe('#12131a')
  expect(manifest.background_color).toBe('#eceef2')
  const purposes = manifest.icons.map((icon) => `${icon.sizes}:${icon.purpose}`)
  expect(purposes).toEqual(['192x192:any', '512x512:any', '512x512:maskable'])
})

test('every manifest icon exists and has the size it claims', () => {
  for (const icon of manifest.icons) {
    expect(icon.type).toBe('image/png')
    expect(pngSize(join(pub, icon.src))).toBe(icon.sizes)
  }
  expect(pngSize(join(pub, 'apple-touch-icon.png'))).toBe('180x180')
})

test('index.html links the manifest and the iOS tags', () => {
  const html = readFileSync(join(import.meta.dirname, '..', '..', 'index.html'), 'utf8')
  for (const needle of [
    'rel="manifest" href="/manifest.webmanifest"',
    'rel="apple-touch-icon"',
    'apple-mobile-web-app-capable',
    'apple-mobile-web-app-status-bar-style',
    'name="theme-color"',
  ])
    expect(html).toContain(needle)
})
