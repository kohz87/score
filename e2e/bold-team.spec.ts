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

const sections = [
  ['Overview', 'agent-overview'],
  ['Personality', 'agent-personality'],
  ['Model', 'agent-model'],
  ['Skills', 'agent-skills'],
  ['Memory', 'agent-memory'],
  ['Tools', 'agent-tools'],
  ['Plugins', 'agent-plugins'],
  ['Workspace', 'agent-workspace'],
  ['Routines', 'agent-routines'],
  ['Channels', 'agent-channels'],
  ['Permissions', 'agent-permissions'],
  ['History', 'agent-history'],
  ['Appearance', 'agent-appearance'],
  ['Todo', 'agent-todo'],
  ['Details', 'agent-details'],
] as const

for (const viewport of sizes) {
  test(`Team cards open the agent and every classic tab is reachable at ${viewport.width}×${viewport.height}`, async ({
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
    await expect(page.getByRole('button', { name: 'Open builder in its own window' })).toBeVisible()

    await page.getByRole('button', { name: /^More: memory/ }).click()
    const nav = page.getByRole('navigation', { name: 'Agent settings sections' })
    await expect(nav.getByRole('link')).toHaveCount(sections.length)
    for (const [name, id] of sections) {
      await nav.getByRole('link', { name, exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`#${id}$`))
      const section = page.locator(`#${id}`)
      await expect(section).toBeVisible()
      if (name === 'Overview') {
        await expect(section.getByRole('heading', { name: 'builder', level: 1 })).toBeVisible()
      } else if (name === 'Personality') {
        await expect(section.getByRole('textbox', { name: 'SOUL.md contents' })).toBeVisible()
      } else if (name === 'Appearance') {
        await section.getByRole('button', { name: /Change builder.s look/ }).click()
        const dialog = page.getByRole('dialog', { name: 'Agent appearance' })
        await expect(dialog.getByRole('heading', { name: 'Pet pack' })).toBeVisible()
        await dialog.getByRole('button', { name: 'Cancel' }).click()
        await expect(dialog).toHaveCount(0)
      } else if (name === 'Todo') {
        await expect(section.getByRole('heading', { name: 'Todo' })).toBeVisible()
      } else if (name === 'Details') {
        await expect(section.getByRole('heading', { name: 'Agent details' })).toBeVisible()
        await expect(section.getByRole('heading', { name: 'Danger zone' })).toBeVisible()
        const remove = section.getByRole('button', { name: 'Delete agent' })
        await remove.click()
        await expect(section.getByRole('heading', { name: 'Review deletion' })).toBeVisible()
        await expect(section.getByLabel('Type builder to confirm')).toBeVisible()
        await section.getByRole('button', { name: 'Cancel' }).click()
        await expect(section.getByRole('heading', { name: 'Review deletion' })).toHaveCount(0)
        await expect(remove).toBeVisible()
      } else {
        await expect(section.getByRole('heading', { name, level: 2, exact: true })).toBeVisible()
      }
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
    const nav = page.getByRole('navigation', { name: 'Agent settings sections' })
    await expect(nav.getByRole('link')).toHaveCount(4)
    for (const [tab, sectionId] of [
      ['Overview', 'agent-overview'],
      ['Workspace', 'agent-workspace'],
      ['History', 'agent-history'],
      ['Appearance', 'agent-appearance'],
    ] as const) {
      await nav.getByRole('link', { name: tab, exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`#${sectionId}$`))
      if (tab === 'Overview') await expect(page.locator('#agent-title')).toHaveText(id)
      else
        await expect(
          page.locator(`#${sectionId}`).getByRole('heading', { name: tab }),
        ).toBeVisible()
    }
    await expect(nav.getByRole('link', { name: 'Memory' })).toHaveCount(0)
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
