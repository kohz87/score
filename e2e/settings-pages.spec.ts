import { expect, test } from '@playwright/test'

// PLAN 10.1: Settings is one page per section, with the section list as real navigation.
const sections = [
  { id: 'models', label: 'Models and keys', heading: 'Models and keys' },
  { id: 'connections', label: 'Connections', heading: 'Connections' },
  { id: 'rules', label: 'Rules and approvals', heading: 'Rules and approvals' },
  { id: 'look', label: 'Look', heading: 'Look' },
  { id: 'notifications', label: 'Notifications', heading: 'Notifications' },
  { id: 'knowledge', label: 'Knowledge', heading: 'Knowledge' },
  { id: 'shares', label: 'Shares', heading: 'Shares' },
  { id: 'advanced', label: 'Advanced', heading: 'Advanced' },
  { id: 'backup', label: 'Backup', heading: 'Backup and restore' },
  { id: 'logs', label: 'Logs', heading: 'Logs' },
  { id: 'about', label: 'About', heading: 'About Score' },
] as const

const sectionNav = (page: import('@playwright/test').Page) =>
  page.getByRole('navigation', { name: 'Settings sections' })

test('/settings opens the first section and every section is a page of its own', async ({
  page,
}) => {
  await page.goto('/settings')
  await expect(page).toHaveURL(/\/settings\/models$/)
  const nav = sectionNav(page)
  await expect(nav.getByRole('link')).toHaveCount(sections.length)
  for (const section of sections) {
    await nav.getByRole('link', { name: section.label, exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/settings/${section.id}$`))
    const heading = page.getByRole('heading', { level: 2, name: section.heading, exact: true })
    await expect(heading).toBeVisible()
    await expect(nav.getByRole('link', { name: section.label, exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await expect(nav.locator('a[aria-current="page"]')).toHaveCount(1)
    // Only this section's cards are on the page, and focus is on its heading.
    await expect(page.locator('.settings-content > section.settings-card h2')).not.toHaveCount(0)
    for (const other of sections.filter((entry) => entry.id !== section.id))
      await expect(
        page.getByRole('heading', { level: 2, name: other.heading, exact: true }),
      ).toHaveCount(0)
    // Moving to another section lands on its heading (the first section is already where the redirect put us).
    if (section.id !== 'models') await expect(heading).toBeFocused()
    await expect(page).toHaveTitle(`${section.label} · Settings · Score`)
    expect(await page.evaluate(() => window.scrollY)).toBe(0)
  }
})

test('the section list works from the keyboard', async ({ page }) => {
  await page.goto('/settings/models')
  await expect(page.getByRole('heading', { level: 2, name: 'Models and keys' })).toBeVisible()
  const logs = sectionNav(page).getByRole('link', { name: 'Logs', exact: true })
  await logs.focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/settings\/logs$/)
  await expect(page.getByRole('heading', { level: 2, name: 'Logs', exact: true })).toBeFocused()
  // Tab goes on from the heading into the new content, not back to the list.
  await page.keyboard.press('Tab')
  expect(await page.evaluate(() => !!document.activeElement?.closest('.settings-content'))).toBe(
    true,
  )
})

test('the old /settings#<id> links land on the page and keep the query', async ({ page }) => {
  await page.goto('/settings#logs')
  await expect(page).toHaveURL(/\/settings\/logs$/)
  await expect(page.getByRole('heading', { level: 2, name: 'Logs', exact: true })).toBeVisible()
  await page.goto('/settings?look=safe#look')
  await expect(page).toHaveURL(/\/settings\/look\?look=safe$/)
  await expect(page.locator('.look-banner')).toContainText('Safe look')
  await expect(page.getByRole('region', { name: 'Look' })).toBeVisible()
  // Not a section: the first one.
  await page.goto('/settings/nope')
  await expect(page).toHaveURL(/\/settings\/models$/)
  await page.goto('/settings#nope')
  await expect(page).toHaveURL(/\/settings\/models$/)
})

test('back and forward move between sections', async ({ page }) => {
  await page.goto('/settings')
  const nav = sectionNav(page)
  await nav.getByRole('link', { name: 'Connections', exact: true }).click()
  await nav.getByRole('link', { name: 'About', exact: true }).click()
  await expect(page).toHaveURL(/\/settings\/about$/)
  await page.goBack()
  await expect(page).toHaveURL(/\/settings\/connections$/)
  await expect(page.getByRole('heading', { level: 2, name: 'Connections' })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Connections', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  )
  await page.goBack()
  await expect(page).toHaveURL(/\/settings\/models$/)
  // The redirect from /settings replaced its entry: one more step back leaves Settings.
  await page.goForward()
  await page.goForward()
  await expect(page).toHaveURL(/\/settings\/about$/)
  await expect(page.getByRole('heading', { level: 2, name: 'About Score' })).toBeVisible()
})

test('on a phone the Section picker shows the current section and navigates', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/settings/connections')
  const picker = page.getByRole('button', { name: /^Section/ })
  await expect(picker).toContainText('Connections')
  await picker.click()
  await expect(
    page.locator('#settings-jump-list').getByRole('link', { name: 'Connections', exact: true }),
  ).toHaveAttribute('aria-current', 'page')
  await page.locator('#settings-jump-list').getByRole('link', { name: 'Logs', exact: true }).click()
  await expect(page).toHaveURL(/\/settings\/logs$/)
  await expect(picker).toContainText('Logs')
  await expect(picker).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('heading', { level: 2, name: 'Logs', exact: true })).toBeFocused()
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
})

test('the palette lists each Settings section', async ({ page }) => {
  await page.goto('/now')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await page.keyboard.press('Control+k')
  const dialog = page.getByRole('dialog', { name: 'Search or run a command' })
  await dialog.getByRole('searchbox').fill('Settings: Logs')
  await dialog.getByRole('searchbox').press('Enter')
  await expect(page).toHaveURL(/\/settings\/logs$/)
})
