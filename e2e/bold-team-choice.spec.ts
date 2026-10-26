import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'

// 3.6.0 (decision 137): with a second team room, a trigger and a one-to-one share can name the team the work goes to.
test.use({ reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } })
test.describe.configure({ mode: 'serial' })

const web = { 'x-score-client': 'web' }

function tag(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

test('a trigger starts jobs in the second team, and a one-to-one reply is shared into its job', async ({
  page,
}: {
  page: Page
}) => {
  await pair(page)
  const teamName = tag('Docs crew')
  const jobTitle = tag('Crew job')

  const made = await page.request.post('/api/team-rooms', {
    headers: { ...web, 'Idempotency-Key': tag('team') },
    data: { name: teamName, members: ['builder', 'reviewer'], leadAgentId: 'reviewer' },
  })
  expect(made.status()).toBe(201)
  const team = (await made.json()) as { id: string }
  const job = await page.request.post(`/api/rooms/${team.id}/jobs`, {
    headers: { ...web, 'Idempotency-Key': tag('job') },
    data: { title: jobTitle },
  })
  expect(job.status()).toBe(201)
  const jobId = ((await job.json()) as { id: string }).id
  let triggerId: string | null = null

  try {
    // Trigger settings: the choice appears with two teams, and the team round-trips.
    await page.goto('/b/settings/tools')
    await page.getByRole('button', { name: 'New trigger' }).click()
    const dialog = page.getByRole('dialog', { name: 'New trigger' })
    const select = dialog.getByLabel('Starts jobs in')
    await expect(select).toBeVisible()
    await select.selectOption({ label: teamName })
    const name = tag('Team trigger')
    await dialog.getByLabel('Name').fill(name)
    await dialog.getByLabel('App it comes from').fill('Tickets app')
    await dialog.getByRole('button', { name: 'Create the address' }).click()
    await expect(dialog.locator('[data-trigger-secret]')).toBeVisible()
    const listed = (await (await page.request.get('/api/triggers')).json()) as {
      items: { id: string; name: string; teamRoomId: string | null }[]
    }
    const saved = listed.items.find((item) => item.name === name)
    expect(saved?.teamRoomId).toBe(team.id)
    triggerId = saved!.id

    // A one-to-one: the share menu offers the team choice and that team's jobs.
    await page.goto('/b?with=reviewer')
    const side = page.locator('#bold-side-panel')
    await expect(side.locator('.bold-dm-message').first()).toBeVisible()
    await side.getByRole('button', { name: 'Share to the team room' }).click()
    const menu = page.getByRole('dialog', { name: 'Share to a team' })
    await expect(menu).toHaveAttribute('data-protected', 'block')
    await menu.getByLabel('Team').selectOption({ label: teamName })
    await menu.getByRole('button', { name: new RegExp(jobTitle) }).click()
    await expect(
      side.getByRole('status').filter({ hasText: 'Shared to the team room' }),
    ).toBeVisible()

    // The job of the second team shows the frozen copy.
    await page.goto(`/b?room=${team.id}&job=${jobId}`)
    await expect(page.locator('.bold-shared')).toHaveCount(1)
  } finally {
    if (triggerId) await page.request.delete(`/api/triggers/${triggerId}`, { headers: web })
    await page.request.delete(`/api/rooms/${team.id}`, { headers: web })
  }
})
