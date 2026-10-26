import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'

// PLAN 10.1, on the bold shell: Settings is one page per section, with the section list as real navigation. The
// section list is the nine sections of the bold frame (decision 131/132 retired the eleven classic ones).
const sections = [
  { id: 'connections', label: 'Connections', heading: 'Connections' },
  { id: 'tools', label: 'Tools and triggers', heading: 'Tools and triggers' },
  { id: 'rules', label: 'Rules', heading: 'Rules' },
  { id: 'notifications', label: 'Notifications', heading: 'Notifications' },
  { id: 'look', label: 'Look', heading: 'Look' },
  { id: 'usage', label: 'Usage', heading: 'Usage' },
  { id: 'security', label: 'Remote access and security', heading: 'Remote access and security' },
  { id: 'advanced', label: 'Advanced', heading: 'Advanced' },
  { id: 'system', label: 'System', heading: 'System' },
] as const

const sectionNav = (page: Page) => page.getByRole('navigation', { name: 'Settings', exact: true })
const entry = (page: Page, label: string) =>
  sectionNav(page).getByRole('button', { name: new RegExp(`^${label}`) })
const heading = (page: Page, name: string) =>
  page.getByRole('heading', { level: 2, name, exact: true })

test('/b/settings opens a section and every section is a page of its own', async ({ page }) => {
  await pair(page)
  await page.goto('/b/settings')
  const nav = sectionNav(page)
  await expect(nav.getByRole('button')).toHaveCount(sections.length)
  // The default section is Usage.
  await expect(entry(page, 'Usage')).toHaveAttribute('aria-current', 'page')
  for (const section of sections) {
    await entry(page, section.label).click()
    await expect(page).toHaveURL(new RegExp(`/b/settings/${section.id}$`))
    await expect(heading(page, section.heading)).toBeVisible()
    await expect(entry(page, section.label)).toHaveAttribute('aria-current', 'page')
    await expect(nav.locator('button[aria-current="page"]')).toHaveCount(1)
    // Only this section's content is on the page.
    for (const other of sections.filter((item) => item.id !== section.id))
      await expect(heading(page, other.heading)).toHaveCount(0)
    expect(await page.evaluate(() => window.scrollY)).toBe(0)
  }
})

test('the section list works from the keyboard', async ({ page }) => {
  await pair(page)
  await page.goto('/b/settings/connections')
  await expect(heading(page, 'Connections')).toBeVisible()
  const system = entry(page, 'System')
  await system.focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/b\/settings\/system$/)
  await expect(heading(page, 'System')).toBeVisible()
  await expect(system).toHaveAttribute('aria-current', 'page')
  // Space works too, like any button.
  const rules = entry(page, 'Rules')
  await rules.focus()
  await page.keyboard.press('Space')
  await expect(page).toHaveURL(/\/b\/settings\/rules$/)
})

test('the old /settings links land on the page and keep the query', async ({ page }) => {
  await pair(page)
  await page.goto('/settings')
  await expect(page).toHaveURL(/\/b\/settings$/)
  await page.goto('/settings/look?look=safe')
  await expect(page).toHaveURL(/\/b\/settings\/look\?look=safe$/)
  await expect(page.locator('.look-banner')).toContainText('Safe look')
  await expect(heading(page, 'Look')).toBeVisible()
  // Not a section: Usage, the default one.
  await page.goto('/settings/nope')
  await expect(page).toHaveURL(/\/b\/settings\/usage$/)
  await expect(heading(page, 'Usage')).toBeVisible()
  // An old classic section id is not a section either; it never shows an empty page.
  await page.goto('/settings/logs')
  await expect(page).toHaveURL(/\/b\/settings\/usage$/)
})

test('back and forward move between sections', async ({ page }) => {
  await pair(page)
  await page.goto('/b/settings')
  await entry(page, 'Connections').click()
  await entry(page, 'System').click()
  await expect(page).toHaveURL(/\/b\/settings\/system$/)
  await page.goBack()
  await expect(page).toHaveURL(/\/b\/settings\/connections$/)
  await expect(heading(page, 'Connections')).toBeVisible()
  await expect(entry(page, 'Connections')).toHaveAttribute('aria-current', 'page')
  await page.goBack()
  await expect(page).toHaveURL(/\/b\/settings$/)
  await page.goForward()
  await page.goForward()
  await expect(page).toHaveURL(/\/b\/settings\/system$/)
  await expect(heading(page, 'System')).toBeVisible()
})

test('on a phone the section list shows the current section and navigates', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await pair(page)
  await page.goto('/b/settings/connections')
  await expect(entry(page, 'Connections')).toHaveAttribute('aria-current', 'page')
  await entry(page, 'System').click()
  await expect(page).toHaveURL(/\/b\/settings\/system$/)
  await expect(entry(page, 'System')).toHaveAttribute('aria-current', 'page')
  await expect(heading(page, 'System')).toBeVisible()
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0)
})

test('the palette lists each Settings section', async ({ page }) => {
  await pair(page)
  for (const section of sections) {
    await page.goto('/b')
    await expect(page.locator('[data-ui="bold"]')).toBeVisible()
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Search and commands' })
    await dialog
      .getByRole('combobox', { name: 'Search or run a command' })
      .fill(`Settings: ${section.label}`)
    await dialog.getByRole('option', { name: `Settings: ${section.label}`, exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/b/settings/${section.id}$`))
  }
})
