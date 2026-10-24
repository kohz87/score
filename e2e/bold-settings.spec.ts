import { expect, test, type Locator, type Page } from '@playwright/test'
import { pair } from './pair.ts'

// PLAN 11.9b: every classic Settings feature stays reachable through the bold Settings frame, at both review sizes.

const viewports = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const

const rules = {
  mode: 'smart',
  goAhead: [{ id: 'read', label: 'Read files', pattern: null, readOnly: false }],
  askMe: [{ id: 'install', label: 'Install packages', pattern: null, readOnly: false }],
  never: [{ id: 'never:secrets', label: 'secrets', pattern: 'secrets', readOnly: false }],
  drift: [],
}

async function mockRules(page: Page) {
  await page.route('**/api/settings/rules**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const body = request.postDataJSON() as Record<string, unknown> | null
    const json = (value: unknown) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(value),
      })
    if (request.method() === 'PUT' && url.searchParams.has('dryRun'))
      return json({ preview: '+mode: manual\n+never: rm -rf /tmp/*' })
    if (request.method() === 'PUT')
      return json({ ...rules, mode: body?.mode, never: rules.never, failed: [] })
    return json(rules)
  })
}

async function allowNotifications(page: Page) {
  await page.addInitScript(() => {
    let granted = false
    Object.defineProperty(Notification, 'permission', {
      get: () => (granted ? 'granted' : 'default'),
    })
    Notification.requestPermission = async () => {
      granted = true
      return 'granted'
    }
  })
}

async function expectNoOverflow(page: Page, where: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  )
  expect(overflow, `${where} overflows horizontally`).toBeLessThanOrEqual(0)
}

async function expectMinHeight(control: Locator, height: number) {
  expect(await control.evaluate((element) => getComputedStyle(element).minHeight)).toBe(
    `${height}px`,
  )
}

// Keep the shared fake server out of these checks: both settings persist in this page's own state, so a
// reload (and a parallel spec) sees exactly what this test changed.
async function mockLibrary(page: Page) {
  let agentAccess = false
  let memoryNotes = true
  let info: Record<string, unknown> | null = null
  await page.route(/\/api\/knowledge(?:\?.*)?$/, async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as Record<string, unknown>
    info = body
    return route.fulfill({ response, json: { ...body, agentAccess, memoryNotes } })
  })
  await page.route(/\/api\/knowledge\/agent-usage(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { items: [{ agentId: 'builder', writesToday: 3 }] } }),
  )
  await page.route(/\/api\/knowledge\/settings(?:\?.*)?$/, (route) => {
    if (route.request().method() !== 'PUT') return route.continue()
    const body = route.request().postDataJSON() as {
      agentAccess?: boolean
      memoryNotes?: boolean
    }
    if (body.agentAccess !== undefined) agentAccess = body.agentAccess
    if (body.memoryNotes !== undefined) memoryNotes = body.memoryNotes
    return route.fulfill({ json: { ...(info ?? {}), agentAccess, memoryNotes } })
  })
}

async function mockTeamPause(page: Page) {
  let paused = false
  await page.route(/\/api\/now(?:\?.*)?$/, async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as Record<string, unknown>
    return route.fulfill({ response, json: { ...body, paused } })
  })
  await page.route(/\/api\/team\/(?:pause|resume)$/, (route) => {
    paused = route.request().url().endsWith('/pause')
    return route.fulfill({ json: { paused, affectedRuns: 1 } })
  })
}

async function expectReducedMotion(page: Page) {
  expect(
    await page.locator('[data-ui="bold"]').evaluate((root) => {
      root.insertAdjacentHTML('beforeend', '<span class="livedot" data-motion-probe></span>')
      const probe = root.querySelector<HTMLElement>('[data-motion-probe]')
      return probe ? getComputedStyle(probe).animationName : 'missing'
    }),
  ).toBe('none')
  expect(
    await page
      .locator('[data-ui="bold"]')
      .evaluate(
        (root) =>
          root
            .getAnimations({ subtree: true })
            .filter((animation) => animation.playState === 'running').length,
      ),
  ).toBe(0)
}

test.describe('bold Settings', () => {
  test.use({ reducedMotion: 'reduce' })

  for (const viewport of viewports) {
    test(`every classic Settings feature is reachable at ${viewport.width}×${viewport.height}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport)
      await allowNotifications(page)
      await mockRules(page)
      await pair(page)
      await page.goto('/b/settings')

      const nav = page.getByRole('navigation', { name: 'Settings' })
      await expect(nav.getByRole('button')).toHaveCount(10)
      for (const label of [
        'Connections',
        'Tools and triggers',
        'Rules',
        'Notifications',
        'Look',
        'Usage',
        'Remote access and security',
        'Advanced',
        'System',
      ])
        await expect(nav.getByRole('button', { name: new RegExp(`^${label}`) })).toBeVisible()

      // 11.9a: Connections, Tools and Look are real bold sections now.
      await page.goto('/b/settings/connections')
      await expect(page.getByRole('heading', { name: 'Connections', exact: true })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Hermes', exact: true })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Model providers' })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Channels' })).toBeVisible()
      await expectNoOverflow(page, 'Connections')

      await page.goto('/b/settings/tools')
      await expect(page.getByRole('heading', { name: 'Tools and triggers' })).toBeVisible()
      await expect(page.getByText('files', { exact: true })).toBeVisible()
      await expect(page.getByRole('form', { name: 'Add a tool server' })).toBeVisible()
      await expectNoOverflow(page, 'Tools and triggers')

      await page.goto('/b/settings/look')
      await expect(page.getByRole('heading', { name: 'Look', exact: true })).toBeVisible()
      await expect(page.getByRole('radiogroup', { name: 'Mode on this device' })).toBeVisible()
      await expect(page.getByRole('slider', { name: 'Text size' })).toBeVisible()
      await expectNoOverflow(page, 'Look')

      // Rules: guardian mode, the three lists, a diff, and the team-wide save.
      await page.goto('/b/settings/rules')
      const rulesRegion = page.getByRole('region', { name: 'Rules' })
      await expect(rulesRegion).toHaveAttribute('data-protected', 'block')
      await expect(rulesRegion.getByRole('radio', { name: 'Guardian first' })).toBeVisible()
      await expect(rulesRegion.getByRole('group', { name: 'Go ahead', exact: true })).toBeVisible()
      await expect(rulesRegion.getByRole('group', { name: 'Ask me', exact: true })).toBeVisible()
      await expect(rulesRegion.getByRole('group', { name: 'Never', exact: true })).toBeVisible()
      await rulesRegion.getByRole('radio', { name: /Always ask me/ }).click()
      await rulesRegion.getByRole('button', { name: 'Add a rule' }).click()
      const never = rulesRegion.getByRole('form', { name: 'Add a Never rule' })
      await never.getByLabel(/Never allow commands that match/).fill('rm   -rf /tmp/*')
      await never.getByRole('button', { name: 'Add to Never' }).click()
      await expect(rulesRegion.getByRole('group', { name: 'Never', exact: true })).toContainText(
        'rm -rf /tmp/*',
      )
      await rulesRegion.getByRole('button', { name: 'Review changes' }).click()
      await expect(rulesRegion.getByLabel('Changes', { exact: true })).toContainText(
        '+never: rm -rf /tmp/*',
      )
      const saveRules = rulesRegion.getByRole('button', { name: 'Save for the whole team' })
      await expectMinHeight(saveRules, viewport.width <= 640 ? 44 : 36)
      await expectMinHeight(
        rulesRegion.getByRole('button', { name: 'Discard' }),
        viewport.width <= 640 ? 44 : 36,
      )
      await saveRules.click()
      await expect(rulesRegion.getByText('Saved for the whole team.')).toBeVisible()
      await expectReducedMotion(page)
      await page.screenshot({
        path: testInfo.outputPath(`bold-settings-rules-${viewport.width}.png`),
        fullPage: true,
      })
      await expectNoOverflow(page, 'Rules')

      // Notifications: permission is requested only by the click; choices are real per-device prefs.
      await page.goto('/b/settings/notifications')
      const notifications = page.getByRole('region', { name: 'Notifications' })
      await notifications
        .getByRole('button', { name: 'Turn on notifications on this device' })
        .click()
      await expect(
        notifications.getByRole('button', { name: 'Turn off notifications on this device' }),
      ).toBeVisible()
      await notifications.getByRole('checkbox', { name: /A routine finished/ }).uncheck()
      await expect(
        notifications.getByRole('checkbox', { name: /A routine finished/ }),
      ).not.toBeChecked()
      await expect(
        notifications.getByRole('button', { name: 'Send a test notification' }),
      ).toBeVisible()
      await expectNoOverflow(page, 'Notifications')

      // Remote access and security: password, paired browsers, passkeys, terminal and Where agents run.
      let passwordSet = false
      await page.route(/\/api\/session\/security$/, (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            passwordSet,
            origins: ['http://127.0.0.1:5173'],
            terminal: false,
            terminalUnavailable: null,
          }),
        }),
      )
      await page.route(/\/api\/session\/passkeys$/, (route) =>
        route.fulfill({
          json: {
            available: true,
            rpId: 'localhost',
            items: [
              {
                id: 'passkey-phone',
                label: 'Phone',
                createdAt: '2026-10-01T10:00:00.000Z',
                lastUsedAt: null,
                flagged: false,
              },
            ],
          },
        }),
      )
      await page.goto('/b/settings/security')
      await expect(page.getByRole('heading', { name: 'Remote access and security' })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Where agents run' })).toBeVisible()
      await expect(page.getByText('Comes in 11.8a')).toBeVisible()
      await expect(page.getByRole('form', { name: 'Set a security password' })).toBeVisible()
      passwordSet = true
      await page.reload()
      const remote = page.getByRole('region', { name: 'Remote access and security' })
      await expect(remote).toHaveAttribute('data-protected', 'flex')
      await expect(remote.getByLabel('Security password', { exact: true })).toBeVisible()
      await expect(remote.getByRole('button', { name: 'Pair another device' })).toBeVisible()
      // Local mode: only remote pairings are listed, so the list explains itself.
      await expect(remote.getByText('No browser is paired for remote access yet.')).toBeVisible()
      await expect(remote.getByRole('heading', { name: 'Passkeys' })).toBeVisible()
      const signOut = remote.getByRole('button', { name: 'Log out this browser' })
      const removePasskey = remote.getByRole('button', { name: 'Remove passkey Phone' })
      await expect(signOut).toBeVisible()
      await expect(removePasskey).toBeVisible()
      await expectMinHeight(signOut, viewport.width <= 640 ? 44 : 36)
      await expectMinHeight(removePasskey, viewport.width <= 640 ? 44 : 36)
      await expect(page.getByRole('link', { name: 'Open the terminal' })).toHaveAttribute(
        'href',
        '/terminal',
      )
      await expectNoOverflow(page, 'Remote access and security')

      // Advanced: real search, staging and diff preview, without changing the shared fake server.
      await page.goto('/b/settings/advanced')
      const advanced = page.getByRole('region', { name: 'Advanced' })
      await advanced.getByRole('searchbox', { name: 'Search settings' }).fill('compact')
      await expect(advanced.getByText('display.compact')).toBeVisible()
      await advanced.getByRole('button', { name: 'Edit display.compact' }).click()
      await advanced.getByLabel('New value for display.compact').fill('true')
      await advanced.getByRole('button', { name: 'Add change' }).click()
      const pending = advanced.getByRole('group', { name: 'Pending changes' })
      await expect(pending).toContainText('display.compact = true')
      await pending.getByRole('button', { name: 'Preview' }).click()
      await expect(pending.getByLabel('Changes preview')).toContainText('+display.compact: true')
      const apply = pending.getByRole('button', { name: 'Apply' })
      await expect(apply).toBeEnabled()
      await expectMinHeight(apply, viewport.width <= 640 ? 44 : 36)
      await expectMinHeight(
        pending.getByRole('button', { name: 'Discard display.compact' }),
        viewport.width <= 640 ? 44 : 36,
      )
      await expectNoOverflow(page, 'Advanced')

      // System: service and update check, backup guidance, logs, Library access, Shares, terminal, pause.
      await mockLibrary(page)
      await mockTeamPause(page)
      await page.goto('/b/settings/system')
      await expect(page.getByRole('heading', { name: 'System', exact: true })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Score', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Check for updates' })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Backups' })).toBeVisible()
      await expect(page.getByText(/scripts\/score restore/)).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Logs', exact: true })).toBeVisible()
      await expect(page.getByText(/Versioned with git/)).toBeVisible()
      await expect(page.getByText('Agent writes today')).toBeVisible()
      await expect(page.getByText('builder')).toBeVisible()
      const library = page.getByRole('switch', { name: 'Agents can use Library' })
      await expect(library).not.toBeChecked()
      await library.click()
      await expect(library).toBeChecked()
      const memory = page.getByRole('switch', {
        name: 'Save compacted summaries as memory notes',
      })
      await expect(memory).toBeChecked()
      await memory.click()
      await expect(memory).not.toBeChecked()
      await expect(page.getByRole('link', { name: 'Open Library' })).toHaveAttribute(
        'href',
        '/knowledge',
      )
      await expect(page.getByRole('heading', { name: 'Shares', exact: true })).toBeVisible()
      await expect(page.getByRole('link', { name: 'Open the terminal' })).toHaveAttribute(
        'href',
        '/terminal',
      )
      const pause = page.locator('.system-pause')
      await expect(pause).toHaveAttribute('data-protected', 'flex')
      const pauseButton = pause.getByRole('button', { name: 'Pause everyone' })
      await expect(pauseButton).toBeVisible()
      await expectMinHeight(pauseButton, viewport.width <= 640 ? 44 : 36)
      await pauseButton.click()
      const resumeButton = pause.getByRole('button', { name: 'Resume everyone' })
      await expect(resumeButton).toBeVisible()
      await expectMinHeight(resumeButton, viewport.width <= 640 ? 44 : 36)
      await resumeButton.click()
      await expect(pause.getByRole('button', { name: 'Pause everyone' })).toBeVisible()
      await page.reload()
      await expect(page.getByRole('switch', { name: 'Agents can use Library' })).toBeChecked()
      await expect(
        page.getByRole('switch', { name: 'Save compacted summaries as memory notes' }),
      ).not.toBeChecked()
      await page.screenshot({
        path: testInfo.outputPath(`bold-settings-system-${viewport.width}.png`),
        fullPage: true,
      })
      await expectReducedMotion(page)
      await expectNoOverflow(page, 'System')

      // The web terminal page itself is reachable even when the server has it turned off.
      await page.getByRole('link', { name: 'Open the terminal' }).click()
      await expect(page).toHaveURL(/\/terminal$/)
      await expect(page.getByRole('heading', { name: 'Terminal', exact: true })).toBeVisible()
      await expect(page.getByText(/The terminal is off/)).toBeVisible()
    })
  }
})
