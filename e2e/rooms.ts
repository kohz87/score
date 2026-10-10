import { expect, type Page } from '@playwright/test'

const web = { 'x-score-client': 'web' }

// Specs run in parallel against one server and the fake #activity-feed room is shared (and capped at one 50-message page),
// so a spec that posts or stops runs makes its own room, with a short unique name.
export async function makeRoom(page: Page, tag: string) {
  const name = `${tag}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const response = await page.request.post('/api/rooms', {
    headers: web,
    data: { name, leadAgentId: 'lead', members: ['lead'] },
  })
  expect(response.ok()).toBe(true)
  const room = (await response.json()) as { id: string; name: string }
  return { ...room, label: `#${name}` }
}

export async function say(page: Page, roomId: string, text: string) {
  const response = await page.request.post(`/api/rooms/${roomId}/messages`, {
    headers: web,
    data: { text, to: ['lead'] },
  })
  expect(response.ok()).toBe(true)
}

export async function openRoom(page: Page, label: string) {
  await page.goto('/chat')
  await page
    .getByRole('navigation', { name: 'Conversations' })
    .getByRole('link', { name: label })
    .click({ timeout: 15_000 })
}
