import { expect, type Locator, type Page } from '@playwright/test'
import { makeRoom } from './rooms.ts'

// Shared by the coding-agent specs: the fake CLI answers turns from hand-made fixtures, and no model is called.

export async function api(page: Page, path: string, body: object): Promise<unknown> {
  return page.evaluate(
    async ([url, payload]) => {
      const response = await fetch(url as string, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Score-Client': 'web' },
        body: JSON.stringify(payload),
      })
      return response.json()
    },
    [`/api/${path}`, body],
  )
}

/**
 * Makes a room of the test's own (specs run in parallel against one server, and the team room is shared), opens it and
 * returns it. A coding agent answers an @mention there, with its tool cards.
 */
export async function openRoom(page: Page, tag: string): Promise<Locator> {
  const room = await makeRoom(page, tag)
  await page.goto(`/b?room=${encodeURIComponent(room.id)}`)
  const main = page.locator('main')
  await expect(main.getByRole('combobox', { name: /^Message/ })).toBeVisible({ timeout: 20_000 })
  return main
}

export async function say(room: Locator, text: string): Promise<void> {
  const composer = room.getByRole('combobox', { name: /^Message/ })
  await composer.fill(text)
  await composer.press('Enter')
}

/** The messages one agent wrote, newest last. */
export function from(room: Locator, id: string): Locator {
  return room.getByRole('article', { name: new RegExp(`^Message from ${id}`) })
}

/** Removes a coding agent through "Remove agent…" on its page (a coding agent only asks to confirm). */
export async function removeCodingAgent(page: Page, id: string): Promise<void> {
  // A test that failed before it made the agent has nothing to remove (and must show its own failure, not this one).
  const list = (await (await page.request.get('/api/agents')).json()) as {
    items: { id: string; lifecycle?: { state?: string } }[]
  }
  if (!list.items.some((agent) => agent.id === id && agent.lifecycle?.state !== 'removed')) return
  await page.goto(`/b/team/${encodeURIComponent(id)}`)
  await page.getByRole('button', { name: 'Remove agent…' }).click()
  await page
    .getByRole('group', { name: `Remove ${id}` })
    .getByRole('button', { name: 'Remove', exact: true })
    .click()
  await expect(page).toHaveURL(/\/b\/team$/)
}
