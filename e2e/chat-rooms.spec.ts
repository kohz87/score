import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'
import { makeRoom, openRoom } from './rooms.ts'

// PLAN 5.36 against the fake adapter: rename a room inline, delete one with the typed name (an ordinary room and a
// finished orchestration's), and compact an agent's context from the ring or with /compress.
const conversations = (page: Page) => page.getByRole('navigation', { name: 'Conversations' })

// A room's menu closes when the list re-renders under it (stream updates): open it again until the item shows.
async function openMenuItem(page: Page, button: RegExp | string, item: string) {
  await expect(async () => {
    await conversations(page).getByRole('button', { name: button }).first().click()
    await page.getByRole('menuitem', { name: item }).click({ timeout: 3000 })
  }).toPass({ timeout: 30_000 })
}

test('rename: click the title, Enter saves, Escape cancels, a bad name stays open', async ({
  page,
}) => {
  await pair(page)
  const room = await makeRoom(page, 'ren')
  await openRoom(page, room.label)
  await page.getByRole('button', { name: `${room.label} (rename)` }).click()
  const box = page.getByRole('textbox', { name: 'Room name' })
  await box.fill('Not Valid!')
  await box.press('Enter')
  await expect(page.getByRole('alert').filter({ hasText: 'lowercase' })).toBeVisible()
  const base = room.name.replace(/^#/, '')
  const renamed = `${base}-v2`
  await box.fill(`${renamed} #q4`)
  await box.press('Enter')
  await expect(page.getByRole('heading', { level: 1, name: `#${renamed}` })).toBeVisible()
  await expect(conversations(page).getByRole('link', { name: `#${renamed}` })).toBeVisible()
  await page.getByRole('button', { name: `#${renamed} (rename)` }).click()
  await page.getByRole('textbox', { name: 'Room name' }).press('Escape')
  await expect(page.getByRole('textbox', { name: 'Room name' })).toHaveCount(0)
  // The room menu renames as well.
  await conversations(page)
    .getByRole('button', { name: `Actions for #${renamed}` })
    .click()
  await page.getByRole('menuitem', { name: 'Rename…' }).click()
  await page.getByRole('menu').getByRole('textbox', { name: 'Room name' }).fill(`${renamed}-b`)
  await page.getByRole('menu').getByRole('textbox', { name: 'Room name' }).press('Enter')
  await expect(page.getByRole('heading', { level: 1, name: `#${renamed}-b` })).toBeVisible()
})

test('delete a room: the dialog says what goes, needs the typed name, then Chat home', async ({
  page,
}) => {
  await pair(page)
  const room = await makeRoom(page, 'del')
  await openRoom(page, room.label)
  await conversations(page)
    .getByRole('button', { name: `Actions for ${room.name}` })
    .click()
  await page.getByRole('menuitem', { name: 'Delete room…' }).click()
  const dialog = page.getByRole('dialog', { name: `Delete ${room.name}?` })
  await expect(dialog.getByText(/will be removed from Score for good/)).toBeVisible()
  await expect(dialog.getByText(/Hermes sessions are/)).toBeVisible()
  await expect(dialog.getByRole('link', { name: 'Export as Markdown' })).toBeVisible()
  const confirm = dialog.getByRole('button', { name: 'Delete room' })
  await expect(confirm).toBeDisabled()
  await dialog.getByRole('textbox').fill(room.name.slice(0, -1))
  await expect(confirm).toBeDisabled()
  await dialog.getByRole('textbox').fill(room.name)
  await confirm.click()
  await expect(dialog).toBeHidden()
  await expect(page).toHaveURL(/\/chat$/)
  await expect(conversations(page).getByRole('link', { name: room.label })).toHaveCount(0)
  // Gone for good: the room's address is not found any more.
  const gone = await page.request.get(`/api/rooms/${room.id}`)
  expect(gone.status()).toBe(404)
})

test('a finished orchestration room can be deleted too', async ({ page }) => {
  test.setTimeout(120_000)
  await pair(page)
  await page.goto('/chat')
  await page.getByRole('button', { name: /New orchestration/ }).click()
  const start = page.getByRole('dialog', { name: 'New orchestration' })
  await start.getByRole('textbox', { name: 'Goal' }).fill('Delete me e2e-del')
  await start.getByRole('combobox', { name: 'Lead' }).selectOption({ label: 'lead' })
  await start.getByRole('checkbox', { name: /builder/ }).check()
  await start.getByRole('checkbox', { name: /reviewer/ }).check()
  await start.getByRole('radio', { name: 'Never ask' }).check()
  await start.getByRole('checkbox', { name: /Score controls the work it starts/ }).check()
  await start.getByRole('button', { name: 'Start orchestration' }).click()
  await expect(start).toBeHidden()
  // While the run owns the room it can't be deleted.
  const name = `orch-${Date.now().toString(36)}`
  await openMenuItem(page, /^Actions for #?Orchestration/, 'Delete room…')
  const dialog = page.getByRole('dialog', { name: /^Delete Orchestration.*\?$/ })
  await expect(dialog.getByRole('alert')).toContainText('still owns this room')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  // Renaming is allowed meanwhile.
  await page.getByRole('button', { name: /\(rename\)$/ }).click()
  await page.getByRole('textbox', { name: 'Room name' }).fill(name)
  await page.getByRole('textbox', { name: 'Room name' }).press('Enter')
  await expect(page.getByRole('heading', { level: 1, name: `#${name}` })).toBeVisible()
  // No gates: the run finishes by itself and releases the room.
  await expect
    .poll(
      async () => {
        const list = (await (await page.request.get('/api/orchestrations')).json()) as {
          items: { status: string }[]
        }
        return list.items.map((item) => item.status)
      },
      { timeout: 90_000 },
    )
    .toContain('succeeded')
  await openMenuItem(page, `Actions for #${name}`, 'Delete room…')
  const second = page.getByRole('dialog', { name: `Delete #${name}?` })
  await expect(second.getByRole('button', { name: 'Delete room' })).toBeDisabled()
  await second.getByRole('textbox').fill(`#${name}`)
  await expect(second.getByRole('alert')).toHaveCount(0)
  await second.getByRole('button', { name: 'Delete room' }).click()
  await expect(page).toHaveURL(/\/chat$/)
  await expect(page.getByText('Choose a conversation to see its messages.')).toBeVisible()
})

test('compact from the ring: it asks first, shows Hermes’s before and after, and the ring shrinks', async ({
  page,
}) => {
  await pair(page)
  const room = await makeRoom(page, 'cmp', ['lead', 'reviewer'])
  await openRoom(page, room.label)
  const ring = page.getByRole('button', { name: /context: 42 % of 128k/ })
  await expect(ring).toBeVisible({ timeout: 15_000 })
  await ring.click()
  const panel = page.getByRole('dialog', { name: /context details/ })
  await expect(panel.getByText('What is using it')).toBeVisible()
  await expect(panel.getByRole('listitem').filter({ hasText: 'Messages' })).toBeVisible()
  await expect(panel.getByText(/Hermes compacts automatically at 64,000 tokens/)).toBeVisible()
  await panel.getByRole('button', { name: 'Compact' }).click()
  await expect(panel.getByText(/Hermes will summarise .*older turns/)).toBeVisible()
  await panel.getByRole('button', { name: 'Compact now' }).click()
  await expect(panel.getByText(/Compacted: 40 → 12 messages, 54,000 → 9,000 tokens/)).toBeVisible({
    timeout: 15_000,
  })
  await expect(page.getByRole('button', { name: /context: 7 % of 128k/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
})

test('/compress asks for confirmation instead of sending a message, then compacts', async ({
  page,
}) => {
  await pair(page)
  const room = await makeRoom(page, 'cps', ['lead', 'reviewer'])
  await openRoom(page, room.label)
  await expect(page.getByRole('button', { name: /context: 42 % of 128k/ })).toBeVisible({
    timeout: 15_000,
  })
  const composer = page.getByRole('combobox', { name: /^Message/ })
  await composer.fill('/compress')
  await composer.press('Enter')
  await composer.press('Enter')
  const panel = page.getByRole('dialog', { name: /context details/ })
  await expect(panel.getByText(/Hermes will summarise .*older turns/)).toBeVisible()
  await expect(composer).toHaveValue('')
  await panel.getByLabel('Exchanges kept word for word').fill('3')
  await panel.getByRole('button', { name: 'Compact now' }).click()
  await expect(panel.getByText(/Compacted: 40 → 14 messages/)).toBeVisible({ timeout: 15_000 })
  // Nothing was posted to the room.
  await expect(
    page.getByRole('region', { name: 'Message history' }).getByRole('article'),
  ).toHaveCount(0)
})
