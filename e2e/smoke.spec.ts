import { expect, test } from '@playwright/test'

test('app shell loads, API proxy works, no external font requests', async ({ page }) => {
  const external: string[] = []
  page.on('request', (req) => {
    const url = new URL(req.url())
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') external.push(req.url())
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'score' })).toBeVisible()

  const health = await page.request.get('/api/health')
  expect(health.ok()).toBe(true)
  expect(await health.json()).toMatchObject({ ok: true })

  expect(external).toEqual([])
})
