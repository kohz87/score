import { expect, test, type Page } from '@playwright/test'
import { ACCEPTED_TOKEN, custom, drawn, expectRefused, wear } from './themes-consent-helpers.ts'

// ---------------------------------------------------------------------------------------------------------------------
// MCP access

test.describe('X1: MCP read and write access is one decision', () => {
  async function mcpSection(page: Page) {
    const sent: string[] = []
    await page.route('**/api/agents/lead/mcp', async (route) => {
      if (route.request().method() !== 'PUT') return route.fallback()
      sent.push(route.request().url())
      await route.abort()
    })
    await page.goto('/b/agents/lead')
    const section = page.locator('#agent-score-access')
    await expect(section).toBeVisible()
    await expect(section).toHaveAttribute('data-protected', 'flex')
    await custom(page)
    return { section, sent }
  }

  test('accepted theme CSS cannot hide the read and write switches or what they mean', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await wear(
      page,
      `${ACCEPTED_TOKEN}\n.bold-mc { opacity: 0; color: transparent; }\n.bold-mc .small { opacity: 0; }\n.bold-mc .check { opacity: 0; color: transparent; }\n#agent-score-access { opacity: 0; }`,
    )
    const { section } = await mcpSection(page)
    await drawn(section.getByText('Write too', { exact: false }).first())
    await drawn(section.getByText('Lets lead use Score’s rooms', { exact: false }))
    await drawn(section.getByRole('checkbox', { name: /Read rooms, tasks and notes/ }))
    await drawn(section.getByRole('checkbox', { name: /Write too/ }))
    await custom(page)
  })

  test('a section whose words were made unreadable refuses the click on a switch and sends nothing', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await wear(page)
    const { section, sent } = await mcpSection(page)
    await expect(section.getByRole('checkbox').first()).toBeVisible()
    await page.evaluate(() => {
      document.adoptedStyleSheets
        .at(-1)!
        .insertRule('#agent-score-access, #agent-score-access * { color: transparent !important; }')
      document
        .querySelector<HTMLInputElement>('#agent-score-access input[type="checkbox"]')!
        .click()
    })
    await expectRefused(page, sent)
  })
})
