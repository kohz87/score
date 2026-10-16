import { expect, test, type Locator, type Page } from '@playwright/test'
import { pair } from './pair.ts'

// A long agent description (coding agents often have one) stays on one line in the Now lanes and the @mention menu,
// with the full text on hover; it used to wrap over the next lanes and options (owner report, 2026-10-16).
const role =
  'Example builder. Implements changes in its workspace on the agent branch, following AGENTS.md and CLAUDE.md; ' +
  'hands finished work to the reviewer, which reads the diff against main and checks correctness, security and tests.'

async function api(page: Page, path: string, body: object): Promise<unknown> {
  return page.evaluate(
    async ([url, payload]) => {
      const response = await fetch(url as string, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Score-Client': 'web' },
        body: JSON.stringify(payload),
      })
      return response.json()
    },
    [`/api/${path}`, body],
  )
}

async function cutToOneLine(text: Locator): Promise<void> {
  await expect(text).toHaveAttribute('title', role)
  const box = await text.evaluate((element) => ({
    cut: element.scrollWidth > element.clientWidth,
    lines:
      element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight),
  }))
  expect(box.cut).toBe(true)
  expect(box.lines).toBeLessThan(1.5)
}

test('a long agent description stays on one line in Now and in the @mention menu', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const suffix = Date.now().toString(36)
  const id = `long-${suffix}`
  await pair(page)
  expect(
    await api(page, 'coding-agents', {
      id,
      name: id,
      role,
      runtime: 'claude-code',
      style: { color: '#19C39A', shape: 'triangle' },
      permission: 'read-only',
    }),
  ).toMatchObject({ id })

  await page.goto('/now')
  const lane = page.locator('.now-lane-label').filter({ hasText: id })
  await expect(lane).toBeVisible({ timeout: 15_000 })
  await cutToOneLine(lane.locator('.now-lane-role').first())
  const laneBox = await lane.boundingBox()
  expect(laneBox?.height).toBe(76)

  await api(page, 'rooms', { name: `desc-${suffix}`, leadAgentId: 'lead' })
  await page.goto('/chat')
  await page
    .getByRole('navigation', { name: 'Rooms' })
    .getByRole('link', { name: new RegExp(`desc-${suffix}`) })
    .click({ timeout: 15_000 })
  const composer = page.getByRole('combobox', { name: /^Message/ })
  await composer.fill(`@long-${suffix.slice(0, 3)}`)
  const option = page
    .getByRole('listbox', { name: 'Agents' })
    .getByRole('option', { name: new RegExp(id) })
  await expect(option).toBeVisible()
  await expect(option.locator('.chat-menu-command')).toHaveText(`@${id}`)
  await cutToOneLine(option.locator('.chat-menu-detail'))
})
