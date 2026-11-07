import { expect, test } from '@playwright/test'
import { makeRoom } from './bold-chat-helpers.ts'
import { roomTestOptions } from './bold-room-spec-helpers.ts'
import { pair } from './pair.ts'

test.use(roomTestOptions)

test('a second job keeps its unread badge until its own tab is opened (real fake server)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await pair(page)
  await expect
    .poll(async () => (await page.request.get('/api/team-room')).status(), { timeout: 30_000 })
    .toBe(200)
  const web = { 'x-score-client': 'web' }
  // 3.28.0: the seeded team room holds two active jobs, so a new job there is refused (409 job_running). The spec's job
  // lives in a chat of its own, where it is the one active job.
  const room = await makeRoom(page, 'unread')
  // The lead's reply to a person's message into the job is the unread message nobody has opened.
  const title = `Release notes ${Date.now().toString(36)}`
  const made = await page.request.post(`/api/rooms/${room.id}/jobs`, {
    headers: web,
    data: { title },
  })
  expect(made.status()).toBe(201)
  const jobId = ((await made.json()) as { id: string }).id
  const sent = await page.request.post(`/api/rooms/${room.id}/messages`, {
    headers: web,
    data: { text: 'Draft the release notes.', to: ['lead'], jobId },
  })
  expect(sent.ok()).toBe(true)
  type RoomJob = { id: string; unread: number; activeAgents: string[] }
  const read = async () => {
    const jobs = (await (await page.request.get(`/api/rooms/${room.id}/jobs`)).json()) as {
      items: RoomJob[]
    }
    return jobs.items.find((job) => job.id === jobId)
  }
  // The reply has landed and the agents are done, so the count no longer moves.
  await expect
    .poll(
      async () => {
        const job = await read()
        return (job?.unread ?? 0) > 0 && job?.activeAgents.length === 0
      },
      { timeout: 30_000 },
    )
    .toBe(true)
  const notes = await read()
  expect(notes?.unread ?? 0).toBeGreaterThan(0)

  // One active job is the chat's current job as soon as it opens (no list to pick from, no divider, no "in <job>" pill),
  // and every message in the conversation counts as read once it is shown.
  await page.goto(`/b?room=${room.id}`)
  await expect(page.locator('.bold-job-bar')).toContainText(title)
  await expect.poll(async () => (await read())?.unread ?? 0, { timeout: 30_000 }).toBe(0)
})
