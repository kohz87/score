import { expect, test } from '@playwright/test'
import { holdLockPerTest } from './locks.ts'
import { pair } from './pair.ts'

// PLAN 11.8b: Team and one agent on the bold shell. The fake adapter supplies the roster; coding agents are created
// through the same API the classic page uses, with the fake CLI from playwright.config.ts (no model is called).
test.use({ reducedMotion: 'reduce' })
holdLockPerTest('roster')

const sizes = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const

for (const viewport of sizes) {
  test(`Team cards open the agent and its sections show every card at ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    await pair(page)

    await page.goto('/b/agents')
    await expect(
      page.getByRole('heading', {
        name: 'Agents',
        level: 1,
      }),
    ).toBeVisible()
    const add = page.getByRole('button', {
      name: viewport.width > 860 ? 'Add an agent' : 'Add',
    })
    await expect(add).toBeEnabled()
    await add.click()
    const addDialog = page.getByRole('dialog', { name: 'Add an agent' })
    await expect(addDialog.getByText('New agent', { exact: true })).toBeVisible()
    await expect(
      addDialog.getByRole('radiogroup', { name: 'Shape' }).getByRole('radio'),
    ).toHaveCount(22)
    await addDialog.getByRole('button', { name: 'Close' }).click()
    await expect(addDialog).toHaveCount(0)
    await expect(page.locator('.bold-agentcard')).toHaveCount(4)

    const builder = page
      .locator('.bold-agentcard')
      .filter({ has: page.getByRole('link', { name: 'builder', exact: true }) })
    // The fake demo moves on over time, so the state line is checked by shape, not by the moment's task.
    await expect(builder.locator('.bold-agentcard-state')).toHaveText(
      /^[A-Z][a-z]+( [a-z]+)?( · .+)?$/u,
    )
    await expect(builder.getByRole('link', { name: 'Message', exact: true })).toHaveAttribute(
      'href',
      '/b?with=builder',
    )
    // The phone card keeps only Message; the agent's name opens its page there (board 20).
    const open = builder.getByRole('link', {
      name: viewport.width > 860 ? 'Open' : 'builder',
      exact: true,
    })
    await expect(open).toHaveAttribute('href', '/b/agents/builder')

    await open.click()
    await expect(page).toHaveURL('/b/agents/builder')
    await expect(page.getByRole('heading', { name: 'builder', level: 1 })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Personality', level: 2 })).toBeVisible()
    // The Safety tile states where it runs in one line; its full card opens in place.
    const where = page.getByRole('region', { name: 'Where it works' })
    await expect(where.getByText(/This machine, as you · Not separated/)).toBeVisible()
    await expect(page.getByRole('link', { name: 'Message', exact: true })).toHaveAttribute(
      'href',
      '/b?with=builder',
    )
    await page.getByRole('button', { name: 'More actions' }).click()
    await expect(page.getByRole('menuitem', { name: 'Look at its screen' })).toHaveAttribute(
      'href',
      '/b/screen/builder',
    )
    await expect(page.getByRole('button', { name: 'Open builder in its own window' })).toHaveCount(
      0,
    )

    await page.keyboard.press('Escape')
    await expect(page.getByRole('navigation', { name: 'Agent settings sections' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^More: / })).toHaveCount(0)
    const more = page.locator('.bold-agent-sections')
    for (const title of [
      'Remembers',
      'Skills',
      'Can use',
      'Assigned',
      'Plugins',
      'Reachable on',
      'Never rules',
      'Recent runs',
      'Todo',
    ]) {
      await expect(more.getByRole('heading', { name: title, level: 3 })).toBeVisible()
    }
    // The workspace is shown in the chat, not here.
    await expect(more.getByRole('heading', { name: 'Workspace', level: 3 })).toHaveCount(0)
    // Edit holds the name, role and look.
    await page.getByRole('button', { name: 'Change name, role and look' }).click()
    for (const title of ['Looks', 'Name and role'])
      await expect(page.getByRole('heading', { name: title, level: 3 })).toBeVisible()
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    // No classic Team editor is left in the sections below Personality.
    await expect(
      page.locator('#agent-section-tools, #agent-work, #agent-memory-skills').locator('.team-card'),
    ).toHaveCount(0)

    // Add a memory and forget it again.
    const text = `Check the feed twice ${viewport.width}`
    await page.getByRole('button', { name: 'Open memory' }).click()
    const remembers = more.locator('#agent-memory')
    await remembers.getByLabel('New memory').fill(text)
    await remembers.getByRole('button', { name: 'Add' }).click()
    const added = remembers.locator('.listrow', { hasText: text })
    await expect(added).toBeVisible()
    await added.getByRole('button', { name: /^Forget:/ }).click()
    await expect(added).toHaveCount(0)

    // Switch a tool off and on again.
    const tool = more.locator('#agent-tools').getByRole('checkbox').first()
    const was = await tool.isChecked()
    await tool.click()
    await expect(tool).toBeChecked({ checked: !was })
    await tool.click()
    await expect(tool).toBeChecked({ checked: was })

    // The menu's Remove opens the Remove panel; nothing is removed.
    await page
      .getByRole('navigation', { name: 'Sections' })
      .getByRole('button', { name: 'Remove builder' })
      .click()
    const panel = page.getByRole('group', { name: 'Remove builder' })
    await expect(panel).toBeVisible()
    await panel.getByRole('button', { name: 'Cancel' }).click()
    await expect(panel).toHaveCount(0)

    // The cards never push the page sideways.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)
    if (viewport.width < 500) {
      const columns = await more
        .locator('#agent-safety .bold-agent-tiles')
        .evaluate((grid) => getComputedStyle(grid).gridTemplateColumns.split(' ').length)
      expect(columns).toBe(1)
    }

    const running = await page
      .locator('[data-ui="bold"]')
      .evaluate(
        (root) =>
          root
            .getAnimations({ subtree: true })
            .filter((animation) => animation.playState === 'running').length,
      )
    expect(running).toBe(0)
  })
}

test('a coding agent keeps permission, quota floor, password and the protected Codex note on the same page', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await pair(page)
  const id = `bold-coder-${Date.now().toString(36)}`
  let created = false

  try {
    await page.evaluate(async (agentId) => {
      const response = await fetch('/api/coding-agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Score-Client': 'web' },
        body: JSON.stringify({
          id: agentId,
          name: agentId,
          role: 'Checks the build scripts',
          runtime: 'codex',
          permission: 'workspace-write',
          style: { color: '#6B4EFF', shape: 'hexagon' },
          acknowledgeReads: true,
        }),
      })
      if (!response.ok) throw new Error(await response.text())
    }, id)
    created = true

    await page.goto(`/b/agents/${id}`)
    await expect(page.getByRole('heading', { name: id, level: 1 })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Access', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Limits left' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Codex read access' })).toHaveCount(0)
    await expect(
      page.getByRole('note').filter({ hasText: 'Codex can read every file your user can' }),
    ).toHaveAttribute('data-protected', 'any')
    await expect(page.getByText(/below 10% of a limit left/)).toBeVisible()

    await page.getByRole('button', { name: 'Change access' }).click()
    await page.getByRole('radio', { name: /Full access/ }).check()
    await expect(page.getByLabel('Security password')).toBeVisible()
    await page.getByRole('button', { name: 'Cancel' }).click()

    await expect(page.getByRole('navigation', { name: 'Agent settings sections' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^More: / })).toHaveCount(0)
    const more = page.locator('.bold-agent-sections')
    for (const title of ['Can use', 'Recent runs'])
      await expect(more.getByRole('heading', { name: title, level: 3 })).toBeVisible()
    await expect(more.getByRole('heading', { name: 'Workspace' })).toHaveCount(0)
    await expect(more.getByRole('heading', { name: 'Remembers' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Change name, role and look' }).click()
    for (const title of ['Looks', 'Name and role'])
      await expect(page.getByRole('heading', { name: title, level: 3 })).toBeVisible()
    await expect(
      page
        .getByRole('navigation', { name: 'Sections' })
        .getByRole('button', { name: `Remove ${id}` }),
    ).toBeVisible()
  } finally {
    if (created) {
      await page.evaluate(async (agentId) => {
        await fetch(`/api/coding-agents/${encodeURIComponent(agentId)}`, {
          method: 'DELETE',
          headers: { 'X-Score-Client': 'web' },
        })
      }, id)
    }
  }
})

test('Where it works: Docker is partly separated and lists what stays on this machine; back to this machine', async ({
  page,
}) => {
  await pair(page)
  await page.goto('/b/agents/designer')
  const tile = page.getByRole('region', { name: 'Where it works' })
  // The fake designer runs in Docker: the tile says so in one line, and its action opens the full card in place.
  await expect(tile.getByText(/Partly separated/)).toBeVisible()
  await expect(tile).toHaveAttribute('data-protected', 'block')
  await tile.getByRole('button', { name: 'Change where it works' }).click()
  const where = page.getByRole('region', { name: 'Where it works' })
  await expect(where.getByText(/Still on this machine as you:.*MCP servers/u)).toBeVisible()
  await expect(where).toHaveAttribute('data-protected', 'block')
  await where.getByRole('button', { name: 'Change where it works' }).click()
  await where.getByRole('radio', { name: 'This machine' }).click()
  await where.getByRole('button', { name: 'Save' }).click()
  await expect(where.getByText('Not separated', { exact: true })).toBeVisible()
  await expect(where.getByText('This machine, as you', { exact: true })).toBeVisible()
  // Put it back for other specs sharing the fake server.
  await where.getByRole('button', { name: 'Change where it works' }).click()
  await where.getByRole('radio', { name: 'Docker' }).click()
  await where.getByRole('button', { name: 'Save' }).click()
  await expect(where.getByText('Partly separated')).toBeVisible()
})
