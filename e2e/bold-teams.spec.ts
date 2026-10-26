import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'

// 3.4.0 (decision 136): a second team of chosen agents next to the first team room, on the fake adapter.
test.use({ reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } })

function tag(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

async function jobTitles(page: Page, roomId: string): Promise<string[]> {
  const response = await page.request.get(`/api/rooms/${roomId}/jobs`)
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { items: { title: string }[] }).items.map((job) => job.title)
}

test('make a team, start a job in it, rename and delete it; the first team room stays as it is', async ({
  page,
}) => {
  await pair(page)
  const name = tag('Review crew')
  const renamed = tag('Crew two')
  const jobTitle = tag('Team job')
  await page.goto('/b')
  const first = (await (await page.request.get('/api/team-room')).json()) as {
    room: { id: string; everyone?: boolean }
  }
  expect(first.room.everyone).toBe(true)

  // The first team room refuses a rename (and has no menu row for it).
  await page.getByRole('button', { name: 'Room menu' }).click()
  await expect(page.getByRole('menuitem', { name: 'Rename…' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  const refused = await page.request.patch(`/api/rooms/${first.room.id}`, {
    headers: { 'x-score-client': 'web' },
    data: { name: 'Not allowed' },
  })
  expect(refused.ok()).toBe(false)

  // New team…: builder + reviewer, led by reviewer.
  await page.locator('.roomtitle').click()
  await page.getByRole('option', { name: /New team…/ }).click()
  const dialog = page.getByRole('dialog', { name: 'New team' })
  await expect(dialog).toHaveAttribute('data-protected', 'any')
  await dialog.getByRole('textbox', { name: 'Name' }).fill(name)
  await dialog.getByRole('checkbox', { name: 'builder' }).check()
  await dialog.getByRole('checkbox', { name: 'reviewer' }).check()
  await dialog.getByRole('combobox', { name: 'Lead' }).selectOption({ label: 'reviewer' })
  await dialog.getByRole('button', { name: 'Create team' }).click()
  await expect(dialog).toBeHidden()
  await expect(page).toHaveURL(/\/b\?room=/)
  await expect(page.locator('.roomtitle')).toContainText(name)
  const roomId = new URL(page.url()).searchParams.get('room')!
  const made = (await (await page.request.get(`/api/rooms/${roomId}`)).json()) as {
    room: { role: string; everyone: boolean; members: string[]; leadAgentId: string }
  }
  expect(made.room).toMatchObject({ role: 'team', everyone: false, leadAgentId: 'reviewer' })
  expect([...made.room.members].sort()).toEqual(['builder', 'reviewer'])

  // A job started here lands here, not in the first team room.
  await page.getByRole('button', { name: 'Start a job' }).click()
  const start = page.getByRole('dialog', { name: 'Start a job' })
  await start.getByRole('radio', { name: 'None' }).click()
  await start.getByLabel('What should the team do?').fill(jobTitle)
  await start.getByRole('checkbox', { name: /Score controls the work it starts/ }).check()
  await start.getByRole('button', { name: 'Start the job' }).click()
  await expect(start.getByRole('heading', { name: 'Started' })).toBeVisible()
  await expect.poll(() => jobTitles(page, roomId)).toContain(jobTitle)
  expect(await jobTitles(page, first.room.id)).not.toContain(jobTitle)
  await start.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByRole('tab', { name: new RegExp(jobTitle) })).toBeVisible()

  // Rename it.
  await page.getByRole('button', { name: 'Room menu' }).click()
  await page.getByRole('menuitem', { name: 'Rename…' }).click()
  const rename = page.getByRole('dialog', { name: 'Rename room' })
  await rename.getByRole('textbox').fill(renamed)
  await rename.getByRole('button', { name: 'Rename' }).click()
  await expect(rename).toBeHidden()
  await expect(page.locator('.roomtitle')).toContainText(renamed)
  // Its link survives a reload (the room is read by id, not found in a list first).
  await page.reload()
  await expect(page.locator('.roomtitle')).toContainText(renamed)

  // Delete it; the first team room is what is left.
  await page.getByRole('button', { name: 'Room menu' }).click()
  await page.getByRole('menuitem', { name: `Delete ${renamed}` }).click()
  const remove = page.getByRole('dialog', { name: `Delete ${renamed}?` })
  await remove.getByRole('textbox').fill(renamed)
  await remove.getByRole('button', { name: 'Delete room' }).click()
  await expect(remove).toBeHidden()
  await expect(page).toHaveURL(/\/b$/)
  await expect(page.locator('.roomtitle')).toHaveText('Team room')
  expect((await page.request.get(`/api/rooms/${roomId}`)).status()).toBe(404)
})
