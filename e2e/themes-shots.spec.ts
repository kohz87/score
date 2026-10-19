import { expect, test } from '@playwright/test'
import { hostileCss, hostileManifest, mockThemes, tidyTheme } from './themes-fixtures.ts'
import { pair } from './pair.ts'
import { makeRoom, say } from './rooms.ts'

// Screenshots for the 9.2 review (fake mode, mocked themes). Only runs when SCORE_UI_SHOTS_DIR names a folder.
const dir = process.env.SCORE_UI_SHOTS_DIR
test.skip(!dir, 'set SCORE_UI_SHOTS_DIR to take the review screenshots')
test.use({ viewport: { width: 1280, height: 900 } })

test('look, hostile and safe screenshots', async ({ page }) => {
  const look = { active: 'tidy', mode: 'light' as const }
  await mockThemes(
    page,
    [tidyTheme, { id: 'hostile', name: 'Hostile', manifest: hostileManifest, css: hostileCss }],
    look,
  )
  await pair(page)
  await page.goto('/settings/look')
  await page.getByRole('region', { name: 'Look' }).scrollIntoViewIfNeeded()
  await expect(page.getByRole('radiogroup', { name: 'Style' })).toBeVisible()
  await page.getByRole('region', { name: 'Look' }).screenshot({ path: `${dir}/look.png` })

  look.active = 'hostile'
  const room = await makeRoom(page, 'shot')
  await say(page, room.id, `Please ask for approval before installing ${Date.now()}`)
  await page.goto(`/chat/${room.id}`)
  const card = page.getByRole('group', { name: /^Approval: / }).last()
  await expect(card.getByRole('button', { name: 'Approve' })).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
  await page.screenshot({ path: `${dir}/hostile.png` })
  await card.getByRole('button', { name: 'Approve' }).click()
  await expect(card.getByText('Approved by you')).toBeVisible({ timeout: 15_000 })

  await page.goto('/settings?look=safe')
  await expect(page.locator('.look-banner')).toBeVisible()
  await page.screenshot({ path: `${dir}/safe.png` })
})
