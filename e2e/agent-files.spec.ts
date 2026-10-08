import { expect, test } from '@playwright/test'

// Reads hit the fake server. Browser POSTs are rejected by the origin check when the web port is not the
// default (SCORE_WEB_PORT), so the preview is forwarded to the real server without an Origin header, and
// PUT (which also needs a paired browser) is stubbed to exercise the 409 -> diff -> overwrite flow.
// The server side is covered by inject() tests.
test('edit SOUL.md: preview the diff, hit a conflict, see the diff and overwrite', async ({
  page,
}) => {
  await page.goto('/team/builder')
  await page.getByRole('button', { name: 'Edit personality' }).click()
  const box = page.getByRole('textbox', { name: 'SOUL.md contents' })
  await expect(box).toHaveValue(/I am builder/)
  const original = await box.inputValue()

  await page.route('**/api/agents/builder/files/SOUL.md/preview', async (route) => {
    const response = await page.request.post('/api/agents/builder/files/SOUL.md/preview', {
      headers: { 'x-score-client': 'web' },
      data: route.request().postDataJSON(),
    })
    await route.fulfill({ status: response.status(), json: await response.json() })
  })
  await box.fill(original + 'Always run the tests.\n')
  await page.getByRole('button', { name: 'Preview changes' }).click()
  const preview = page.getByLabel('Changes to save')
  await expect(preview).toContainText('+Always run the tests.')

  const bodies: { content: string; etag: string }[] = []
  await page.route('**/api/agents/builder/files/SOUL.md', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback()
    bodies.push(route.request().postDataJSON())
    if (bodies.length === 1)
      return route.fulfill({
        status: 409,
        json: {
          error: {
            code: 'conflict',
            message: 'The file changed since you loaded it',
            details: {
              etag: 'f'.repeat(64),
              diff: '--- current\n+++ proposed\n@@ -1,1 +1,1 @@\n-Theirs\n+Mine',
            },
          },
        },
      })
    return route.fulfill({ json: { etag: 'e'.repeat(64) } })
  })
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  const conflict = page.getByLabel('Their version compared with yours')
  await expect(conflict).toContainText('-Theirs')
  await expect(box).toHaveValue(original + 'Always run the tests.\n')

  await page.getByRole('button', { name: 'Overwrite with mine' }).click()
  await expect(page.getByText('Saved SOUL.md.')).toBeVisible()
  expect(bodies.map((body) => body.etag)).toEqual([bodies[0]!.etag, 'f'.repeat(64)])
  expect(bodies[1]!.content).toBe(original + 'Always run the tests.\n')
})

test('the rules file is reachable from the overview', async ({ page }) => {
  await page.goto('/team/lead')
  await page.getByRole('button', { name: 'Edit rules' }).click()
  await expect(page.getByRole('textbox', { name: 'AGENTS.md contents' })).toHaveValue(
    /Keep changes small/,
  )
})
