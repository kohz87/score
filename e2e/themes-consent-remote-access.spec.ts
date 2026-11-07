import { expect, test, type Page } from '@playwright/test'
import { ACCEPTED_TOKEN, custom, drawn, expectRefused, wear } from './themes-consent-helpers.ts'

// ---------------------------------------------------------------------------------------------------------------------
// Settings > Remote access (a password is set) and the pair page

/** Marks the page as served over TLS (the server does that in remote mode) so the remote-only screens render. */
async function asRemote(page: Page, path: string) {
  await page.route(
    (url) => url.pathname === path,
    async (route) => {
      if (route.request().resourceType() !== 'document') return route.fallback()
      const response = await route.fetch()
      const html = (await response.text()).replace('<html', '<html data-score-transport="tls"')
      await route.fulfill({ response, body: html })
    },
  )
}

const now = '2026-10-19T00:00:00.000Z'
const browserId = '11111111-1111-4111-8111-111111111111'
const otherId = '22222222-2222-4222-8222-222222222222'

test.describe('X1: remote access with a password set is one decision', () => {
  async function remoteSection(page: Page) {
    const sent: string[] = []
    await page.route('**/api/session/security', (route) =>
      route.fulfill({
        json: {
          passwordSet: true,
          origins: ['https://score.example.ts.net'],
          terminal: false,
          terminalUnavailable: null,
          unlockedUntil: new Date(Date.now() + 3_600_000).toISOString(),
        },
      }),
    )
    await page.route('**/api/session/browsers', (route) =>
      route.fulfill({
        json: {
          items: [
            {
              id: browserId,
              label: 'This laptop',
              address: '10.0.0.2',
              createdAt: now,
              lastSeenAt: now,
              expiresAt: now,
              current: true,
            },
            {
              id: otherId,
              label: 'A phone',
              address: '10.0.0.3',
              createdAt: now,
              lastSeenAt: now,
              expiresAt: now,
              current: false,
            },
          ],
        },
      }),
    )
    await page.route('**/api/session/passkeys', (route) =>
      route.fulfill({ json: { available: true, rpId: 'score.example.ts.net', items: [] } }),
    )
    await page.route(
      /\/api\/session\/(browsers\/.+\/(renew|revoke)|browsers\/revoke-others|pairing-links)$/,
      (route) => {
        sent.push(`${route.request().method()} ${route.request().url()}`)
        return route.abort()
      },
    )
    await asRemote(page, '/b/settings/security')
    await page.goto('/b/settings/security')
    const section = page.locator('.bold-security-open')
    await expect(section).toBeVisible()
    await expect(section.getByRole('button', { name: 'Get a pairing link' })).toBeEnabled()
    await custom(page)
    return { section, sent }
  }

  test('accepted theme CSS cannot hide the pairing buttons, the passkeys or the paired browsers', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await wear(
      page,
      `${ACCEPTED_TOKEN}\n.bold-security-btn { opacity: 0; }\n.bold-security-card { color: transparent; }\n.bold-security-open li { color: transparent; }`,
    )
    const { section } = await remoteSection(page)
    await drawn(section.getByRole('button', { name: 'Get a pairing link' }))
    await drawn(section.getByRole('button', { name: /^Renew/ }).first())
    await drawn(section.getByRole('button', { name: 'End all other devices' }))
    await drawn(section.getByRole('button', { name: 'Add a passkey' }))
    await custom(page)
  })

  for (const [name, button] of [
    ['Get a pairing link', 'Get a pairing link'],
    ['Renew', 'Renew this browser'],
    ['End all other devices', 'End all other devices'],
  ] as const) {
    test(`unreadable words in the section refuse “${name}” and send nothing`, async ({ page }) => {
      test.setTimeout(90_000)
      await wear(page)
      const { sent } = await remoteSection(page)
      await page.evaluate((label) => {
        document.adoptedStyleSheets
          .at(-1)!
          .insertRule(
            '.bold-security-open, .bold-security-open * { color: transparent !important; }',
          )
        ;[...document.querySelectorAll<HTMLButtonElement>('.bold-security-open button')]
          .find((b) => b.getAttribute('aria-label') === label || b.textContent === label)!
          .click()
      }, button)
      await expectRefused(page, sent)
    })
  }
})

test.describe('X1: the pair page is one decision', () => {
  test('accepted CSS cannot hide the card, and a card made unreadable refuses the click', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await wear(
      page,
      `${ACCEPTED_TOKEN}\n.pair-card { opacity: 0; }\n.pair-card p { color: transparent; }\n.pair-card button { opacity: 0; }`,
    )
    const sent: string[] = []
    await page.route('**/api/session/pair', (route) => {
      sent.push(route.request().url())
      return route.abort()
    })
    await asRemote(page, '/pair')
    await page.goto('/pair#some-one-time-token')
    const card = page.locator('.pair-card')
    await expect(card).toContainText('Pairing grants this browser access')
    await drawn(card)
    await drawn(card.locator('p').first())
    await drawn(card.getByRole('button', { name: 'Pair this browser' }))
    await custom(page)
    await page.evaluate(() => {
      document.adoptedStyleSheets
        .at(-1)!
        .insertRule('.pair-card, .pair-card * { color: transparent !important; }')
      document.querySelector<HTMLButtonElement>('.pair-card button')!.click()
    })
    await expectRefused(page, sent)
  })
})
