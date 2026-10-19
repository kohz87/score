import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { pair } from './pair.ts'

const web = { 'x-score-client': 'web' }
const SHARE_PASSWORD = 'e2e share password'

// Each spec makes its own room (a short unique name), so parallel specs never touch the same one.
async function makeRoom(page: Page, tag: string) {
  const name = `${tag}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const response = await page.request.post('/api/rooms', {
    headers: web,
    data: { name, leadAgentId: 'lead', members: ['lead'] },
  })
  expect(response.ok()).toBe(true)
  const room = (await response.json()) as { id: string; name: string }
  return { ...room, label: `#${name}` }
}
async function say(page: Page, roomId: string, text: string) {
  const response = await page.request.post(`/api/rooms/${roomId}/messages`, {
    headers: web,
    data: { text, to: ['lead'] },
  })
  expect(response.ok()).toBe(true)
}
const conversations = (page: Page) => page.getByRole('navigation', { name: 'Rooms' })
const rowMenu = (page: Page, label: string) =>
  page.getByRole('button', { name: `Actions for ${label}` })

test('pin, archive, project and tags organise the room list', async ({ page }) => {
  await pair(page)
  const room = await makeRoom(page, 'org')
  await page.goto('/chat')
  const list = conversations(page)
  const link = list.getByRole('link', { name: room.label })
  await expect(link).toBeVisible({ timeout: 15_000 })

  await rowMenu(page, room.label).click()
  await page.getByRole('menuitem', { name: 'Pin to top' }).click()
  await expect(
    list.getByRole('region', { name: 'Pinned rooms' }).getByRole('link', { name: room.label }),
  ).toBeVisible()

  // Keyboard: the menu opens on Enter, moves with the arrow keys and closes with Escape.
  await rowMenu(page, room.label).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menuitem', { name: 'Rename…' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: 'Unpin' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: 'Archive' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(rowMenu(page, room.label)).toBeFocused()

  // Project: create it, move the room into it, collapse and expand the group.
  const project = `Launch ${Date.now().toString(36)}`
  await list.getByRole('button', { name: '＋ Project' }).click()
  await page.getByLabel('Project name').fill(project)
  await page.getByRole('radio', { name: 'Jade' }).check({ force: true })
  await page.getByRole('button', { name: 'Save' }).click()
  await rowMenu(page, room.label).click()
  await page.getByRole('menuitem', { name: 'Unpin' }).click()
  await rowMenu(page, room.label).click()
  await page.getByRole('menuitem', { name: 'Move to project…' }).click()
  await page.getByRole('combobox', { name: 'Project' }).selectOption({ label: project })
  const group = list.getByRole('region', { name: `Project ${project}` })
  await expect(group.getByRole('link', { name: room.label })).toBeVisible()
  await group.getByRole('button', { name: new RegExp(project), expanded: true }).click()
  await expect(group.getByRole('link', { name: room.label })).toHaveCount(0)
  await group.getByRole('button', { name: new RegExp(project), expanded: false }).click()
  await expect(group.getByRole('link', { name: room.label })).toBeVisible()

  // Tags: set explicitly; clicking the chip filters the list.
  await rowMenu(page, room.label).click()
  await page.getByRole('menuitem', { name: 'Edit tags…' }).click()
  await page.getByRole('textbox', { name: /^Tags/ }).fill('q4 urgent')
  await page.getByRole('button', { name: 'Save' }).click()
  const filter = list.getByRole('list', { name: 'Filter by tag' })
  await filter.getByRole('button', { name: '#urgent' }).click()
  await expect(list.getByRole('link', { name: room.label })).toBeVisible()
  await expect(list.getByRole('link', { name: '#activity-feed' })).toHaveCount(0)
  await filter.getByRole('button', { name: '#urgent' }).click()
  await expect(list.getByRole('link', { name: '#activity-feed' })).toBeVisible()

  // Archive hides it behind "Show archived"; unarchive brings it back. It all survives a reload.
  await rowMenu(page, room.label).click()
  await page.getByRole('menuitem', { name: 'Archive' }).click()
  await expect(list.getByRole('link', { name: room.label })).toHaveCount(0)
  await page.reload()
  await expect(list.getByRole('link', { name: '#activity-feed' })).toBeVisible({ timeout: 15_000 })
  await expect(list.getByRole('link', { name: room.label })).toHaveCount(0)
  await list.getByRole('button', { name: /^Show archived/ }).click()
  await expect(list.getByRole('link', { name: room.label })).toBeVisible()
  await rowMenu(page, room.label).click()
  await page.getByRole('menuitem', { name: 'Unarchive' }).click()
  await list.getByRole('button', { name: 'Hide archived' }).click()
  await expect(list.getByRole('link', { name: room.label })).toBeVisible()

  // Clean up the project so other runs of the list stay short.
  await group.getByRole('button', { name: `Edit project ${project}` }).click()
  await page.getByRole('button', { name: 'Delete project' }).click()
  await expect(list.getByRole('region', { name: `Project ${project}` })).toHaveCount(0)
})

test('searching message text opens the room at that message', async ({ page }) => {
  await pair(page)
  const room = await makeRoom(page, 'find')
  const word = `needle${Date.now().toString(36)}`
  await say(page, room.id, `Where did the ${word} go?`)
  await page.goto('/chat')
  await page.getByRole('searchbox', { name: 'Search messages' }).fill(word)
  const hit = page
    .getByRole('list', { name: 'Search results' })
    .getByRole('link')
    .filter({ hasText: word })
    .first()
  await expect(hit).toBeVisible({ timeout: 15_000 })
  await expect(hit.locator('mark')).toHaveText(word)
  await hit.click()
  await expect(page).toHaveURL(new RegExp(`/chat/${room.id}\\?message=`))
  const target = page.getByRole('article', { name: 'Message from You' }).filter({ hasText: word })
  await expect(target).toBeVisible({ timeout: 15_000 })
  await expect(target).toHaveClass(/chat-message--hit/)

  // The command palette searches messages too.
  await page.keyboard.press('Control+k')
  await page.getByRole('searchbox', { name: 'Search destinations' }).fill(word)
  const section = page.getByRole('region', { name: 'Messages' })
  await expect(section.getByRole('link').first()).toBeVisible({ timeout: 15_000 })
})

test('export downloads a Markdown transcript and a JSON file', async ({ page }) => {
  await pair(page)
  const room = await makeRoom(page, 'export')
  const text = `Exportable line ${Date.now()}`
  await say(page, room.id, text)
  await page.goto('/chat')
  await rowMenu(page, room.label).click({ timeout: 15_000 })
  const markdown = page.waitForEvent('download')
  await page.getByRole('menuitem', { name: 'Export as Markdown' }).click()
  const md = await markdown
  expect(md.suggestedFilename()).toMatch(/^score-.*\.md$/)
  const mdText = readFileSync((await md.path())!, 'utf8')
  expect(mdText).toContain(`# ${room.label}`)
  expect(mdText).toContain('Exported at:')
  expect(mdText).toContain(text)

  await rowMenu(page, room.label).click()
  const json = page.waitForEvent('download')
  await page.getByRole('menuitem', { name: 'Export as JSON' }).click()
  const data = JSON.parse(readFileSync((await (await json).path())!, 'utf8')) as {
    room: { name: string }
    messages: { text: string }[]
  }
  expect(data.room.name).toBe(room.name)
  expect(data.messages.some((message) => message.text === text)).toBe(true)
})

test('a share link opens a static page without the app, and revoking it makes it 404', async ({
  page,
  browser,
}) => {
  await pair(page)
  // The security password guards link creation; set it if this server has none yet.
  await page.request.put('/api/session/security/password', {
    headers: web,
    data: { password: SHARE_PASSWORD },
  })
  const room = await makeRoom(page, 'share')
  const text = `Shared words ${Date.now()}`
  await say(page, room.id, `${text} api_key=sk-abcdefghijklmnop123`)
  await page.goto('/chat')
  await rowMenu(page, room.label).click({ timeout: 15_000 })
  await page.getByRole('menuitem', { name: 'Share…' }).click()
  const dialog = page.getByRole('dialog', { name: new RegExp(`Share ${room.label}`) })
  await expect(dialog.getByText(/can reach this Score/)).toBeVisible()
  await dialog.getByLabel('Security password').fill('not the password')
  await dialog.getByRole('button', { name: 'Create link' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('That is not the security password.')
  await dialog.getByLabel('Security password').fill(SHARE_PASSWORD)
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

  // Settings › Shares lists nothing for the revoked link.
  await page.goto('/settings/shares')
  await expect(page.getByRole('region', { name: 'Shares' })).toBeVisible()
})

test('an outside session can be imported into a room and continued here', async ({ page }) => {
  await pair(page)
  await page.goto('/chat')
  const elsewhere = conversations(page).locator('.chat-outside')
  await elsewhere.getByRole('button', { name: 'Show' }).click({ timeout: 15_000 })
  const telegram = elsewhere.getByRole('region', { name: 'Telegram' })
  await expect(telegram.getByText('Plan the launch checklist')).toBeVisible({ timeout: 15_000 })
  const importButton = telegram.getByRole('button', { name: /^Import/ })
  if (await importButton.count()) await importButton.click()
  else await telegram.getByRole('link', { name: /^Open the imported room/ }).click()
  const banner = page.getByRole('region', { name: 'Imported conversation' })
  await expect(banner.getByText(/Imported from Telegram/)).toBeVisible({ timeout: 15_000 })
  const history = page.getByRole('region', { name: 'Message history' })
  await expect(
    history.getByText('Can you outline the launch checklist for next week?'),
  ).toBeVisible()
  await expect(history.getByText('from Telegram').first()).toBeVisible()
  expect(await page.content()).not.toContain('sk-fakefakefakefake123')
  await expect(history.getByRole('button', { name: /^Edit message/ })).toHaveCount(0)
  const continueHere = banner.getByRole('button', { name: 'Continue here' })
  if (await continueHere.count()) await continueHere.click()
  await expect(banner.getByRole('status')).toContainText('same Hermes session')

  // A new message goes to the agent as usual.
  const composer = page.getByRole('combobox', { name: /^Message/ })
  await composer.fill(`Anything left? ${Date.now()}`)
  await composer.press('Enter')
  await expect(history.getByRole('article', { name: /Message from lead/ }).last()).toBeVisible({
    timeout: 20_000,
  })
})
