import { createHmac } from 'node:crypto'
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
    // The card shows a few providers first; the rest sit behind "Show all".
    const showAll = page.getByRole('button', { name: /^Show all \d+ providers$/u })
    if (await showAll.isVisible().catch(() => false)) await showAll.click()
    const connect = row.getByRole('button', { name: 'Connect OpenRouter' })
    let connectedNow = false
    if (await connect.isVisible().catch(() => false)) {
      await connect.click()
      await page
        .getByRole('textbox', { name: 'API key', exact: true })
        .fill('sk-or-e2e-provider-key')
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
      await page.getByRole('textbox', { name: 'Bot token', exact: true }).fill('discord-e2e-token')
    } else {
      await page.getByRole('textbox', { name: 'Bot token (xoxb-)' }).fill('xoxb-e2e-token')
      await page
        .getByRole('textbox', { name: 'App token (xapp-)', exact: true })
        .fill('xapp-e2e-token')
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

  // Removing a tool server is covered in bold-connections-remove.spec.ts; testing one still happens in Hermes.
  await expect(page.getByText(/Testing a tool server is done in Hermes/)).toBeVisible()
  await expect(page.getByText(/Don’t paste tokens or passwords into the command/)).toBeVisible()
  await expect(page.getByRole('button', { name: /Send a test call/ })).toHaveCount(0)
}

function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`
}

async function callHook(page: Page, id: string, secret: string, body: string, webhookId: string) {
  const at = Math.floor(Date.now() / 1000)
  return page.request.post(`/hooks/${id}`, {
    headers: {
      'content-type': 'application/json',
      'webhook-id': webhookId,
      'webhook-timestamp': String(at),
      'webhook-signature': signWebhook(secret, webhookId, at, body),
    },
    data: body,
  })
}

async function addTriggerThroughFourSteps(page: Page) {
  const tag = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`
  const name = `Support ticket ${tag}`
  const app = 'Tickets app'
  const ref = `TCK-${tag.toUpperCase()}`
  await page.getByRole('button', { name: 'New trigger' }).click()
  const dialog = page.getByRole('dialog', { name: 'New trigger' })
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByLabel('App it comes from').fill(app)
  await dialog.getByRole('button', { name: 'Create the address' }).click()

  const secretCode = dialog.locator('[data-trigger-secret]')
  await expect(secretCode).toBeVisible()
  const secret = (await secretCode.textContent())!.trim()
  expect(secret).toMatch(/^whsec_/)
  await dialog.getByRole('button', { name: 'Close secret' }).click()
  await expect(secretCode).toHaveCount(0)

  const url = (await dialog.locator('.bold-trigger-url').textContent())!.trim()
  const id = /\/hooks\/([^/?#]+)$/.exec(url)?.[1]
  expect(id, 'the address carries the trigger id').toBeTruthy()
  const body = JSON.stringify({
    id: ref,
    title: `Export button does nothing ${tag}`,
    url: `https://tickets.example.com/${ref}`,
    body: 'Clicking Export on the Reports page does nothing in Safari 18.',
  })
  const answer = await callHook(page, id!, secret, body, `msg-${tag}`)
  expect(answer.status()).toBe(200)

  // Step 2 polls GET /api/triggers, so the sample can arrive before this line: never race the poll.
  await expect(dialog.getByText('Test call received')).toBeVisible({ timeout: 10_000 })
  await dialog.getByRole('button', { name: 'Map fields' }).click()
  await dialog.locator('[data-mapping-slot="ref"]').click()
  await dialog.locator('[data-payload-path="id"]').click()
  await dialog.locator('[data-mapping-slot="title"]').click()
  await dialog.locator('[data-payload-path="title"]').click()
  await dialog.locator('[data-mapping-slot="link"]').click()
  await dialog.locator('[data-payload-path="url"]').click()
  await dialog.locator('[data-mapping-slot="details"]').click()
  await dialog.locator('[data-payload-path="body"]').click()
  await dialog
    .getByLabel('What the job asks the team to do')
    .fill('Handle {{title}} ({{id}}): {{body}}')
  await dialog.getByRole('button', { name: 'Next' }).click()
  await expect(dialog).toHaveAttribute('data-trigger-step', '4')
  await dialog.getByLabel(/Don’t report back/).check()
  await dialog.getByRole('button', { name: 'Save trigger' }).click()
  await expect(dialog).toBeHidden()

  const card = page.locator(`[data-trigger-id="${id}"]`)
  await expect(card).toBeVisible()
  await expect(card).toContainText(name)
  await expect(card).toContainText('Results stay in Score.')

  await expect
    .poll(
      async () => {
        const response = await page.request.get('/api/team-room')
        if (!response.ok()) return null
        const body = (await response.json()) as {
          jobs: { id: string; source: { ref: string; triggerId: string } | null }[]
        }
        return body.jobs.find((job) => job.source?.ref === ref)?.id ?? null
      },
      { timeout: 20_000 },
    )
    .toBeTruthy()

  // The saved mapping, not the test call's placeholder: a new call's job carries the mapped title.
  const savedRef = `${ref}-2`
  const savedTitle = `Saved mapping works ${tag}`
  const second = await callHook(
    page,
    id!,
    secret,
    JSON.stringify({
      id: savedRef,
      title: savedTitle,
      url: `https://tickets.example.com/${savedRef}`,
      body: 'x',
    }),
    `msg-${tag}-2`,
  )
  expect(second.status()).toBe(200)
  await expect
    .poll(
      async () => {
        const response = await page.request.get('/api/team-room')
        if (!response.ok()) return null
        const body = (await response.json()) as {
          jobs: { title: string; source: { ref: string } | null }[]
        }
        return body.jobs.find((job) => job.source?.ref === savedRef)?.title ?? null
      },
      { timeout: 20_000 },
    )
    .toContain(savedTitle)

  return { id: id!, secret, name, ref }
}

async function rotateTrigger(
  page: Page,
  trigger: Awaited<ReturnType<typeof addTriggerThroughFourSteps>>,
) {
  const card = page.locator(`[data-trigger-id="${trigger.id}"]`)
  await card.getByRole('button', { name: 'Rotate secret' }).click()
  const confirm = page.getByRole('alertdialog', { name: 'Rotate the secret?' })
  await expect(confirm).toContainText('old secret stops working immediately')
  await confirm.getByRole('button', { name: 'Rotate secret' }).click()
  const secretCode = page.locator('[data-trigger-secret]')
  await expect(secretCode).toBeVisible()
  const secret = (await secretCode.textContent())!.trim()
  expect(secret).not.toBe(trigger.secret)
  await page.getByRole('button', { name: 'Close secret' }).click()
  await expect(secretCode).toHaveCount(0)

  const oldCall = await callHook(
    page,
    trigger.id,
    trigger.secret,
    JSON.stringify({ id: `${trigger.ref}-OLD` }),
    `msg-old-${trigger.ref}`,
  )
  expect(oldCall.status()).toBe(401)
  const newCall = await callHook(
    page,
    trigger.id,
    secret,
    JSON.stringify({ id: `${trigger.ref}-NEW` }),
    `msg-new-${trigger.ref}`,
  )
  expect(newCall.status()).toBe(200)
}

async function mockSharedLook(page: Page) {
  let shared = { active: 'score', mode: 'system' }
  await page.route('**/api/themes', async (route) => {
    // The page can go away while the request is in flight (a navigation, the test ending); Playwright then disposes
    // the fetched response, and there is nobody left to answer.
    try {
      const response = await route.fetch()
      const body = (await response.json()) as Record<string, unknown>
      await route.fulfill({ response, json: { ...body, ...shared } })
    } catch {
      await route.abort().catch(() => undefined)
    }
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
  // Calm is the default since Lively went (11.11c), so choosing Still is the change that gets saved.
  await motion.getByRole('radio', { name: 'Still' }).click()
  await expect(motion.getByRole('radio', { name: 'Still' })).toHaveAttribute('aria-checked', 'true')
  expect(await page.evaluate(() => localStorage.getItem('score.liveliness'))).toBe('still')

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
  await expect(motion.getByRole('radio', { name: 'Still' })).toHaveAttribute('aria-checked', 'true')
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
      const trigger = await addTriggerThroughFourSteps(page)
      await rotateTrigger(page, trigger)
      const triggerCard = page.locator(`[data-trigger-id="${trigger.id}"]`)
      await triggerCard.getByRole('button', { name: 'Edit' }).click()
      const edit = page.getByRole('dialog', { name: 'Edit trigger' })
      await expect(edit).toHaveAttribute('data-trigger-step', '3')
      await expect(edit.locator('[data-payload-path="id"]')).toHaveCount(1)
      await edit.getByRole('button', { name: 'Next' }).click()
      await edit.getByLabel(/Post with a tool every time/).check()
      await edit.getByLabel('Tool name').fill('add_comment')
      await edit.getByLabel('Arguments template (JSON)').fill('{"id": "{{source.ref}}"}')
      await edit.getByRole('button', { name: 'Save changes' }).click()
      await expect(edit).toBeHidden()
      await expect(triggerCard).toContainText('Reports back with add_comment.')
      await expectNoOverflow(page, 'Tools and triggers')
      await expectReducedMotion(page)
      await page.screenshot({
        path: testInfo.outputPath(`bold-tools-${viewport.width}.png`),
        fullPage: true,
      })
      await triggerCard.getByRole('button', { name: 'Delete' }).click()
      const remove = page.getByRole('alertdialog', { name: 'Delete this trigger?' })
      await remove.getByRole('button', { name: 'Delete trigger' }).click()
      await expect(triggerCard).toHaveCount(0)

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
      expect(await page.evaluate(() => localStorage.getItem('score.ui'))).toBe('classic')
      await page.reload()
      await expect(page.getByRole('region', { name: 'Look' })).toBeVisible()
      expect(currency()).toEqual({ code: 'EUR', rate: 0.92 })
    })
  }
})

test('closing a new trigger before it is saved offers to delete the live address', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await pair(page)
  await openBoldSettings(page, 'tools')
  const name = `Unfinished ${Date.now().toString(36)}`
  await page.getByRole('button', { name: 'New trigger' }).click()
  const dialog = page.getByRole('dialog', { name: 'New trigger' })
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByLabel('App it comes from').fill('Tickets app')
  await dialog.getByRole('button', { name: 'Create the address' }).click()
  await dialog.getByRole('button', { name: 'Close secret' }).click()
  await dialog.getByRole('button', { name: 'Finish later' }).click()
  const confirm = page.getByRole('alertdialog', { name: 'Keep this unfinished trigger?' })
  await expect(confirm).toContainText('already live')
  await confirm.getByRole('button', { name: 'Delete trigger' }).click()
  await expect(confirm).toBeHidden()
  await expect
    .poll(async () => {
      const response = await page.request.get('/api/triggers')
      const body = (await response.json()) as { items: { name: string }[] }
      return body.items.some((trigger) => trigger.name === name)
    })
    .toBe(false)
})
