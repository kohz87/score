import { expect, test, type Browser, type Page } from '@playwright/test'
import { E2E_SECURITY_PASSWORD, pair } from './pair.ts'

// 3.17.0: taking over builder's screen against the fake adapter (one takeover per desktop, so the sizes run in turn).
// Control belongs to a paired browser session, and every spec shares one session cookie (pair.ts): another spec's page on
// builder's screen then sees this control as its own and hands it back when that page closes. So each test takes control
// in a browser session of its own, paired through a link the shared session mints.
test.describe.configure({ mode: 'serial' })
test.use({ reducedMotion: 'reduce' })
const web = { 'x-score-client': 'web' }

test.beforeEach(async ({ page }) => {
  await pair(page)
  await page.request.put('/api/session/security/password', {
    headers: web,
    data: { password: E2E_SECURITY_PASSWORD },
  })
})

/** A page in a browser session that no other spec shares (paired through a link the shared session mints). */
async function ownSession(shared: Page, browser: Browser, baseURL: string | undefined) {
  const link = await shared.request.post('/api/session/pairing-links', {
    headers: { ...web, 'x-score-password': E2E_SECURITY_PASSWORD },
    data: { password: E2E_SECURITY_PASSWORD },
  })
  test.skip(!link.ok(), 'this server has no public origin for pairing links')
  const { url } = (await link.json()) as { url: string }
  const context = await browser.newContext({ baseURL: baseURL! })
  const page = await context.newPage()
  await page.goto(`/pair#${url.split('#')[1]}`)
  await expect(page.getByText('This browser is paired')).toBeVisible({ timeout: 15_000 })
  return { context, page }
}

async function takeOver(page: Page) {
  // Setting the password unlocked this session; lock it so the card asks for the password.
  await page.request.post('/api/session/security/lock', { headers: web })
  await page.goto('/b/screen/builder')
  await expect(
    page.getByRole('region', { name: 'Live screen' }).getByText('Read-only'),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Take over…' }).click()
  const confirm = page.getByRole('form', { name: 'Take over builder’s desktop?' })
  await expect(confirm).toHaveAttribute('data-protected', 'block')
  await confirm.getByLabel('Security password').fill('not it')
  await confirm.getByRole('button', { name: 'Take over' }).click()
  await expect(confirm.getByRole('alert')).toHaveText('That is not the security password.')
  await confirm.getByLabel('Security password').fill(E2E_SECURITY_PASSWORD)
  await confirm.getByRole('button', { name: 'Take over' }).click()
  const screen = page.getByRole('application', { name: 'builder’s desktop: you have control' })
  await expect(screen).toBeVisible()
  await expect(page.getByText('You have control', { exact: true })).toBeVisible()
  return screen
}

/** A failed test must not leave builder's screen held: the next test would be told it is busy. */
async function handBackIfHeld(page: Page) {
  await page
    .getByRole('button', { name: 'Hand back to builder' })
    .click({ timeout: 2_000 })
    .catch(() => undefined)
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`take over, click and type, hand back (${viewport.width}px)`, async ({
    page: shared,
    browser,
    baseURL,
  }) => {
    const { context, page } = await ownSession(shared, browser, baseURL)
    try {
      await page.setViewportSize(viewport)
      const screen = await takeOver(page)

      const accepted = page.waitForResponse(
        (response) => response.url().endsWith('/bot-screen/input') && response.status() === 204,
      )
      await screen.click({ position: { x: 40, y: 40 } })
      await page.keyboard.type('hello')
      await accepted
      await expect(screen).toBeVisible()
      await expect(page.getByText(/Hands back to builder in/)).toBeVisible()

      if (viewport.width < 600) {
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
        )
        expect(overflow).toBe(false)
      }

      await page.getByRole('button', { name: 'Hand back to builder' }).click()
      await expect(page.getByText(/You handed control back at/)).toBeVisible()
      await expect(page.getByRole('button', { name: 'Take over…' })).toBeVisible()
      await expect(screen).toHaveCount(0)
    } finally {
      await handBackIfHeld(page)
      await context.close()
    }
  })
}

test('a second browser sees "Someone else took over" while the first holds it', async ({
  page: shared,
  browser,
  baseURL,
}) => {
  const first = await ownSession(shared, browser, baseURL)
  const page = first.page
  const other = await ownSession(shared, browser, baseURL)
  try {
    await page.setViewportSize({ width: 1440, height: 900 })
    await takeOver(page)
    await other.page.goto('/b/screen/builder')
    await expect(other.page.getByText('Someone else took over in the Hermes app')).toBeVisible()
    await expect(other.page.getByRole('application')).toHaveCount(0)
    await page.getByRole('button', { name: 'Hand back to builder' }).click()
    await expect(page.getByText(/You handed control back at/)).toBeVisible()
  } finally {
    await handBackIfHeld(page)
    await other.context.close()
    await first.context.close()
  }
})
