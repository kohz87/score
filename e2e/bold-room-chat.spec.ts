import { expect, test } from '@playwright/test'
import {
  actsOf,
  composerOf,
  makeRoom,
  messageWith,
  openBoldRoomById,
  say,
  sendAndWait,
  streamOf,
} from './bold-chat-helpers.ts'
import { pair } from './pair.ts'

// 3.0.0: the classic Chat specs (chat, chat-actions, chat-composer, chat-delete, chat-formatting, chat-rewind, chat-stalled,
// chat-approval) ported to the new shell's team room (`/b?room=`), against the real fake server. Each test makes its own
// room: a rewind is refused while another spec's agent is answering in a shared one.
test.use({ reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } })

test.beforeEach(async ({ page }) => {
  await pair(page)
})

test('an older room opens with its history, an enabled composer, a disabled Send and no sideways scroll on a phone', async ({
  page,
}) => {
  const made = await makeRoom(page, 'kbd')
  const asked = `Where are we with pagination ${Date.now()}`
  await say(page, made.id, asked)
  await openBoldRoomById(page, made.id)
  await expect(page.getByRole('button', { name: new RegExp(`^${made.label}`) })).toBeVisible()
  await expect(streamOf(page).getByText(asked).first()).toBeAttached({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
  await page.setViewportSize({ width: 360, height: 800 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360)
})

test('Copy, Edit (replaces, Cancel first) and Try another work from the action row under a message', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const room = await makeRoom(page, 'act')
  await openBoldRoomById(page, room.id)
  const stamp = Date.now()
  const first = `Please check the room context ${stamp}`
  const mine = await sendAndWait(page, first)

  // Copy: the text lands on the clipboard.
  await mine.hover()
  await actsOf(mine).getByRole('button', { name: 'Copy message from You' }).click()
  await expect(actsOf(mine).getByRole('button', { name: 'Copy message from You' })).toHaveText(
    'Copied',
  )
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(first)

  // Edit: Cancel first, then send a correction.
  const composer = composerOf(page)
  await mine.hover()
  await actsOf(mine).getByRole('button', { name: 'Edit message from You' }).click()
  await expect(page.getByText('Editing your message')).toBeVisible()
  await expect(composer).toHaveValue(first)
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(composer).toHaveValue('')
  await mine.hover()
  await actsOf(mine).getByRole('button', { name: 'Edit message from You' }).click()
  const fixed = `Please check the room context, corrected ${stamp}`
  await composer.fill(fixed)
  await composer.press('Enter')
  const corrected = messageWith(page, fixed)
  await expect(corrected).toBeVisible()
  // The original and its replies become the previous version.
  await expect(messageWith(page, first).filter({ hasNotText: 'corrected' })).toHaveCount(0)
  await expect(corrected.getByRole('group', { name: 'Message versions' })).toContainText(
    'Version 2 of 2',
  )
  await expect(streamOf(page).getByText('I have reviewed the room context').first()).toBeVisible({
    timeout: 40_000,
  })
  await expect(streamOf(page).getByRole('button', { name: /^Stop reply/ })).toHaveCount(0)

  // Try another: the same agent answers again (the old Retry; since 2.4.0 the versions are one message with a pager).
  const reply = streamOf(page)
    .locator('.bold-message', { hasText: 'I have reviewed the room context' })
    .last()
  await reply.hover()
  const retried = page.waitForResponse(
    (response) => response.url().endsWith('/retry') && response.status() === 202,
  )
  await actsOf(reply)
    .getByRole('button', { name: /^Try another reply from/ })
    .click()
  await retried
  await expect(streamOf(page).getByText('2 / 2')).toBeVisible({ timeout: 40_000 })
})

test('the composer sends a message that gets a streamed reply, and an /assign that creates a task', async ({
  page,
}) => {
  const room = await makeRoom(page, 'cmp')
  await openBoldRoomById(page, room.id)
  const composer = composerOf(page)
  const text = `Please check the room context ${Date.now()}`
  await composer.fill(text)
  await composer.press('Enter')
  await expect(composer).toHaveValue('')
  await expect(messageWith(page, text)).toBeVisible()
  await expect(
    streamOf(page)
      .getByRole('article', { name: /Message from lead/ })
      .filter({
        hasText: 'I have reviewed the room context',
      }),
  ).toBeVisible({ timeout: 20_000 })

  // Slash menu and @autocomplete are keyboard driven.
  await composer.fill('/')
  const commands = page.getByRole('listbox', { name: 'Commands' })
  // /remember and /skill are not offered (501); /compress and /usage are the composer's own (PLAN 5.25).
  await expect(commands.getByRole('option')).toHaveCount(5)
  // 3.7.8 (owner): every option is inside the list's box, not cut off after the first row.
  const box = (await commands.boundingBox())!
  const last = (await commands.getByRole('option').last().boundingBox())!
  expect(box.height).toBeGreaterThan(4 * last.height)
  expect(last.y + last.height).toBeLessThanOrEqual(box.y + box.height + 1)
  await composer.press('Enter')
  await expect(composer).toHaveValue('/assign ')
  await composer.pressSequentially('@bu')
  await expect(page.getByRole('listbox', { name: 'Agents' })).toBeVisible()
  await composer.press('Tab')
  await expect(composer).toHaveValue('/assign @builder ')
  await composer.pressSequentially(`Composer task ${Date.now()}`)
  await composer.press('Enter')
  await expect(page.getByRole('status').filter({ hasText: 'Created task' })).toBeVisible()
})

test('Delete on an agent reply hides it with an Undo window, then removes it for real', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const room = await makeRoom(page, 'del')
  await openBoldRoomById(page, room.id)
  await sendAndWait(page, `Delete me ${Date.now()}`)
  // An agent reply: deleting it stays Score-only with an Undo window (your own messages rewind).
  const replies = streamOf(page).getByRole('article', { name: /^Message from (?!You)/ })
  await expect(replies).toHaveCount(1)
  const id = await replies.first().getAttribute('id')
  const reply = streamOf(page).locator(`[id="${id}"]`)

  const row = streamOf(page).locator('.bold-message', { has: page.locator(`[id="${id}"]`) })
  await row.hover()
  await actsOf(row)
    .getByRole('button', { name: /^Delete message from (?!You)/ })
    .click()
  await expect(reply).toHaveCount(0)
  const toast = page.getByRole('status').filter({ hasText: 'Message deleted' })
  await expect(
    toast.getByText('Removes it from Score. Agents may still remember it.'),
  ).toBeVisible()
  await toast.getByRole('button', { name: 'Undo' }).click()
  await expect(reply).toHaveCount(1)

  const deleted = page.waitForResponse(
    (response) => response.request().method() === 'DELETE' && response.status() === 204,
  )
  await row.hover()
  await actsOf(row)
    .getByRole('button', { name: /^Delete message from (?!You)/ })
    .click()
  await deleted
  await page.reload()
  await expect(composerOf(page)).toBeEnabled({ timeout: 15_000 })
  await expect(reply).toHaveCount(0)
})

test('a Markdown reply renders with a copyable code block, tool cards and a thinking card', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const room = await makeRoom(page, 'fmt')
  await openBoldRoomById(page, room.id)
  await composerOf(page).fill('markdown demo please')
  await composerOf(page).press('Enter')
  const reply = streamOf(page)
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: 'Plan' }) })
    .last()
  await expect(reply.getByRole('heading', { name: 'Plan' })).toBeVisible({ timeout: 40_000 })
  await expect(reply.locator('strong', { hasText: 'the change' })).toBeVisible()
  await expect(reply.getByRole('listitem')).toHaveCount(2)
  const block = reply.locator('.chat-code')
  await expect(block.locator('.chat-code-head')).toContainText('ts')
  await expect(block.locator('.tok-keyword')).toHaveText('const')
  await block.getByRole('button', { name: 'Copy ts code' }).click()
  await expect(block.getByRole('button', { name: 'Copy ts code' })).toHaveText('Copied')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('const pageSize = 25')

  // The tool call and the reasoning are collapsed cards on the finished reply.
  const tool = reply.locator('details.chat-tool')
  await expect(tool).toHaveCount(1)
  await expect(tool).not.toHaveAttribute('open', '')
  await tool.locator('summary').click()
  await expect(tool.getByLabel('Result')).toHaveText('3 checks passed')
  const thinking = reply.locator('details.chat-thinking')
  await expect(thinking.locator('summary')).toHaveText('Thought process')
  await expect(thinking).not.toHaveAttribute('open', '')
})

test('Stop ends a long reply early and the reply says it was stopped', async ({ page }) => {
  test.setTimeout(120_000)
  const room = await makeRoom(page, 'stp')
  await openBoldRoomById(page, room.id)
  await composerOf(page).fill('give me a long reply')
  await composerOf(page).press('Enter')
  const stop = page.getByRole('button', { name: 'Stop', exact: true })
  await expect(stop).toBeVisible({ timeout: 20_000 })
  // Who is busy is told by the reply itself now (the classic sidebar's member icons are gone).
  await expect(streamOf(page).getByText('Writing the reply…')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0)
  await stop.click()
  await expect(streamOf(page).getByText('This run was stopped.')).toBeVisible({ timeout: 20_000 })
  await expect(streamOf(page).getByText('Writing the reply…')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
})

test('a silent reply shows the waiting notice next to Stop, and stopping ends it', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const room = await makeRoom(page, 'stalled')
  await openBoldRoomById(page, room.id)
  // After pairing and loading: the clock only fakes this page's timers from here on.
  await page.clock.install()
  await composerOf(page).fill(`Please go quiet ${Date.now()}`)
  await composerOf(page).press('Enter')
  const reply = streamOf(page)
    .getByRole('article')
    .filter({
      has: page.getByRole('button', { name: /^Stop reply from/ }),
    })
  const stop = reply.getByRole('button', { name: /^Stop reply from/ })
  await expect(stop).toBeVisible({ timeout: 20_000 })
  const notice = reply.getByText(/Waiting for the model/)
  await expect(notice).toHaveCount(0)
  await page.clock.fastForward(65_000)
  await expect(notice).toBeVisible()
  await expect(notice).toContainText(
    'Hermes may be retrying after a rate limit or a provider error',
  )
  await page.clock.fastForward(30_000)
  await expect(notice).toContainText('1 min 30 s')
  const id = await reply.getAttribute('id')
  await stop.click()
  const stopped = page.locator(`[id="${id}"]`)
  await expect(stopped).toContainText('This run was stopped.', { timeout: 20_000 })
  await expect(stopped.getByText(/Waiting for the model/)).toHaveCount(0)
})

// PLAN 5.33: editing or deleting your own message rewinds the room and the agents' sessions; what was hidden stays
// readable as the previous version. Rewinding is refused while any agent is answering, so each test has its own room.
test('Delete rewinds: your message and the reply become a read-only previous version', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const room = await makeRoom(page, 'rew', ['lead', 'reviewer'])
  await openBoldRoomById(page, room.id)
  // A first exchange stays, so the room is never empty (an empty room shows the starter board, not the stream).
  await sendAndWait(page, `Keep this ${Date.now()}`)
  const text = `Rewind this ${Date.now()}`
  const mine = await sendAndWait(page, text, 'I have reviewed the room context')
  await mine.hover()
  await actsOf(mine).getByRole('button', { name: 'Delete message from You' }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete this message?' })
  await expect(dialog.getByText(/Agents rewound:.*lead −\d+ exchanges?/)).toBeVisible()
  await expect(dialog.getByText(/Long-term memory .* isn’t rewound/)).toBeVisible()
  await dialog.getByRole('button', { name: 'Rewind and delete' }).click()
  await expect(mine).toHaveCount(0)

  // Deleted messages leave no rows in the thread until asked for.
  await expect(page.getByRole('region', { name: 'Deleted messages' })).toHaveCount(0)
  await page.reload()
  await expect(composerOf(page)).toBeEnabled({ timeout: 15_000 })
  await expect(mine).toHaveCount(0)
  await page.getByRole('button', { name: 'Show deleted messages' }).click()
  const previous = page.getByRole('region', { name: 'Deleted messages' }).last()
  const old = previous.getByRole('article', { name: /Message from You/ }).filter({ hasText: text })
  await expect(old).toBeVisible()
  await expect(old.getByRole('button', { name: /^Delete message/ })).toHaveCount(0)
  await expect(old.getByRole('button', { name: /^Edit message/ })).toHaveCount(0)
})

test('Edit rewinds, then the correction shows ‹ 2 / 2 › and the original is one step back', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const room = await makeRoom(page, 'rew', ['lead', 'reviewer'])
  await openBoldRoomById(page, room.id)
  const stamp = Date.now()
  const text = `First wording ${stamp}`
  const mine = await sendAndWait(page, text)
  await mine.hover()
  await actsOf(mine).getByRole('button', { name: 'Edit message from You' }).click()
  const fixed = `Second wording ${stamp}`
  const composer = composerOf(page)
  await composer.fill(fixed)
  await composer.press('Enter')
  // 2.0.12: every agent can be rewound, so Send rewinds and posts without a dialog.
  await expect(page.getByRole('dialog', { name: 'Edit and send again?' })).toHaveCount(0)
  const corrected = messageWith(page, fixed)
  await expect(corrected).toBeVisible()
  await expect(mine).toHaveCount(0)
  const control = corrected.getByRole('group', { name: 'Message versions' })
  await expect(control).toContainText('Version 2 of 2')
  await control.getByRole('button', { name: 'Previous version' }).click()
  const branch = streamOf(page).getByRole('region', { name: 'Version 1 of 2' })
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
  const room = await makeRoom(page, 'rew', ['lead', 'reviewer'])
  await openBoldRoomById(page, room.id)
  const text = `@reviewer please look at this ${Date.now()}`
  const composer = composerOf(page)
  await composer.fill(text)
  await composer.press('Escape')
  await composer.press('Enter')
  const mine = messageWith(page, 'please look at this')
  await expect(mine.last()).toBeVisible()
  await expect(streamOf(page).getByText('I have reviewed').first()).toBeVisible({ timeout: 40_000 })
  await expect(streamOf(page).getByRole('button', { name: /^Stop reply/ })).toHaveCount(0)
  await mine.last().hover()
  await actsOf(mine.last()).getByRole('button', { name: 'Delete message from You' }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete this message?' })
  await expect(dialog.getByText(/These agents can’t be rewound/)).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Rewind and delete' })).toBeDisabled()
  await dialog.getByRole('button', { name: 'Hide in Score only' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(mine).toHaveCount(0)
})

test('a run that asks for approval shows a Needs you card in the room and allowing it resolves the ledger', async ({
  page,
}) => {
  const room = await makeRoom(page, 'apr', ['designer'], 'designer')
  await openBoldRoomById(page, room.id)
  const prompt = `Please ask for approval before installing ${Date.now()}`
  await composerOf(page).fill(prompt)
  await composerOf(page).press('Enter')
  // Other specs' approvals share the server and the Needs you region, so the card is the one that names this room.
  const card = page
    .getByRole('region', { name: 'Needs you' })
    .getByRole('article', { name: /^Needs you: Install the websocket library/ })
    .filter({ hasText: room.label })
  // Other specs' approvals share the server: the region shows the newest and folds the rest behind "N more needs you".
  await expect(async () => {
    const more = page.getByRole('button', { name: /more needs? you/ })
    if (!(await card.isVisible()) && (await more.isVisible())) await more.click()
    await expect(card.getByRole('button', { name: 'Allow', exact: true })).toBeVisible({
      timeout: 1_000,
    })
  }).toPass({ timeout: 20_000 })
  await expect(card.locator('code')).toHaveText('pnpm add ws@8.18.0')
  const pending = await page.evaluate(async () => {
    const response = await fetch('/api/approvals')
    return (await response.json()) as { items: Record<string, unknown>[] }
  })
  const id = pending.items.find((item) => JSON.stringify(item).includes(room.id))?.id as string
  expect(id).toBeTruthy()

  await card.getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(card).toHaveCount(0, { timeout: 15_000 })

  const ledger = await page.evaluate(async () => {
    const response = await fetch('/api/approvals?status=all')
    return (await response.json()) as {
      items: { id: string; status: string; decision: { by: string; choice: string } | null }[]
    }
  })
  const decided = ledger.items.find((item) => item.id === id)
  expect(decided?.status).toBe('approved')
  expect(decided?.decision).toMatchObject({ by: 'you', choice: 'once' })
})
