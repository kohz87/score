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
  test(`Team cards open the agent and More shows its compact cards at ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    await pair(page)

    await page.goto('/b/team')
    await expect(
      page.getByRole('heading', {
        name: viewport.width > 860 ? 'Your team' : 'Team',
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
    ).toHaveCount(20)
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
    await expect(open).toHaveAttribute('href', '/b/team/builder')

    await open.click()
    await expect(page).toHaveURL('/b/team/builder')
    await expect(page.getByRole('heading', { name: 'builder', level: 1 })).toBeVisible()
    await expect(page.getByText('How builder works')).toBeVisible()
    const where = page.getByRole('region', { name: 'Where it works' })
    await expect(where.getByText('This machine, as you')).toBeVisible()
    await expect(where.getByText('Not separated')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Message', exact: true })).toHaveAttribute(
      'href',
      '/b?with=builder',
    )
    await expect(page.getByRole('link', { name: 'Look at its screen' })).toHaveAttribute(
      'href',
      '/b/screen/builder',
    )
    await expect(page.getByRole('button', { name: 'Open builder in its own window' })).toHaveCount(
      0,
    )

    const toggle = page.getByRole('button', {
      name: 'More: memory, skills, tools, workspace, repeating jobs, delete',
    })
    await toggle.click()
    await expect(page.getByRole('navigation', { name: 'Agent settings sections' })).toHaveCount(0)
    const more = page.locator('#agent-more')
    for (const title of [
      'Remembers',
      'Skills',
      'Can use',
      'Workspace',
      'Repeating jobs',
      'Delete builder',
      'Plugins',
      'Channels',
      'Never rules',
      'Looks',
      'Name and role',
      'Recent runs',
      'Todo',
    ]) {
      await expect(more.getByRole('heading', { name: title, level: 3 })).toBeVisible()
    }
    // No classic Team editor is left under More.
    await expect(more.locator('.team-card')).toHaveCount(0)

    // Add a memory and forget it again.
    const text = `Check the feed twice ${viewport.width}`
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

    // Delete opens the same Remove panel as the header button; nothing is removed.
    await more.locator('#agent-delete').getByRole('button', { name: 'Delete agent' }).click()
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
        .locator('.bold-more-grid')
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

    await page.goto(`/b/team/${id}`)
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

    await page.getByRole('button', { name: /^More: tools, workspace, delete/ }).click()
    await expect(page.getByRole('navigation', { name: 'Agent settings sections' })).toHaveCount(0)
    const more = page.locator('#agent-more')
    for (const title of [
      'Can use',
      'Workspace',
      'Recent runs',
      'Looks',
      'Name and role',
      `Delete ${id}`,
    ])
      await expect(more.getByRole('heading', { name: title, level: 3 })).toBeVisible()
    await expect(more.getByRole('heading', { name: 'Remembers' })).toHaveCount(0)
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
  await page.goto('/b/team/designer')
  const where = page.getByRole('region', { name: 'Where it works' })
  // The fake designer runs in Docker.
  await expect(where.getByText('Partly separated')).toBeVisible()
  await expect(where.getByText(/Still on this machine as you:.*MCP servers/u)).toBeVisible()
  await expect(where).toHaveAttribute('data-protected', 'block')
  await where.getByRole('button', { name: 'Change where it works' }).click()
  await where.getByRole('radio', { name: 'This machine' }).click()
  await where.getByRole('button', { name: 'Save' }).click()
  await expect(where.getByText('Not separated')).toBeVisible()
  await expect(where.getByText('This machine, as you')).toBeVisible()
  // Put it back for other specs sharing the fake server.
  await where.getByRole('button', { name: 'Change where it works' }).click()
  await where.getByRole('radio', { name: 'Docker' }).click()
  await where.getByRole('button', { name: 'Save' }).click()
  await expect(where.getByText('Partly separated')).toBeVisible()
})
