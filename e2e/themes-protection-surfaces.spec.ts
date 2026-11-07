import { expect, test } from '@playwright/test'
import { holdLockPerTest } from './locks.ts'
import { settle, unreadable, wear } from './themes-protection-helpers.ts'

test.describe('every decision surface is protected, not only the approval card', () => {
  holdLockPerTest('roster')

  test('#2: the add-coding-agent form keeps its permission controls, warning and password field', async ({
    page,
  }) => {
    await wear(
      page,
      '.team-coding-permission, .coding-reach, .coding-acknowledge { display: none; }' +
        '[role=dialog] fieldset, [role=dialog] legend, [role=dialog] [role=alert], [role=dialog] [role=note] { display: none; }' +
        '[role=dialog] input[type=password], [role=dialog] input[type=radio] { opacity: 0; }' +
        '[role=dialog] label { visibility: hidden; color: transparent; }',
    )
    await page.goto('/b/agents?add=agent')
    const dialog = page.getByRole('dialog', { name: 'Add an agent' })
    await dialog.getByRole('radio', { name: /A coding tool/ }).check()
    await dialog.getByRole('radio', { name: 'Codex' }).check()
    await dialog.getByRole('radio', { name: /Full access/ }).check()
    await settle(page)
    const permission = dialog.getByRole('group', { name: 'Permission' })
    await expect(permission).toBeVisible()
    await expect(permission.getByRole('radio', { name: /Workspace write/ })).toBeVisible()
    await expect(permission.getByRole('alert')).toContainText(
      'Full access turns the CLI’s own sandbox off',
    )
    await expect(dialog.getByLabel('Security password')).toBeVisible()
    expect(await unreadable(permission)).toEqual([])
    expect(await unreadable(dialog.locator('label', { hasText: 'Security password' }))).toEqual([])
    await expect(dialog.getByRole('note').first()).toBeVisible()
    await expect(dialog.locator('label.coding-acknowledge')).toBeVisible()
  })
})
