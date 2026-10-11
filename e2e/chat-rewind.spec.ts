import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'
import { makeRoom, openRoom as openRoomByName } from './rooms.ts'

// PLAN 5.33: editing or deleting your own message rewinds the room and the agents' sessions; what was hidden stays
// readable as the previous version.
// Rewinding is refused while any agent is answering in the room, so each test rewinds in a room of its own.
async function openRoom(page: Page) {
  await pair(page)
  const room = await makeRoom(page, 'rew', ['lead', 'reviewer'])
  await openRoomByName(page, room.label)
  const history = page.getByRole('region', { name: 'Message history' })
  return { history, room }
}
async function sendAndWait(page: Page, history: ReturnType<Page['getByRole']>, text: string) {
  const composer = page.getByRole('combobox', { name: /^Message/ })
  await composer.fill(text)
  await composer.press('Enter')
  const mine = history.getByRole('article', { name: /Message from You/ }).filter({ hasText: text })
  await expect(mine).toBeVisible()
  // The answer has arrived once the message offers Stop-free actions of the reply after it.
  const reply = mine
    .locator('xpath=following-sibling::article')
    .filter({ hasText: 'I have reviewed the room context' })
  await expect(reply.first()).toBeVisible({ timeout: 40_000 })
  await expect(history.getByRole('button', { name: /^Stop reply/ })).toHaveCount(0)
  return { mine, reply }
}

test('Delete rewinds: your message and the reply become a read-only previous version', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const { history, room } = await openRoom(page)
  const text = `Rewind this ${Date.now()}`
  const { mine } = await sendAndWait(page, history, text)
  await mine.hover()
  await mine.getByRole('button', { name: 'Delete message from You' }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete this message?' })
  await expect(dialog.getByText(/Agents rewound:.*lead −\d+ exchanges?/)).toBeVisible()
  await expect(dialog.getByText(/Long-term memory .* is not rewound/)).toBeVisible()
  await dialog.getByRole('button', { name: 'Rewind and delete' }).click()
  await expect(mine).toHaveCount(0)

  // Deleted messages leave no rows in the thread.
  await expect(page.getByTestId('deleted-messages')).toHaveCount(0)
  await page.reload()
  // Nothing else is in this room, so the thread is empty: the page is loaded once its composer is.
  await expect(page.getByRole('combobox', { name: /^Message/ })).toBeEnabled({ timeout: 15_000 })
  await expect(mine).toHaveCount(0)
  // The room's menu shows them dimmed and read-only, in place.
  await page
    .getByRole('navigation', { name: 'Rooms' })
    .getByRole('button', { name: `Actions for ${room.label}` })
    .click()
  await page.getByRole('menuitemcheckbox', { name: 'Show deleted messages' }).click()
  const previous = page.getByTestId('deleted-messages').last()
  const old = previous.getByRole('article', { name: /Message from You/ }).filter({ hasText: text })
  await expect(old).toBeVisible()
  await expect(old.getByRole('button', { name: /^Delete message/ })).toHaveCount(0)
  await expect(old.getByRole('button', { name: /^Edit message/ })).toHaveCount(0)
})

test('Edit rewinds, then the correction shows ‹ 2 / 2 › and the original is one step back', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const { history } = await openRoom(page)
  const stamp = Date.now()
  const text = `First wording ${stamp}`
  const { mine } = await sendAndWait(page, history, text)
  await mine.hover()
  await mine.getByRole('button', { name: 'Edit message from You' }).click()
  const fixed = `Second wording ${stamp}`
  const composer = page.getByRole('combobox', { name: /^Message/ })
  await composer.fill(fixed)
  await composer.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Edit and send again?' })
  await expect(dialog.getByText(/Agents rewound:.*lead −\d+ exchanges?/)).toBeVisible()
  await dialog.getByRole('button', { name: 'Rewind and edit' }).click()
  const corrected = history
    .getByRole('article', { name: /Message from You/ })
    .filter({ hasText: fixed })
  await expect(corrected).toBeVisible()
  await expect(mine).toHaveCount(0)
  const control = corrected.getByRole('group', { name: 'Message versions' })
  await expect(control).toContainText('Version 2 of 2')
  await control.getByRole('button', { name: 'Previous version' }).click()
  const branch = history.getByRole('region', { name: 'Version 1 of 2' })
  await expect(branch).toContainText('Viewing version 1 of 2')
  await expect(
    branch.getByRole('article', { name: /Message from You/ }).filter({ hasText: text }),
  ).toBeVisible()
  await expect(corrected).toHaveCount(0)
  // Arrow keys step on from the bar's control; the thread returns to the latest branch.
  await expect(branch.getByRole('button', { name: 'Previous version' })).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(branch).toHaveCount(0)
  await expect(corrected).toBeVisible()
})

test('An agent that cannot be rewound is named, and Hide in Score only still works', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const { history } = await openRoom(page)
  const text = `@reviewer please look at this ${Date.now()}`
  const composer = page.getByRole('combobox', { name: /^Message/ })
  await composer.fill(text)
  await composer.press('Escape')
  await composer.press('Enter')
  const mine = history
    .getByRole('article', { name: /Message from You/ })
    .filter({ hasText: 'please look at this' })
  await expect(mine.last()).toBeVisible()
  await expect(
    mine
      .last()
      .locator('xpath=following-sibling::article')
      .filter({ hasText: 'I have reviewed' })
      .first(),
  ).toBeVisible({ timeout: 40_000 })
  await expect(history.getByRole('button', { name: /^Stop reply/ })).toHaveCount(0)
  await mine.last().hover()
  await mine.last().getByRole('button', { name: 'Delete message from You' }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete this message?' })
  await expect(dialog.getByText(/These agents cannot be rewound/)).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Rewind and delete' })).toBeDisabled()
  await dialog.getByRole('button', { name: 'Hide in Score only' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(mine).toHaveCount(0)
})
