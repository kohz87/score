// Renders the Score mark to the PNG icons in apps/web/public (run `node scripts/make-pwa-icons.mjs`).
// The PNGs are committed, so a build never needs this; it exists so the icons can be regenerated.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

const out = join(import.meta.dirname, '..', 'apps', 'web', 'public')
mkdirSync(out, { recursive: true })

// The mark from the top bar (viewBox 30): ink tile, three bars.
const bars = `
  <path d="M7 10 H15" stroke="#ece8ff" stroke-width="2.4" stroke-linecap="round"/>
  <path d="M11 15 H23" stroke="#19c39a" stroke-width="2.4" stroke-linecap="round"/>
  <path d="M9 20 H18" stroke="#ffb61e" stroke-width="2.4" stroke-linecap="round"/>`
// `scale` keeps the bars inside the maskable safe zone (the inner 80% circle) on full-bleed icons.
function svg({ rounded, scale }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 30" width="100%" height="100%">
  <rect width="30" height="30" rx="${rounded ? 9 : 0}" fill="#12131a"/>
  <g transform="translate(15 15) scale(${scale}) translate(-15 -15)">${bars}</g>
</svg>`
}

const icons = [
  ['icon-192.png', 192, { rounded: true, scale: 1 }],
  ['icon-512.png', 512, { rounded: true, scale: 1 }],
  ['icon-maskable-512.png', 512, { rounded: false, scale: 0.72 }],
  ['apple-touch-icon.png', 180, { rounded: false, scale: 0.85 }],
]
const browser = await chromium.launch()
const page = await browser.newPage()
for (const [name, size, options] of icons) {
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(`<style>html,body{margin:0;background:transparent}</style>${svg(options)}`)
  writeFileSync(join(out, name), await page.screenshot({ omitBackground: true }))
}
writeFileSync(
  join(out, 'favicon.svg'),
  svg({ rounded: true, scale: 1 }).replace(' width="100%" height="100%"', ''),
)
await browser.close()
