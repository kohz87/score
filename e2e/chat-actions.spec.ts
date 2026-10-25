import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'
import { makeRoom, openRoom } from './rooms.ts'

// PLAN 5.24: actions under each message (edit and resend, copy, retry, delete).
test('Edit (replaces), Copy and Retry work from the action row under a message', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await pair(page)
  // Own room: a rewind is refused while another spec's agent is answering in a shared one.
  const room = await makeRoom(page, 'act')
  await openRoom(page, room.label)
  const history = page.getByRole('region', { name: 'Message history' })
  const composer = page.getByRole('combobox', { name: /^Message/ })
  const stamp = Date.now()
  const first = `Please check the room context ${stamp}`
  await composer.fill(first)
  await composer.press('Enter')
  const mine = history.getByRole('article').filter({ hasText: first })
  await expect(mine).toBeVisible()
  const replyAfter = (article: typeof mine) =>
    article.locator('xpath=following-sibling::article').filter({
      hasText: 'I have reviewed the room context',
    })
  await expect(replyAfter(mine).first()).toBeVisible({ timeout: 40_000 })

  // Copy: the row sits below the body and the text lands on the clipboard.
  await mine.hover()
  await mine.getByRole('button', { name: 'Copy message from You' }).click()
  await expect(mine.getByRole('button', { name: 'Copy message from You' })).toHaveText('Copied')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(first)

  // Edit and resend: Cancel first, then send a correction.
  await mine.getByRole('button', { name: 'Edit message from You' }).click()
  await expect(page.getByText('Editing your message')).toBeVisible()
  await expect(composer).toHaveValue(first)
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(composer).toHaveValue('')
  await mine.getByRole('button', { name: 'Edit message from You' }).click()
  const fixed = `Please check the room context, corrected ${stamp}`
  await composer.fill(fixed)
  await composer.press('Enter')
  // PLAN 5.33: the edit rewinds the room and the agents; since 2.0.12 Send does it without asking when it can.
  const corrected = history.getByRole('article').filter({ hasText: fixed })
  await expect(corrected).toBeVisible()
  // The original and its replies become the previous version.
  await expect(mine).toHaveCount(0)
  await expect(corrected.getByRole('group', { name: 'Message versions' })).toContainText(
    'Version 2 of 2',
  )
  await expect(replyAfter(corrected).first()).toBeVisible({ timeout: 40_000 })

  // Retry: the same agent answers again; the first reply stays.
  const replies = history
    .getByRole('article')
    .filter({ hasText: 'I have reviewed the room context' })
  const before = await replies.count()
  const retried = page.waitForResponse(
    (response) => response.url().endsWith('/retry') && response.status() === 202,
  )
  const last = replyAfter(corrected).first()
  await last.hover()
  await last.getByRole('button', { name: /^Retry reply/ }).click()
  await retried
  await expect(replies).toHaveCount(before + 1, { timeout: 40_000 })
})
