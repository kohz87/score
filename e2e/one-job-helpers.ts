import { expect, type Page } from '@playwright/test'

// 3.28.0: a chat holds one active job, and the seeded team room already has two. Specs that start work make a team room
// of their own (the server is shared, so the seeded jobs are never ended).
const web = { 'x-score-client': 'web' }

export async function makeTeam(page: Page, tag: string, members = ['lead', 'builder', 'reviewer']) {
  const name = `${tag}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const response = await page.request.post('/api/team-rooms', {
    headers: { ...web, 'Idempotency-Key': `team-${name}` },
    data: { name, members, leadAgentId: members[0] },
  })
  expect(response.status()).toBe(201)
  const room = (await response.json()) as { id: string; name: string }
  return { ...room, label: `#${name}` }
}

export async function roomJobs(page: Page, roomId: string) {
  const response = await page.request.get(`/api/rooms/${roomId}/jobs`)
  expect(response.ok()).toBe(true)
  return (
    (await response.json()) as {
      items: { id: string; title: string; recipe: { kind: string; ref: string } | null }[]
    }
  ).items
}

/**
 * Clicks "Start the job" on the open Start a job dialog. The default chat (the seeded team room) already holds jobs, so
 * the busy dialog "<chat> already has a job" opens: this takes "Start in another chat…", picks a team room made for the
 * test, and starts there. Returns the chat the work started in (null when nothing asked).
 */
export async function startInOwnChat(page: Page, tag: string) {
  const dialog = page.getByRole('dialog', { name: 'Start a job' })
  await dialog.getByRole('button', { name: 'Start the job' }).click()
  const busy = page.getByRole('dialog', { name: /already has a job/ })
  const other = busy.getByRole('button', { name: /Start in another chat/ })
  await expect(other.or(dialog.getByRole('heading', { name: 'Started' }))).toBeVisible({
    timeout: 30_000,
  })
  if (!(await other.isVisible())) return null
  const team = await makeTeam(page, tag)
  await other.click()
  await dialog.getByLabel('Start it in').selectOption({ value: team.id })
  const start = dialog.getByRole('button', { name: 'Start the job' })
  await expect(start).toBeEnabled({ timeout: 30_000 })
  await start.click()
  return team
}
