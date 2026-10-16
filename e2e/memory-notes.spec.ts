import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'
import { makeRoom, openRoom } from './rooms.ts'

// PLAN 8.2 against the fake adapter: compacting a room saves the summary as a dated memory note in Knowledge, linked
// from the result and listed in the month's index. `SCORE_SHOT_DIR` saves screenshots for the review.
test('compacting a room saves a memory note that Knowledge shows, with its monthly index', async ({
  page,
}) => {
  await pair(page)
  const room = await makeRoom(page, 'mem', ['lead', 'reviewer'])
  await openRoom(page, room.label)
  const ring = page.getByRole('button', { name: /context: 42 % of 128k/ })
  await expect(ring).toBeVisible({ timeout: 15_000 })
  await ring.click()
  const panel = page.getByRole('dialog', { name: /context details/ })
  await panel.getByRole('button', { name: 'Compact' }).click()
  await panel.getByRole('button', { name: 'Compact now' }).click()
  const link = panel.getByRole('link', { name: 'Open the memory note' })
  await expect(link).toBeVisible({ timeout: 15_000 })
  const href = (await link.getAttribute('href'))!
  expect(decodeURIComponent(href)).toMatch(
    /^\/knowledge\/Memory\/[a-z-]+\/\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2} /,
  )
  await link.click()
  await expect(page).toHaveURL(new RegExp('/knowledge/Memory/'))
  const notePath = decodeURIComponent(href).replace('/knowledge/', '')
  const editor = page.getByLabel(`Contents of ${notePath}`)
  await expect(editor).toBeVisible({ timeout: 15_000 })
  await expect(editor).toContainText('Ship the launch checklist')
  const shots = process.env.SCORE_SHOT_DIR
  if (shots) await page.screenshot({ path: `${shots}/memory.png` })
  // The month's index lists it.
  const index = `${notePath.split('/').slice(0, -1).join('/')}/index.md`
  await page.goto(`/knowledge/${index.split('/').map(encodeURIComponent).join('/')}`)
  const indexEditor = page.getByLabel(`Contents of ${index}`)
  await expect(indexEditor).toContainText(notePath.split('/').at(-1)!.replace(/\.md$/, ''), {
    timeout: 15_000,
  })
  await expect(indexEditor).toContainText('weight 3')
  if (shots) await page.screenshot({ path: `${shots}/memory-index.png` })
})
