import { expect, test, type Page } from '@playwright/test'
import { mockThemes, type Look, type MockTheme } from './themes-fixtures.ts'
import { pair } from './pair.ts'
import { makeRoom, say } from './rooms.ts'

// Phase 9 re-gate H1 (decision 102): the trusted protected boundary, in a real browser. Theme CSS is an allowlist of
// visual properties (so most of what these specs inject is dropped before it gets here); protected.css is the second
// wall, so the same things injected after the sanitiser (as if it had missed one) still can't change what a
// decision reads like or what its way back sits on. The theme's server routes are mocked per contract § 16.

const BLACK_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC'

async function wear(page: Page, theme: Partial<MockTheme>) {
  const look: Look = { active: 'edge', mode: 'light' }
  await mockThemes(page, [{ id: 'edge', name: 'Edge', source: 'imported', ...theme }], look)
  await page.route('**/api/themes/edge/assets/**', (route) =>
    route.fulfill({ body: Buffer.from(BLACK_PNG, 'base64'), contentType: 'image/png' }),
  )
  await pair(page)
}

async function startApproval(page: Page) {
  const room = await makeRoom(page, 'edge')
  await say(page, room.id, `Please ask for approval before installing ${Date.now()}`)
  await page.goto(`/chat/${room.id}`)
  const card = page.getByRole('group', { name: /^Approval: / }).last()
  await expect(card.getByRole('button', { name: 'Approve' })).toBeAttached({ timeout: 20_000 })
  return card
}

test('re-gate 3: inherited typography from an ancestor can’t change how a decision reads', async ({
  page,
}) => {
  await wear(page, { css: '.now-card { box-shadow: 0 1px 2px rgb(0 0 0 / 12%); }' })
  const card = await startApproval(page)
  await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
  // As if the sanitiser had missed these: an unlayered sheet on the ancestors.
  await page.addStyleTag({
    content:
      ':root, body, .chat-message, .chat-thread, main { word-spacing: -100px; letter-spacing: -4px; text-transform: uppercase; writing-mode: vertical-rl; text-indent: 400px; text-shadow: 0 0 30px red; }',
  })
  const read = await card.evaluate((surface) => {
    const style = getComputedStyle(surface)
    const button = surface.querySelector('button')!
    const own = getComputedStyle(button)
    return {
      wordSpacing: Number.parseFloat(style.wordSpacing) || 0,
      writingMode: style.writingMode,
      textShadow: style.textShadow,
      textIndent: Number.parseFloat(style.textIndent) || 0,
      buttonWordSpacing: Number.parseFloat(own.wordSpacing) || 0,
      buttonWritingMode: own.writingMode,
      buttonShadow: own.textShadow,
    }
  })
  expect(read).toEqual({
    wordSpacing: 0,
    writingMode: 'horizontal-tb',
    textShadow: 'none',
    textIndent: 0,
    buttonWordSpacing: 0,
    buttonWritingMode: 'horizontal-tb',
    buttonShadow: 'none',
  })
})

test('re-gate 5: a translucent rail over a black picture leaves the Settings link on an opaque background', async ({
  page,
}) => {
  await wear(page, {
    manifest: {
      layout: { nav: 'left' },
      shape: { surface: 'glass' },
      background: { image: 'asset:img/black.png', fit: 'cover', dim: 0 },
    },
    css: '.top-bar { background-color: rgb(255 255 255 / 70%); }',
  })
  await page.goto('/now')
  await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
  const link = page.locator('a.main-nav-link[href="/settings"]')
  await expect(link).toBeVisible()
  const result = await link.evaluate((element) => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    const rgba = (value: string) => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = '#000'
      context.fillStyle = value
      context.fillRect(0, 0, 1, 1)
      const d = context.getImageData(0, 0, 1, 1).data
      return [d[0]!, d[1]!, d[2]!, d[3]! / 255] as const
    }
    const luminance = ([r, g, b]: readonly number[]) => {
      const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
      return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!)
    }
    const style = getComputedStyle(element)
    const back = rgba(style.backgroundColor)
    const text = rgba(style.color)
    const a = luminance(text)
    const b = luminance(back)
    return {
      alpha: back[3],
      ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
      current: element.getAttribute('aria-current'),
    }
  })
  expect(result.alpha).toBe(1)
  expect(result.ratio).toBeGreaterThanOrEqual(4.5)
  // The theme stays on: the link reads, so nothing needed to be switched off.
  await page.waitForTimeout(1500)
  await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
  await expect(page.locator('.look-banner')).toHaveCount(0)
})
