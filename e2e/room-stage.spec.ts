import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'
import { makeRoom } from './rooms.ts'

// PLAN 10.10 (decision 110): the room stage under a chat room's title.
const member = (page: Page, name: string) =>
  page
    .getByRole('group', { name: 'Room members' })
    .getByRole('button', { name: new RegExp(`^${name},`) })

test('the room stage shows marks, follows the room’s mood, mentions on click and hides per device', async ({
  page,
}) => {
  test.setTimeout(150_000)
  {
    await pair(page)
    const room = await makeRoom(page, 'stage', ['lead', 'reviewer', 'builder'], 'lead')
    await page.goto(`/chat/${room.id}`)

    // Members are marks with their names.
    const stage = page.getByRole('group', { name: 'Room members' })
    await expect(stage).toBeVisible()
    await expect(stage.getByRole('button')).toHaveCount(3)
    await expect(member(page, 'builder').locator('img')).toHaveCount(0)
    await expect(member(page, 'builder').locator('.room-stage__mark .agent-glyph')).toHaveCount(1)
    await expect(member(page, 'builder').locator('.room-stage__name')).toHaveText('builder')

    // Click a member: its mention goes into the composer, which has focus.
    const composer = page.getByRole('combobox', { name: /^Message/ })
    await member(page, 'builder').click()
    await expect(composer).toHaveValue('@builder ')
    await expect(composer).toBeFocused()
    await expect(member(page, 'builder').locator('.room-stage__say')).toBeVisible()
    await composer.fill('')

    // A turn in the room: the lead is thinking or working while the reply is open.
    const quiet = `Please go quiet ${Date.now()}`
    await composer.fill(quiet)
    await composer.press('Enter')
    await expect
      .poll(async () => member(page, 'lead').getAttribute('data-mood'), { timeout: 20_000 })
      .toMatch(/^(think|work)$/)
    const reply = page
      .getByRole('region', { name: 'Message history' })
      .getByRole('article')
      .filter({
        has: page.getByRole('button', { name: /^Stop reply from/ }),
      })
    await reply.getByRole('button', { name: /^Stop reply from/ }).click()
    await expect(member(page, 'lead')).toHaveAttribute('data-mood', 'rest', { timeout: 20_000 })

    // Waiting for you: a "!" and a step to the front, until the approval is answered.
    await composer.fill(`Please ask for approval before installing ${Date.now()}`)
    await composer.press('Enter')
    const lead = member(page, 'lead')
    await expect(lead).toHaveAttribute('data-mood', 'needs', { timeout: 20_000 })
    await expect(lead).toHaveAttribute('data-front', 'true')
    await expect(lead.locator('.room-stage__bang')).toBeVisible()
    const card = page.getByRole('group', { name: /^Approval: / }).last()
    await card.getByRole('button', { name: 'Approve' }).click()
    await expect(lead).not.toHaveAttribute('data-mood', 'needs', { timeout: 20_000 })

    // Hide stage: gone, remembered across a reload; Show stage brings it back.
    await page.getByRole('button', { name: 'Hide stage' }).click()
    await expect(stage).toHaveCount(0)
    await page.reload()
    await expect(page.getByRole('button', { name: 'Show stage' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    await expect(stage).toHaveCount(0)
    await page.getByRole('button', { name: 'Show stage' }).click()
    await expect(stage).toBeVisible()

    // Still: no animated image anywhere on the stage.
    await page.evaluate(() => localStorage.setItem('score.liveliness', 'still'))
    await page.reload()
    await expect(stage).toBeVisible()
    await expect(stage.locator('img')).toHaveCount(0)
    await page.evaluate(() => localStorage.removeItem('score.liveliness'))
  }
})

test('on a phone the strip is shorter', async ({ page }) => {
  await pair(page)
  await page.setViewportSize({ width: 390, height: 800 })
  const room = await makeRoom(page, 'stage-phone', ['lead', 'builder'], 'lead')
  await page.goto(`/chat/${room.id}`)
  const stage = page.getByRole('group', { name: 'Room members' })
  await expect(stage.getByRole('button')).toHaveCount(2)
  const strip = await stage.locator('.room-stage__strip').boundingBox()
  expect(strip!.height).toBeLessThanOrEqual(122)
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
})
