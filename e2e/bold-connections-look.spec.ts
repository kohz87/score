import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'

// PLAN 11.9a: Connections, Tools and triggers, and Look under the bold tokens at both review sizes.

const viewports = [
  { width: 1440, height: 900, provider: 'openrouter', channel: 'discord' },
  { width: 390, height: 844, provider: 'local', channel: 'slack' },
] as const

async function expectNoOverflow(page: Page, where: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  )
  expect(overflow, `${where} overflows horizontally`).toBeLessThanOrEqual(0)
}

async function expectReducedMotion(page: Page) {
  await expect(page.locator('html')).toHaveAttribute('data-liveliness', 'still')
}

async function openBoldSettings(page: Page, section: string) {
  await page.goto('/?ui=bold')
  await expect(page).toHaveURL('/b')
  await page.goto(`/b/settings/${section}`)
  await expect(page.locator('[data-ui="bold"] .setgrid .setnav')).toBeVisible({ timeout: 20_000 })
}

async function connectProvider(page: Page, provider: 'openrouter' | 'local') {
  if (provider === 'openrouter') {
    const row = page.locator('[data-provider-id="openrouter"]')
    const connect = row.getByRole('button', { name: 'Connect OpenRouter' })
    let connectedNow = false
    if (await connect.isVisible().catch(() => false)) {
      await connect.click()
      await page.getByLabel('API key').fill('sk-or-e2e-provider-key')
      await page.getByRole('button', { name: 'Save key' }).click()
      connectedNow = true
    }
    await expect(row).toContainText('API key (1)')
    if (connectedNow)
      await expect(
        page.getByRole('status').filter({ hasText: 'OpenRouter is connected.' }),
      ).toBeVisible()
    return
  }

  const row = page.locator('[data-provider-id="local"]')
  const name = `Phone endpoint ${Date.now()}`
  await row.getByRole('button', { name: 'Add', exact: true }).click()
  const form = row.getByRole('form', { name: 'Add a local model' })
  await form.getByLabel('Name').fill(name)
  await form.getByLabel('Address').fill('http://127.0.0.1:8080/v1')
  await form.getByLabel('Model').fill('local-e2e')
  await form.getByRole('button', { name: 'Add model' }).click()
  await expect(page.getByRole('status').filter({ hasText: `Added ${name}.` })).toBeVisible()
  await expect(page.getByText(name, { exact: true })).toBeVisible()
}

async function connectChannel(page: Page, platform: 'discord' | 'slack') {
  const row = page.locator(`[data-channel="${platform}"]`)
  const label = platform === 'discord' ? 'Discord' : 'Slack'
  const connect = row.getByRole('button', { name: `Connect ${label}` })
  if (await connect.isVisible().catch(() => false)) {
    await connect.click()
    if (platform === 'discord') {
      await page.getByLabel('Bot token').fill('discord-e2e-token')
    } else {
      await page.getByLabel('Bot token (xoxb-)').fill('xoxb-e2e-token')
      await page.getByLabel('App token (xapp-)').fill('xapp-e2e-token')
    }
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText(/Saved. The gateway picks up/)).toBeVisible()
    await page.getByRole('button', { name: 'Done', exact: true }).click()
  }
  await expect(row).toContainText('Connected')
}

async function addToolServer(page: Page) {
  const name = `tickets-${Date.now().toString(36)}`
  const form = page.getByRole('form', { name: 'Add a tool server' })
  await form.getByLabel('Name').fill(name)
  await form.getByLabel('Address or command').fill('npx -y @example/e2e-tickets')
  await form.getByRole('button', { name: 'Add tool server' }).click()
  const command = page.getByRole('group', { name: 'Run in a terminal' })
  await expect(command).toContainText(`hermes mcp add ${name}`)
  await command.getByRole('button', { name: 'Done' }).click()
  await expect(command).toBeHidden()

  // The contract has no trigger routes, tool test call or tool removal yet; the page says so instead of faking them.
  await expect(page.getByText('Triggers need the 11.1d API')).toBeVisible()
  await expect(page.getByRole('button', { name: /Send a test call/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Remove/ })).toHaveCount(0)
}

async function mockSharedLook(page: Page) {
  let shared = { active: 'score', mode: 'system' }
  await page.route('**/api/themes', async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as Record<string, unknown>
    await route.fulfill({ response, json: { ...body, ...shared } })
  })
  await page.route('**/api/look', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue()
    const body = route.request().postDataJSON() as { activeTheme: string; mode: string }
    shared = { active: body.activeTheme, mode: body.mode }
    await route.fulfill({ status: 204 })
  })
  return () => shared
}

async function mockCurrency(page: Page) {
  let currency = { code: 'USD', rate: 1 }
  await page.route('**/api/settings/currency', async (route) => {
    const request = route.request()
    if (request.method() === 'PUT') currency = request.postDataJSON() as typeof currency
    await route.fulfill({ json: currency })
  })
  return () => currency
}

async function exerciseLook(page: Page, shared: () => { active: string; mode: string }) {
  await openBoldSettings(page, 'look')
  await expect(page.getByRole('heading', { name: 'Look', exact: true })).toBeVisible()
  const shell = page.locator('[data-ui="bold"]')
  const mode = page.getByRole('radiogroup', { name: 'Mode on this device' })

  // Per-device colour: apply now, survive a reload, then follow the shared choice again.
  await expect(shell).toHaveAttribute('data-look', 'dark')
  await mode.getByRole('radio', { name: /^Light/ }).click()
  await expect(shell).toHaveAttribute('data-look', 'light')
  expect(await page.evaluate(() => localStorage.getItem('score.theme'))).toBe('light')

  // Per-device motion is saved even though the test's reduced-motion setting keeps the shell still.
  const motion = page.getByRole('radiogroup', { name: 'Motion on this device' })
  await motion.getByRole('radio', { name: 'Calm' }).click()
  await expect(motion.getByRole('radio', { name: 'Calm' })).toHaveAttribute('aria-checked', 'true')
  expect(await page.evaluate(() => localStorage.getItem('score.liveliness'))).toBe('calm')

  // Text size changes the shell's own scale and is remembered per device.
  const scale = page.getByRole('slider', { name: 'Text size' })
  await expect(scale).toHaveValue('1')
  await scale.focus()
  await page.keyboard.press('ArrowRight')
  await expect(scale).toHaveValue('1.05')
  await expect(page.getByText('105%', { exact: true })).toBeVisible()
  expect(
    await shell.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).getPropertyValue('--scale')),
    ),
  ).toBe(1.05)

  const sendKey = page.getByRole('radiogroup', { name: 'Send messages with' })
  await sendKey.getByRole('radio', { name: 'Ctrl+Enter' }).click()
  expect(await page.evaluate(() => localStorage.getItem('score.sendKey'))).toBe('ctrl-enter')

  const currency = page.getByRole('form', { name: 'Display currency' })
  await currency.getByLabel('Currency code').fill('EUR')
  await currency.getByLabel('Rate (1 USD =)').fill('0.92')
  await currency.getByRole('button', { name: 'Save' }).click()
  await expect(currency.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible()

  // Reload: every device preference is still applied, and the shared form keeps its last saved values.
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Look', exact: true })).toBeVisible()
  await expect(shell).toHaveAttribute('data-look', 'light')
  await expect(mode.getByRole('radio', { name: /^Light/ })).toHaveAttribute('aria-checked', 'true')
  await expect(motion.getByRole('radio', { name: 'Calm' })).toHaveAttribute('aria-checked', 'true')
  await expect(scale).toHaveValue('1.05')
  await expect(sendKey.getByRole('radio', { name: 'Ctrl+Enter' })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await expect(currency.getByLabel('Currency code')).toHaveValue('EUR')
  await expect(currency.getByLabel('Rate (1 USD =)')).toHaveValue('0.92')
  await expectReducedMotion(page)

  await page.getByRole('button', { name: 'Follow the shared colours' }).click()
  expect(await page.evaluate(() => localStorage.getItem('score.theme'))).toBeNull()

  // A shared look is one save for every device; this browser follows it until it chooses again.
  await page.getByLabel('Theme for every device').selectOption('harbour')
  await page.getByLabel('Colours for every device').selectOption('light')
  await page.getByRole('button', { name: 'Save for every device' }).click()
  await expect(page.getByRole('button', { name: 'Save for every device' })).toBeDisabled()
  expect(shared()).toEqual({ active: 'harbour', mode: 'light' })
  await expect(shell).toHaveAttribute('data-look', 'light')
  await page.reload()
  await expect(page.getByLabel('Theme for every device')).toHaveValue('harbour')
  await expect(page.getByLabel('Colours for every device')).toHaveValue('light')
  expect(await page.evaluate(() => localStorage.getItem('score.theme'))).toBeNull()

  await expectNoOverflow(page, 'Look')
  await expectReducedMotion(page)
}

test.describe('bold Connections, Tools and Look', () => {
  test.use({ reducedMotion: 'reduce', colorScheme: 'dark' })

  for (const viewport of viewports) {
    test(`works at ${viewport.width}×${viewport.height}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport)
      const shared = await mockSharedLook(page)
      const currency = await mockCurrency(page)
      await pair(page)

      await openBoldSettings(page, 'connections')
      await expect(page.getByRole('heading', { name: 'Connections', exact: true })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Hermes', exact: true })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Model providers' })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Channels' })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Your phone' })).toBeVisible()
      await connectProvider(page, viewport.provider)
      await connectChannel(page, viewport.channel)
      await expectNoOverflow(page, 'Connections')
      await expectReducedMotion(page)
      await page.screenshot({
        path: testInfo.outputPath(`bold-connections-${viewport.width}.png`),
        fullPage: true,
      })

      await openBoldSettings(page, 'tools')
      await expect(page.getByRole('heading', { name: 'Tools and triggers' })).toBeVisible()
      await expect(page.getByText('files', { exact: true })).toBeVisible()
      await addToolServer(page)
      await expectNoOverflow(page, 'Tools and triggers')
      await expectReducedMotion(page)
      await page.screenshot({
        path: testInfo.outputPath(`bold-tools-${viewport.width}.png`),
        fullPage: true,
      })

      await exerciseLook(page, shared)
      await page.screenshot({
        path: testInfo.outputPath(`bold-look-${viewport.width}.png`),
        fullPage: true,
      })

      // The same pairing card under the bold tokens: the consent surface does not change.
      await page.goto('/pair')
      const frame = page.locator('.bold-pair-page')
      await expect(frame).toBeVisible()
      await expect(frame).toHaveAttribute('data-ui', 'bold')
      await expect(page.getByRole('heading', { name: 'Pair this browser' })).toBeVisible()
      await expect(page.getByText(/Open the pairing link printed/)).toBeVisible()
      await expect(page.locator('.pair-card')).toHaveAttribute('data-protected', 'block')
      await expectNoOverflow(page, 'pairing')
      await page.screenshot({
        path: testInfo.outputPath(`bold-pair-${viewport.width}.png`),
        fullPage: true,
      })

      // Turning off New look returns this device to classic Settings and stays off after a reload.
      await openBoldSettings(page, 'look')
      await page.getByRole('switch', { name: 'Use the new look on this device' }).click()
      await expect(page).toHaveURL('/settings/look')
      await expect(page.locator('[data-ui="bold"]')).toHaveCount(0)
      await expect(page.getByRole('region', { name: 'Look' })).toBeVisible()
      expect(await page.evaluate(() => localStorage.getItem('score.ui'))).toBeNull()
      await page.reload()
      await expect(page.getByRole('region', { name: 'Look' })).toBeVisible()
      expect(currency()).toEqual({ code: 'EUR', rate: 0.92 })
    })
  }
})
