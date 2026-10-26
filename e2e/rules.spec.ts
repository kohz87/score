import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'

// The browser is paired (the shared session), and the writes are answered here so the shared fake server keeps its rules. Reads come from the fake server (real response shapes); the server side of every
// write, including the stricter-only rule, is covered by the server tests.
test('Settings rules: staged edit with a reviewed diff, then a stricter-only agent permission', async ({
  page,
}) => {
  const sent: { url: string; body: unknown }[] = []
  await page.route('**/api/settings/rules?dryRun=1', async (route) => {
    sent.push({ url: route.request().url(), body: route.request().postDataJSON() })
    await route.fulfill({ json: { preview: '+mode: manual\n+never: rm -rf /tmp/*' } })
  })
  await page.route('**/api/settings/rules', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback()
    sent.push({ url: route.request().url(), body: route.request().postDataJSON() })
    const response = await route.fetch({ method: 'GET' })
    await route.fulfill({
      json: { ...((await response.json()) as object), mode: 'manual', failed: [] },
    })
  })

  await pair(page)
  await page.goto('/b/settings/rules')
  const rules = page.getByRole('region', { name: 'Rules', exact: true })
  await expect(rules.getByRole('group', { name: 'Go ahead' })).toBeVisible()
  await expect(rules.getByRole('group', { name: 'Ask me', exact: true })).toContainText(
    'kinds of risky commands',
  )
  await expect(rules.getByRole('group', { name: 'Never' })).toBeVisible()
  await expect(rules.getByText(/asks you only when it is unsure/)).toBeVisible()
  await expect(rules.getByText(/guardrails, not a security boundary/)).toBeVisible()
  await expect(rules.getByText('Every agent follows the team rules.')).toBeVisible()

  await rules.getByRole('radio', { name: /Always ask me/ }).check()
  await rules.getByRole('button', { name: 'Add a rule' }).click()
  const never = rules.getByRole('form', { name: 'Add a Never rule' })
  await never.getByLabel(/Never allow commands that match/).fill('rm   -rf /tmp/*')
  await never.getByRole('button', { name: 'Add to Never' }).click()
  await expect(rules.getByRole('group', { name: 'Never' })).toContainText('rm -rf /tmp/*')
  await rules.getByRole('button', { name: 'Review changes' }).click()
  await expect(rules.getByLabel('Changes', { exact: true })).toContainText('+never: rm -rf /tmp/*')
  await rules.getByRole('button', { name: 'Save for the whole team' }).click()
  await expect(rules.getByText('Saved for the whole team.')).toBeVisible()
  expect(sent.at(-1)!.body).toEqual({ mode: 'manual', goAhead: [], never: ['rm -rf /tmp/*'] })

  // A single agent: only stricter choices exist; the server says no to anything else.
  await page.route('**/api/agents/builder/permissions/*', async (route) => {
    if (route.request().method() === 'DELETE') {
      sent.push({ url: route.request().url(), body: null })
      await route.fulfill({ json: { items: [] } })
      return
    }
    const level = (route.request().postDataJSON() as { level: string }).level
    if (level !== 'never') {
      await route.fulfill({
        status: 400,
        json: { error: { code: 'not_stricter', message: 'Only stricter' } },
      })
      return
    }
    sent.push({ url: route.request().url(), body: route.request().postDataJSON() })
    await route.fulfill({
      json: { id: 'never:git push*', label: 'git push*', level: 'never', inherited: false },
    })
  })
  // builder already carries its own Never, so the Use team rule control has a row to sit on.
  await page.route('**/api/agents/builder', async (route) => {
    const response = await route.fetch()
    const detail = (await response.json()) as { permissions: object[] }
    await route.fulfill({
      json: {
        ...detail,
        permissions: [
          ...detail.permissions,
          { id: 'never:rm -rf /tmp/*', label: 'rm -rf /tmp/*', level: 'never', inherited: false },
        ],
      },
    })
  })
  await page.goto('/b/team/builder')
  await page
    .getByRole('button', { name: 'More: memory, skills, tools, workspace, repeating jobs, delete' })
    .click()
  const panel = page.locator('#agent-permissions')
  await expect(panel.getByText(/looser isn’t/)).toBeVisible()
  await expect(panel.getByRole('button', { name: /^remove/i })).toHaveCount(0)
  await panel.getByLabel(/Never allow commands that match/).fill('git push*')
  await panel.getByRole('button', { name: 'Add', exact: true }).click()
  await expect
    .poll(() => decodeURIComponent(sent.at(-1)!.url))
    .toContain('permissions/never:git push*')
  await panel.getByRole('button', { name: 'Use team rule instead of: rm -rf /tmp/*' }).click()
  await expect
    .poll(() => decodeURIComponent(sent.at(-1)!.url))
    .toContain('permissions/never:rm -rf /tmp/*')
  expect(sent.at(-1)!.body).toBeNull()
  // A refetch can still be inside the route handler; without this the worker errors and skips the next test.
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})
