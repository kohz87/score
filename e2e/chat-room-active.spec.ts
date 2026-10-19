import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'

// PLAN 10.11: the sidebar's icons next to a room are the members busy there now, so an icon shows while a reply
// streams and goes when it ends (here: stopped, since the fake adapter's "go quiet" reply stays open until then).
test('the sidebar shows a member while their reply streams and drops them after', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await pair(page)
  await page.goto('/chat')
  const name = `busy-${Date.now()}`
  const room = await page.evaluate(async (title) => {
    const response = await fetch('/api/rooms', {
      method: 'POST',
      headers: {
        'X-Score-Client': 'web',
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify({ name: title, leadAgentId: 'lead' }),
    })
    return ((await response.json()) as { id: string }).id
  }, name)
  await page.goto(`/chat/${room}`)
  const link = page.locator(`a.chat-room-link[href$="/${room}"]`)
  const icons = link.locator('.chat-active-agents svg.agent-glyph')
  await expect(link).toBeVisible()
  await expect(icons).toHaveCount(0)
  const composer = page.getByRole('combobox', { name: /^Message/ })
  await composer.fill(`Please go quiet ${Date.now()}`)
  await composer.press('Enter')
  const history = page.getByRole('region', { name: 'Message history' })
  const stop = history.getByRole('button', { name: /^Stop reply from/ })
  await expect(stop).toBeVisible({ timeout: 20_000 })
  await expect(icons).toHaveCount(1)
  await stop.click()
  await expect(history.getByText('This run was stopped.')).toBeVisible({ timeout: 20_000 })
  await expect(icons).toHaveCount(0)
})
