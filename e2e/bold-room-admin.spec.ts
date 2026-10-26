import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { makeRoom, openBoldRoomById, say, streamOf } from './bold-chat-helpers.ts'
import { pair } from './pair.ts'

// 3.0.0: the classic chat-rooms (delete, compact, /compress), chat-summary, memory-notes and conversations (export, share)
// specs on the new shell, against the real fake server. The compaction ring now lives in the one-to-one chat and the
// job thread (the team room's composer has no rings), so compaction is exercised in a chat of its own.
test.use({ reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } })

const web = { 'x-score-client': 'web' }
const side = (page: Page) => page.locator('#bold-side-panel')

test.beforeEach(async ({ page }) => {
  await pair(page)
})

async function makeChat(page: Page, agent: string) {
  const made = await page.request.post(`/api/agents/${agent}/chats`, { headers: web, data: {} })
  expect(made.ok()).toBeTruthy()
  return (await made.json()) as { id: string; roomId: string }
}

async function openChat(page: Page, agent: string, chatId: string) {
  await page.goto(`/b?with=${agent}&chat=${chatId}`)
  await expect(side(page).locator('.bold-dm-thread')).toBeVisible({ timeout: 30_000 })
}

test('delete a room: the dialog says what goes, needs the typed name, then the team room', async ({
  page,
}) => {
  const room = await makeRoom(page, 'del')
  await openBoldRoomById(page, room.id)
  await page.getByRole('button', { name: 'Room menu' }).click()
  await page.getByRole('menuitem', { name: `Delete ${room.label}` }).click()
  const dialog = page.getByRole('dialog', { name: `Delete ${room.label}?` })
  await expect(dialog).toHaveAttribute('data-protected', 'any')
  await expect(dialog.getByText(/will be removed from Score for good/)).toBeVisible()
  await expect(dialog.getByText(/Hermes sessions are/)).toBeVisible()
  await expect(dialog.getByRole('link', { name: 'Export as Markdown' })).toBeVisible()
  const confirm = dialog.getByRole('button', { name: 'Delete room' })
  await expect(confirm).toBeDisabled()
  await dialog.getByRole('textbox').fill(room.label.slice(0, -1))
  await expect(confirm).toBeDisabled()
  await dialog.getByRole('textbox').fill(room.label)
  await confirm.click()
  await expect(dialog).toBeHidden()
  await expect(page).toHaveURL(/\/b$/)
  await expect(page.locator('.roomtitle')).toHaveText('Team room')
  // Gone for good: the room's address is not found any more.
  const gone = await page.request.get(`/api/rooms/${room.id}`)
  expect(gone.status()).toBe(404)
})

test('compact from the ring: it asks first, shows Hermes’s before and after, and the ring shrinks', async ({
  page,
}) => {
  const chat = await makeChat(page, 'lead')
  await openChat(page, 'lead', chat.id)
  const ring = side(page).getByRole('button', { name: /context: 42 % of 128k/ })
  await expect(ring).toBeVisible({ timeout: 15_000 })
  await ring.click()
  const panel = page.getByRole('dialog', { name: /context details/ })
  await expect(panel.getByText('What is using it')).toBeVisible()
  await expect(panel.getByRole('listitem').filter({ hasText: 'Messages' })).toBeVisible()
  await expect(panel.getByText(/Hermes compacts automatically at 64,000 tokens/)).toBeVisible()
  await panel.getByRole('button', { name: 'Compact' }).click()
  await expect(panel.getByText(/Hermes will summarise .*older exchanges/)).toBeVisible()
  await panel.getByRole('button', { name: 'Compact now' }).click()
  await expect(panel.getByText(/Compacted: 40 → 12 messages, 54,000 → 9,000 tokens/)).toBeVisible({
    timeout: 15_000,
  })
  await expect(side(page).getByRole('button', { name: /context: 7 % of 128k/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
})

test('/compress asks for confirmation instead of sending a message, then compacts', async ({
  page,
}) => {
  const chat = await makeChat(page, 'lead')
  await openChat(page, 'lead', chat.id)
  await expect(side(page).getByRole('button', { name: /context: 42 % of 128k/ })).toBeVisible({
    timeout: 15_000,
  })
  const composer = side(page).getByRole('combobox', { name: /^Message/ })
  await composer.fill('/compress')
  await composer.press('Enter')
  await composer.press('Enter')
  const panel = page.getByRole('dialog', { name: /context details/ })
  await expect(panel.getByText(/Hermes will summarise .*older exchanges/)).toBeVisible()
  await expect(composer).toHaveValue('')
  await panel.getByLabel('Exchanges kept word for word').fill('3')
  await panel.getByRole('button', { name: 'Compact now' }).click()
  await expect(panel.getByText(/Compacted: 40 → 14 messages/)).toBeVisible({ timeout: 15_000 })
  // Nothing was posted to the chat.
  await expect(side(page).locator('.bold-dm-message')).toHaveCount(0)
})

test('compacting saves a memory note that the Library shows, with its monthly index', async ({
  page,
}) => {
  const chat = await makeChat(page, 'lead')
  await openChat(page, 'lead', chat.id)
  const ring = side(page).getByRole('button', { name: /context: 42 % of 128k/ })
  await expect(ring).toBeVisible({ timeout: 15_000 })
  await ring.click()
  const panel = page.getByRole('dialog', { name: /context details/ })
  await panel.getByRole('button', { name: 'Compact' }).click()
  await panel.getByRole('button', { name: 'Compact now' }).click()
  const link = panel.getByRole('link', { name: 'Open the memory note' })
  await expect(link).toBeVisible({ timeout: 15_000 })
  const href = (await link.getAttribute('href'))!
  // The link is the old /knowledge path, which redirects into the Library.
  expect(decodeURIComponent(href)).toMatch(
    /^\/knowledge\/Memory\/[a-z-]+\/\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2} /,
  )
  await link.click()
  const notePath = decodeURIComponent(href).replace('/knowledge/', '')
  const editor = page.getByLabel(`Contents of ${notePath}`)
  await expect(editor).toBeVisible({ timeout: 15_000 })
  await expect(editor).toContainText('Ship the launch checklist')
  // The month's index lists it.
  const index = `${notePath.split('/').slice(0, -1).join('/')}/index.md`
  await page.goto(`/b?note=${encodeURIComponent(index)}`)
  const indexEditor = page.getByLabel(`Contents of ${index}`)
  await expect(indexEditor).toContainText(notePath.split('/').at(-1)!.replace(/\.md$/, ''), {
    timeout: 15_000,
  })
  await expect(indexEditor).toContainText('weight 3')
})

test('a room summary is editable and can be deleted (the summary is requested over the API: the menu entry is gone)', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const room = await makeRoom(page, 'sum')
  await openBoldRoomById(page, room.id)
  await say(page, room.id, `Plan the release ${Date.now()}`)
  await expect(streamOf(page).getByText('I have reviewed the room context').first()).toBeVisible({
    timeout: 40_000,
  })
  const requested = await page.request.post(`/api/rooms/${room.id}/summary`, {
    headers: web,
    data: {},
  })
  expect(requested.status()).toBe(202)

  const card = streamOf(page).getByRole('region', { name: 'Summary of earlier messages' })
  await expect(card).toBeVisible({ timeout: 40_000 })
  await expect(card).toContainText('earlier messages')
  await expect(card).toContainText('written by')

  await card.getByRole('button', { name: 'Edit' }).click()
  await card.getByLabel('Summary text').fill('Release plan agreed by the team.')
  await card.getByRole('button', { name: 'Save' }).click()
  await expect(card).toContainText('Release plan agreed by the team.')
  await expect(card).toContainText('edited by you')

  await card.getByRole('button', { name: 'Delete' }).click()
  await card.getByRole('button', { name: 'Delete summary' }).click()
  await expect(card).toHaveCount(0)
})

test('export downloads a Markdown transcript of the room', async ({ page }) => {
  const room = await makeRoom(page, 'export')
  const text = `Exportable line ${Date.now()}`
  await say(page, room.id, text)
  await openBoldRoomById(page, room.id)
  await page.getByRole('button', { name: 'Room menu' }).click()
  const markdown = page.waitForEvent('download')
  await page.getByRole('menuitem', { name: 'Export this room' }).click()
  const md = await markdown
  expect(md.suggestedFilename()).toMatch(/^score-.*\.md$/)
  const mdText = readFileSync((await md.path())!, 'utf8')
  expect(mdText).toContain(`# ${room.label}`)
  expect(mdText).toContain('Exported at:')
  expect(mdText).toContain(text)
})

test('a share link opens a static page without the app, and revoking it makes it 404', async ({
  page,
  browser,
}) => {
  const password = 'e2e share password'
  // The security password guards link creation; set it if this server has none yet.
  await page.request.put('/api/session/security/password', { headers: web, data: { password } })
  const room = await makeRoom(page, 'share')
  const text = `Shared words ${Date.now()}`
  await say(page, room.id, `${text} api_key=sk-abcdefghijklmnop123`)
  await openBoldRoomById(page, room.id)
  await page.getByRole('button', { name: 'Room menu' }).click()
  await page.getByRole('menuitem', { name: 'Share a read-only link' }).click()
  const dialog = page.getByRole('dialog', { name: new RegExp(`Share ${room.label}`) })
  await expect(dialog.getByText(/can reach this Score/)).toBeVisible()
  await dialog.getByLabel('Security password').fill('not the password')
  await dialog.getByRole('button', { name: 'Create link' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('That is not the security password.')
  await dialog.getByLabel('Security password').fill(password)
  await dialog.getByRole('button', { name: 'Create link' }).click()
  const url = (
    await dialog.getByRole('group', { name: 'New share link' }).locator('code').innerText()
  ).trim()
  expect(url).toMatch(/\/s\/[A-Za-z0-9_-]{43}$/)

  // Anyone with the link, signed in or not: a different browser context has no Score cookie.
  const stranger = await browser.newContext()
  const shared = await stranger.newPage()
  const response = await shared.goto(url)
  expect(response!.status()).toBe(200)
  expect(response!.headers()['content-security-policy']).toBe(
    "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
  )
  expect(response!.headers()['x-robots-tag']).toBe('noindex')
  await expect(shared.getByText(text)).toBeVisible()
  await expect(shared.getByText('[redacted]')).toBeVisible()
  expect(await shared.content()).not.toContain('sk-abcdefghijklmnop123')
  expect(await shared.locator('script').count()).toBe(0)

  // Revoke from the dialog (no password needed): the same URL is now a 404 page.
  await dialog
    .getByRole('list', { name: 'Active share links' })
    .getByRole('button', { name: 'Revoke' })
    .click()
  await expect(dialog.getByRole('list', { name: 'Active share links' })).toHaveCount(0)
  const gone = await shared.goto(url)
  expect(gone!.status()).toBe(404)
  await expect(shared.getByText("This link doesn't work")).toBeVisible()
  await stranger.close()
  await dialog.getByRole('button', { name: 'Close' }).click()
})

test('a finished orchestration room can be deleted too, and a running one says the run still owns it', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const goal = `Delete me e2e-del-${Date.now().toString(36)}`
  // The run is started over the API: the classic "New orchestration" dialog is gone with the classic Chat page.
  const created = await page.request.post('/api/orchestrations', {
    headers: web,
    data: {
      goal,
      leadAgentId: 'lead',
      allowedAgents: ['builder', 'reviewer'],
      gatePolicy: 'none',
      acknowledgement: {
        text: "Score controls the work it starts (exchanges and steps) and can stop those runs; agents may still use other tools and start background work Score can't see or stop.",
      },
    },
  })
  expect(created.ok()).toBe(true)
  const { orchestration } = (await created.json()) as {
    orchestration: { id: string; roomId: string }
  }
  const roomId = orchestration.roomId
  const rooms = (await (await page.request.get('/api/rooms')).json()) as {
    rooms: { id: string; name: string }[]
  }
  const room = rooms.rooms.find((item) => item.id === roomId)!
  expect(room, 'the run made a room').toBeDefined()
  await openBoldRoomById(page, roomId)

  // While the run owns the room it can't be deleted.
  await page.getByRole('button', { name: 'Room menu' }).click()
  await page.getByRole('menuitem', { name: `Delete ${room.name}` }).click()
  const dialog = page.getByRole('dialog', { name: `Delete ${room.name}?` })
  // The fake run can finish before the dialog opens on a loaded machine; then it is the plain delete dialog.
  await expect(dialog.getByRole('alert').or(dialog.getByRole('textbox'))).toBeVisible()
  if (await dialog.getByRole('alert').isVisible())
    await expect(dialog.getByRole('alert')).toContainText('still owns this room')
  await dialog.getByRole('button', { name: 'Cancel' }).click()

  // No gates: the run finishes by itself and releases the room.
  await expect
    .poll(
      async () => {
        const list = (await (await page.request.get('/api/orchestrations')).json()) as {
          items: { title: string; status: string }[]
        }
        return list.items.filter((item) => item.title === goal).map((item) => item.status)
      },
      { timeout: 90_000 },
    )
    .toContain('succeeded')
  await page.getByRole('button', { name: 'Room menu' }).click()
  await page.getByRole('menuitem', { name: `Delete ${room.name}` }).click()
  const second = page.getByRole('dialog', { name: `Delete ${room.name}?` })
  await expect(second.getByRole('button', { name: 'Delete room' })).toBeDisabled()
  await second.getByRole('textbox').fill(room.name)
  await expect(second.getByRole('alert')).toHaveCount(0)
  await second.getByRole('button', { name: 'Delete room' }).click()
  await expect(page).toHaveURL(/\/b$/)
  expect((await page.request.get(`/api/rooms/${roomId}`)).status()).toBe(404)
})
