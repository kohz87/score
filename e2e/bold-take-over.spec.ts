import { expect, test, type Page } from '@playwright/test'
import { E2E_SECURITY_PASSWORD, pair } from './pair.ts'
import { acquireLock } from './locks.ts'

// 3.17.0: taking over builder's screen against the fake adapter (one takeover per desktop, so the sizes run in turn).
test.describe.configure({ mode: 'serial' })
test.use({ reducedMotion: 'reduce' })
const web = { 'x-score-client': 'web' }
let releaseTakeover: (() => void) | undefined

/** The fake desktop holds one takeover process-wide; a crashed predecessor must not leave this spec read-only. */
async function handBackIfHeld(page: Page) {
  const status = await page.request.get('/api/agents/builder/bot-screen')
  if (!status.ok()) return
  const takeoverId = ((await status.json()) as { control?: { takeoverId?: string } }).control
    ?.takeoverId
  if (takeoverId)
    await page.request.post('/api/agents/builder/bot-screen/hand-back', {
      headers: web,
      data: { takeoverId },
    })
}

test.beforeEach(async ({ page }) => {
  releaseTakeover = await acquireLock('bot-takeover')
  try {
    await pair(page)
    await handBackIfHeld(page)
    await page.request.put('/api/session/security/password', {
      headers: web,
      data: { password: E2E_SECURITY_PASSWORD },
    })
  } catch (error) {
    releaseTakeover()
    releaseTakeover = undefined
    throw error
  }
})

test.afterEach(async ({ page }) => {
  try {
    await handBackIfHeld(page)
  } finally {
    releaseTakeover?.()
    releaseTakeover = undefined
  }
})

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

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`take over, click and type, hand back (${viewport.width}px)`, async ({ page }) => {
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
  })
}

test('a second browser sees "Someone else took over" while the first holds it', async ({
  page,
  browser,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await takeOver(page)

  const link = await page.request.post('/api/session/pairing-links', {
    headers: { ...web, 'x-score-password': E2E_SECURITY_PASSWORD },
    data: { password: E2E_SECURITY_PASSWORD },
  })
  test.skip(!link.ok(), 'this server has no public origin for pairing links')
  const { url } = (await link.json()) as { url: string }
  const other = await browser.newContext({ baseURL: baseURL! })
  try {
    const second = await other.newPage()
    await second.goto(`/pair#${url.split('#')[1]}`)
    await expect(second.getByText('This browser is paired')).toBeVisible({ timeout: 15_000 })
    await second.goto('/b/screen/builder')
    await expect(second.getByText('Someone else took over in the Hermes app')).toBeVisible()
    await expect(second.getByRole('application')).toHaveCount(0)
  } finally {
    await other.close()
    await page.getByRole('button', { name: 'Hand back to builder' }).click()
    await expect(page.getByText(/You handed control back at/)).toBeVisible()
  }
})
