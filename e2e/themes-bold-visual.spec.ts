import { expect, test, type Page } from '@playwright/test'
import { openBoldRoomWith } from './bold-room-fixtures.ts'
import { withLock } from './locks.ts'
import { pair } from './pair.ts'
import { boldThemeIds, wearBuiltin } from './themes-bold-fixtures.ts'

// PLAN 11.9d: baselines of the new shell under each built-in theme (Score and the six that ship): Room, Team and
// Settings, in dark, light and at phone width. Room reads a fixed fixture (the fake team room moves over time); Team and
// Settings are the fake adapter's own, with the parts that move (the dock, live status) kept out of the picture.
type Variant = 'dark' | 'light' | 'phone'
const sizes: Record<Variant, { width: number; height: number }> = {
  dark: { width: 1440, height: 900 },
  light: { width: 1440, height: 900 },
  phone: { width: 390, height: 844 },
}
const variants: Variant[] = ['dark', 'light', 'phone']

test.use({ reducedMotion: 'reduce', timezoneId: 'UTC', locale: 'en-GB' })

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready)
  // The Workbench tab keeps a hidden "Loading" line while another tab is shown: only what is visible counts.
  await expect(page.getByText(/^Loading/).filter({ visible: true })).toHaveCount(0)
  await expect
    .poll(async () => {
      const first = await page.evaluate(() => document.documentElement.scrollHeight)
      await page.waitForTimeout(200)
      return first === (await page.evaluate(() => document.documentElement.scrollHeight))
    })
    .toBe(true)
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(1)
}

for (const id of boldThemeIds) {
  for (const variant of variants) {
    const mode = variant === 'dark' ? 'dark' : 'light'
    test.describe(`${id}, ${variant}`, () => {
      test.beforeEach(async ({ page }) => {
        await page.setViewportSize(sizes[variant])
        await page.addInitScript((m) => localStorage.setItem('score.theme', m), mode)
      })

      test('Room', async ({ page }) => {
        await openBoldRoomWith(page, {}, async (p) => {
          await wearBuiltin(p, id, mode)
          // The room fixture has no Results or Workbench: empty ones keep the side panel from showing an error.
          await p.route('**/api/jobs/*/results*', (route) =>
            route.fulfill({ json: { asOfSeq: 12, items: [], screens: [] } }),
          )
          await p.route('**/api/jobs/*/workbench*', (route) =>
            route.fulfill({
              json: { asOfSeq: 12, files: [], looseComments: [], drafts: [], screens: [] },
            }),
          )
        })
        await expect(page.getByRole('tab', { name: /Release notes 2\.4/ })).toBeVisible()
        await settle(page)
        await expect(page).toHaveScreenshot(`bold-${id}-room-${variant}.png`, {
          animations: 'disabled',
          maxDiffPixelRatio: 0.005,
        })
      })

      test('Team', async ({ page }) => {
        await pair(page)
        await wearBuiltin(page, id, mode)
        // Other specs rename, restyle and add agents on the shared fake team: the baseline shows the four example agents
        // as the fake adapter seeds them (apps/server/src/hermes/fake/scenario.ts).
        const example: Record<string, { role: string; color: string; shape: string }> = {
          lead: { role: 'Leads the team', color: '#6B4EFF', shape: 'circle-dot' },
          builder: { role: 'Builds features', color: '#19C39A', shape: 'triangle' },
          reviewer: { role: 'Reviews changes', color: '#FFB61E', shape: 'diamond' },
          designer: { role: 'Designs interfaces', color: '#FF6B8A', shape: 'square' },
        }
        await page.route('**/api/agents', async (route) => {
          if (route.request().method() !== 'GET') return route.fallback()
          const response = await route.fetch()
          const body = (await response.json()) as { items: { id: string }[] }
          const items = body.items
            .filter((item) => item.id in example)
            .map((item) => {
              const { role, color, shape } = example[item.id]!
              return {
                ...item,
                name: item.id,
                role,
                style: { color, shape },
                status: 'idle',
                activity: null,
              }
            })
          await route.fulfill({ response, json: { ...body, items } })
        })
        await withLock('roster', async () => {
          await page.goto('/b/team')
          await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
          await settle(page)
          await expect(page).toHaveScreenshot(`bold-${id}-team-${variant}.png`, {
            fullPage: true,
            animations: 'disabled',
            maxDiffPixelRatio: 0.005,
            mask: [
              page.locator('.dock'),
              page.locator('.bold-agentcard-state'),
              page.locator('.bold-glimpse'),
            ],
          })
        })
      })

      test('Settings', async ({ page }) => {
        await pair(page)
        await wearBuiltin(page, id, mode)
        await page.goto('/b/settings/look')
        await expect(page.getByRole('heading', { name: 'Look', exact: true })).toBeVisible()
        await settle(page)
        await expect(page).toHaveScreenshot(`bold-${id}-settings-${variant}.png`, {
          fullPage: true,
          animations: 'disabled',
          maxDiffPixelRatio: 0.005,
          mask: [page.locator('.dock')],
        })
      })
    })
  }
}
