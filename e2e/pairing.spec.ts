import { expect, test } from '@playwright/test'

// The /pair page (the pairing parts of the old shell.spec.ts): the link's token leaves the URL before the request,
// the page says what happened, and a reload does not try the token again.
for (const status of [204, 401]) {
  test(`pairing clears its token from the URL and handles ${status}`, async ({ page }) => {
    let requests = 0
    await page.route('**/api/session/pair', async (route) => {
      requests += 1
      expect(route.request().postDataJSON()).toEqual({ token: 'example-token' })
      expect(route.request().headers()['x-score-client']).toBe('web')
      expect(await page.evaluate(() => location.hash)).toBe('')
      await route.fulfill(
        status === 204
          ? { status }
          : { status, json: { error: { code: 'not_paired', message: 'Invalid token' } } },
      )
    })
    await page.goto('/pair#example-token')
    await expect(page.getByRole('heading', { name: 'Pair this browser' })).toBeVisible()
    await expect(page.getByRole('status')).toContainText(
      status === 204 ? 'This browser is paired' : 'invalid or expired',
    )
    await expect(page).toHaveURL('/pair')
    expect(requests).toBe(1)
    await page.reload()
    await expect(page.getByRole('status')).toContainText('server terminal at startup')
    expect(requests).toBe(1)
  })
}
