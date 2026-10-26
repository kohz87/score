import { expect, test } from '@playwright/test'

// The fake adapter is always a tested build, so the paused state and the check are stubbed at the network edge;
// the server side is covered by apps/server/test/hermes/live/hermes-check.test.ts.
const hash = 'c'.repeat(64)
const status = (tested: boolean) => ({
  mode: 'live',
  hermes: {
    version: '0.21.6',
    reachable: true,
    apiServer: true,
    capabilities: [],
    servedProfiles: [],
  },
  bridge: { producers: 0, lastSeenAt: null, isolation: 'unknown' },
  compatibility: { fingerprint: 'f', tested, disabled: tested ? [] : ['gateway-approvals'] },
  agentIsolation: 'same_user',
  degraded: [],
})

test('a paused Hermes build is checked and re-enabled with one confirmed click', async ({
  page,
}) => {
  let tested = false
  await page.route('**/api/system', (route) => route.fulfill({ json: status(tested) }))
  await page.route('**/api/settings/hermes/check', (route) =>
    route.fulfill({
      json: {
        hash,
        build: { version: '0.21.6', codeSha: 'd'.repeat(40), fingerprint: 'e'.repeat(16) },
        compatible: true,
        parts: [
          { name: 'Hermes version', status: 'changed', detail: '0.21.5 → 0.21.6' },
          { name: 'Capabilities', status: 'same', detail: '20 unchanged' },
        ],
      },
    }),
  )
  await page.route('**/api/settings/hermes/accept', (route) => {
    tested = true
    return route.fulfill({ json: { ok: true } })
  })
  // Every page of the shell says approvals are paused (the old header marker), and the link leads to the check.
  await page.goto('/b/team')
  const notice = page.getByRole('status').filter({ hasText: 'Approvals in Score are paused' })
  await expect(notice).toHaveAttribute('data-protected', 'flex')
  await notice.getByRole('link', { name: 'Check this Hermes version' }).click()
  await expect(page).toHaveURL(/\/b\/settings\/connections$/)
  const banner = page.getByRole('region', { name: 'Hermes was updated' })
  await expect(banner).toContainText('Approvals in Score are paused until you check this version.')
  // The Settings pages carry the check itself, not a second notice.
  await expect(page.locator('.bold-fence-notice')).toHaveCount(0)
  await banner.getByRole('button', { name: 'Check this Hermes version' }).click()
  await expect(banner.getByRole('table')).toContainText('0.21.5 → 0.21.6')
  await banner.getByRole('button', { name: 'Turn approvals back on' }).click()
  await expect(banner).toBeHidden()
  await page.goto('/b/team')
  await expect(page.getByRole('heading', { name: 'Your team', level: 1 })).toBeVisible()
  await expect(page.locator('.bold-fence-notice')).toHaveCount(0)
})

test('a changed Hermes build stays paused and lists what changed', async ({ page }) => {
  await page.route('**/api/system', (route) => route.fulfill({ json: status(false) }))
  await page.route('**/api/settings/hermes/check', (route) =>
    route.fulfill({
      json: {
        hash,
        build: { version: '0.22.0', codeSha: 'd'.repeat(40), fingerprint: 'e'.repeat(16) },
        compatible: false,
        parts: [
          {
            name: 'Kanban database schema',
            status: 'changed',
            detail: 'The database layout differs.',
          },
        ],
      },
    }),
  )
  await page.goto('/b/settings/connections')
  const banner = page.getByRole('region', { name: 'Hermes was updated' })
  await banner.getByRole('button', { name: 'Check this Hermes version' }).click()
  await expect(banner.getByRole('status')).toContainText('Changed: Kanban database schema')
  await expect(banner.getByRole('button', { name: 'Turn approvals back on' })).toHaveCount(0)
  await banner.getByRole('button', { name: 'Stay paused' }).click()
  await expect(banner.getByRole('button', { name: 'Check this Hermes version' })).toBeVisible()
})
