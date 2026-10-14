import { mkdirSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'

// Settings › About in fake mode (decision 79). The fake server answers the check with a fixed "up to date"; the
// "update available" state is put in front of the real page by answering the browser's own request, so GitHub is
// never contacted.

const shots = process.env.SCORE_UI_SHOTS
const shot = async (page: Page, name: string) => {
  if (!shots) return
  mkdirSync(shots, { recursive: true })
  await page.locator('#about').screenshot({ path: `${shots}/${name}.png` })
}

test('About shows the version and checks for updates only when asked', async ({ page }) => {
  await pair(page)
  const checks: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('update-check')) checks.push(request.method())
  })
  await page.goto('/settings')
  const about = page.getByRole('region', { name: 'About Score' })
  await expect(about.getByText(/^Score v\d+\.\d+\.\d+$/)).toBeVisible()
  await expect(about.getByText('Demo (fake data)')).toBeVisible()
  await about.scrollIntoViewIfNeeded()
  await shot(page, 'about')
  expect(checks).toEqual([])

  await about.getByRole('button', { name: 'Check for updates' }).click()
  await expect(about.getByRole('status')).toContainText('You’re up to date')
  expect(checks).toEqual(['POST'])
})

test('an available update shows the steps', async ({ page }) => {
  await pair(page)
  const tag = 'https://github.com/kohz87/score'
  await page.route('**/api/about/update-check', (route) =>
    route.fulfill({
      json: {
        checkedAt: '2026-10-14T10:00:00.000Z',
        current: '1.3.0',
        status: 'update_available',
        latest: {
          version: '1.4.0',
          tag: 'v1.4.0',
          url: `${tag}/releases/tag/v1.4.0`,
          changelogUrl: `${tag}/blob/v1.4.0/CHANGELOG.md`,
        },
        message: 'v1.4.0 is available.',
      },
    }),
  )
  await page.goto('/settings')
  const about = page.getByRole('region', { name: 'About Score' })
  await about.getByRole('button', { name: 'Check for updates' }).click()
  const steps = about.getByRole('group', { name: 'Steps to update' })
  await expect(steps).toContainText('git pull --ff-only')
  await expect(steps).toContainText('scripts/score stop')
  await expect(about.getByRole('link', { name: 'What’s new' })).toBeVisible()
  await about.scrollIntoViewIfNeeded()
  await shot(page, 'about-update-available')
})
