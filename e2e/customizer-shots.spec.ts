import { expect, test, type Page } from '@playwright/test'
import { writeZip } from '../apps/web/src/themes/customizer/zip.ts'
import { samplePng } from './png.ts'
import { openWithTheme } from './themes-layout-fixtures.ts'

// Screenshots for the 9.4 review (fake mode, frozen data). Only runs when SCORE_UI_SHOTS_DIR names a folder.
const dir = process.env.SCORE_UI_SHOTS_DIR
test.skip(!dir, 'set SCORE_UI_SHOTS_DIR to take the review screenshots')
test.use({ timezoneId: 'UTC', locale: 'en-GB' })

async function open(
  page: Page,
  width = 1440,
  mode: 'light' | 'dark' = 'light',
  path = '/settings/look/customize',
) {
  await page.setViewportSize({ width, height: width < 900 ? 900 : 1000 })
  await page.addInitScript((m) => localStorage.setItem('score.theme', m), mode)
  await openWithTheme(page, [], { active: 'score', mode })
  await page.goto(path)
  await expect(page.getByRole('heading', { name: 'Customize' })).toBeVisible()
  if (width >= 900) {
    const frame = page.frameLocator('iframe[title="Preview of your theme"]')
    await expect(frame.locator('.now-score, .page-content').first()).toBeVisible({
      timeout: 20_000,
    })
  }
  await page.waitForTimeout(800)
}

test('one picture per section', async ({ page }) => {
  await open(page)
  const tabs = [
    'Theme',
    'Colours',
    'Fonts',
    'Shape',
    'Layout',
    'Now',
    'Chat',
    'Background',
    'Custom CSS',
  ]
  for (const name of tabs) {
    await page.getByRole('tab', { name, exact: true }).click()
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${dir}/section-${name.toLowerCase().replace(/ /g, '-')}.png` })
  }
})

test('contrast warning and custom CSS report', async ({ page }) => {
  await open(page)
  await page.getByRole('tab', { name: 'Colours', exact: true }).click()
  const ink = page.getByRole('textbox', { name: 'Main text, colour value' })
  await ink.fill('#b9bdc6')
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${dir}/contrast-warning.png` })
  await page.getByRole('tab', { name: 'Custom CSS', exact: true }).click()
  await page.locator('.cm-content').click()
  await page.keyboard.type(
    '.now-score { content: "x"; position: fixed } .chat-approval { color: red }',
  )
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${dir}/section-custom-css-report.png` })
})

test('picture behind small text', async ({ page }) => {
  await open(page)
  await page.getByRole('tab', { name: 'Background', exact: true }).click()
  await page.locator('input[type=file][accept*="png"]').setInputFiles({
    name: 'busy.png',
    mimeType: 'image/png',
    buffer: Buffer.from(samplePng(960, 640)),
  })
  await page.getByRole('tab', { name: 'Shape', exact: true }).click()
  await page.getByRole('radio', { name: 'Glass' }).click()
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${dir}/background-glass.png` })
})

test('import preview', async ({ page }) => {
  await open(page)
  const manifest = {
    format: 1,
    id: 'harbour',
    name: 'Harbour',
    version: '1.2.0',
    author: 'A. Author',
    description: 'Glass cards, a rail on the left and bubbles in chat.',
    colors: {
      light: { ground: '#dfe9ef', card: '#ffffff', ink: '#0c2230' },
      dark: { ground: '#0b1a22', card: '#122732', ink: '#e6f1f6' },
    },
    shape: { radius: 'round', surface: 'glass' },
    layout: { nav: 'left', chat: { messages: 'bubbles' } },
  }
  const zip = writeZip([
    ['theme.json', new TextEncoder().encode(JSON.stringify(manifest, null, 2))],
    [
      'style.css',
      new TextEncoder().encode('.top-bar { position: fixed; } .card { border-radius: 30px }'),
    ],
  ])
  await page.locator('input[aria-label="Theme file to import"]').setInputFiles({
    name: 'harbour.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(zip),
  })
  await expect(page.getByRole('dialog', { name: /Install/ })).toBeVisible()
  await page.waitForTimeout(2500)
  await page.screenshot({ path: `${dir}/import-preview.png` })
})

test('phone', async ({ page }) => {
  await open(page, 390)
  await page.screenshot({ path: `${dir}/phone-edit.png`, fullPage: true })
  await page.getByRole('radio', { name: 'Preview' }).click()
  await expect(
    page.frameLocator('iframe[title="Preview of your theme"]').locator('.page-content').first(),
  ).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${dir}/phone-preview.png`, fullPage: true })
})
