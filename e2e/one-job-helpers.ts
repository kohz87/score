import { expect, type Page } from '@playwright/test'
import type { Job, Room } from '@score/contract'

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
  const room = (await response.json()) as Room
  return { ...room, label: `#${name}` }
}

export async function makeJob(page: Page, roomId: string, title: string): Promise<Job> {
  const response = await page.request.post(`/api/rooms/${roomId}/jobs`, {
    headers: { ...web, 'Idempotency-Key': `job-${Date.now()}-${Math.random()}` },
    data: { title },
  })
  expect(response.status()).toBe(201)
  return (await response.json()) as Job
}

/** Pins the team-room reads to one owned team, even while other specs add teams to the shared server. */
export async function pinTeamRoom(page: Page, room: Room, jobs: Job[] = []) {
  const team = { ...room, ...(room.everyone === undefined ? { everyone: false } : {}) }
  // A hand-off creates its job after the page has loaded; keep that new job in the pinned snapshots.
  let listed = [...jobs]
  await page.route(
    (url) => url.pathname === '/api/team-rooms',
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      await route.fulfill({ json: { asOfSeq: 12, items: [team] } })
    },
  )
  await page.route(
    (url) => url.pathname === '/api/team-room',
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      await route.fulfill({ json: { asOfSeq: 12, room: team, jobs: listed } })
    },
  )
  await page.route(
    (url) => url.pathname === `/api/rooms/${team.id}/jobs`,
    async (route) => {
      if (route.request().method() === 'POST') {
        const response = await route.fetch()
        const made = (await response.json()) as Job
        if (response.ok()) listed = [...listed.filter((job) => job.id !== made.id), made]
        return route.fulfill({ response, json: made })
      }
      if (route.request().method() !== 'GET') return route.fallback()
      await route.fulfill({ json: { asOfSeq: 12, items: listed } })
    },
  )
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
