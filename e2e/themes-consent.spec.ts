import { expect, test, type Locator, type Page } from '@playwright/test'
import { ORCH_ACKNOWLEDGEMENT_TEXT } from '../packages/contract/src/index.ts'
import {
  ACCEPTED_TOKEN,
  custom,
  drawn,
  dropped,
  expectRefused,
  wear,
} from './themes-consent-helpers.ts'
import { pair } from './pair.ts'
import { openCodingRecipeStart } from './recipe-run.ts'
import { mockThemes } from './themes-fixtures.ts'

// Cross-audit of v1.8.0 (K1, X1): every consent a person gives in Score is a decision, and a theme that the sanitiser
// ACCEPTED (nothing here slips in afterwards unless the test says so) can neither hide nor fake any part of it. Real
// forms in Chromium, real submits; every request that would commit something is answered by the spec and counted.

// ---------------------------------------------------------------------------------------------------------------------
// Starting an orchestration

const policyId = 'c'.repeat(64)
const codingPreflight = (agentId: string) => ({
  ok: true,
  checks: [{ id: 'listener', status: 'ok', message: 'The loopback MCP listener is up' }],
  workers: [
    {
      agentId,
      runtime: 'codex',
      readiness: 'ready',
      detail: null,
      policyId,
      reach:
        'Reads any file you can read, not only the ones in /home/example/site. It changes files only inside /home/example/site.',
      reachBeyondWorkspace: true,
    },
  ],
  gatePolicyNotes: {
    'every-step': 'Every step waits for you.',
    'lead-asks': 'Steps start unless the lead asks you first.',
    none: 'Steps start at once.',
  },
  acknowledgementText: ORCH_ACKNOWLEDGEMENT_TEXT,
  defaults: {
    maxSteps: 12,
    maxLeadTurns: 20,
    maxConcurrentSteps: 2,
    leadTurnEstimateUsd: 0.25,
    stepEstimateUsd: 0.5,
    codingSteps: 10,
  },
  reserveBytes: 1000,
})

/**
 * Start a job with "lead decides", a coding agent in front of the team list and a preflight that needs the reach to be
 * accepted; nothing is created (the browser's own POST is answered 409 and recorded). The agent is allowed by default, so
 * the reach block and its acknowledgement are on the form as soon as the preflight lands.
 */
async function openLeadStart(page: Page, { vetted = false } = {}) {
  const agent = `coder-${Date.now().toString(36)}`
  const sent: string[] = []
  await page.route('**/api/agents', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const response = await route.fetch()
    const body = (await response.json()) as { items: Record<string, unknown>[] }
    body.items.push({
      ...body.items[0],
      id: agent,
      name: agent,
      role: 'Codex coding agent',
      runtime: 'codex',
      style: { color: '#19C39A', shape: 'hexagon' },
      status: 'idle',
      activity: null,
      served: true,
    })
    await route.fulfill({ response, json: body })
  })
  await page.route('**/api/orchestrations/preflight*', (route) =>
    route.fulfill({ json: codingPreflight(agent) }),
  )
  await page.route('**/api/orchestrations', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    sent.push(route.request().url())
    await route.fulfill({
      status: 409,
      json: { error: { code: 'policy_changed', message: 'changed', details: { agentId: agent } } },
    })
  })
  await page.goto('/b?start=job')
  const dialog = page.getByRole('dialog', { name: 'Start a job' })
  await dialog.getByLabel('What should the team do?').fill('Add a changelog page to the site')
  // (A cached theme that hides a field may already be switched off by the guard: `vetted` skips this check.)
  if (!vetted) await custom(page)
  return { dialog, agent, sent }
}

/** Accepts everything the form asks for: the pick of agents stays as it is (the coding agent is allowed). */
async function acceptLeadStart(dialog: Locator) {
  await expect(dialog.locator('.start-reach')).toContainText('Reads any file you can read')
  await dialog
    .locator('.start-reach')
    .getByRole('checkbox', { name: /I understand what these coding agents can read/ })
    .check()
  await dialog.getByRole('checkbox', { name: /Score controls the work it starts/ }).check()
  await expect(dialog.getByRole('button', { name: 'Start the job' })).toBeEnabled({
    timeout: 20_000,
  })
}

/** The guard may catch the hidden rule before the click or at it: either way the theme is off and nothing is sent. */
async function expectStopped(page: Page, sent: unknown[]) {
  await expect(page.locator('.look-banner')).toContainText(
    /Nothing was sent|Score switched your theme off/,
    { timeout: 15_000 },
  )
  await dropped(page)
  expect(sent).toEqual([])
}

// Rules a theme author could write: each names a class of the form and is accepted by the sanitiser today (a protected
// class, so it is dropped; the form is one protected decision, so nothing else of the theme reaches inside it either).
const startLeadCss = [
  '.start-ask, .start-ask * { opacity: 0; color: transparent; }',
  '.start-reach, .start-reach * { opacity: 0; color: transparent; }',
  '.start-limits, .start-limits * { opacity: 0; color: transparent; }',
  '.start-checks, .start-checks * { opacity: 0; color: transparent; }',
  '.start-ack { opacity: 0; }',
  '.start-actions { opacity: 0; }',
  '.start-go { opacity: 0; }',
  '.bold-agent-pick, .bold-agent-pick * { opacity: 0; color: transparent; }',
].join('\n')

test.describe('X1: starting a lead-decides job from Start a job is one decision', () => {
  test('accepted theme CSS cannot hide the policy, the reach, the spend and limits, the agents or the button', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await wear(page, `${ACCEPTED_TOKEN}\n${startLeadCss}`)
    const { dialog } = await openLeadStart(page)
    await expect(dialog.locator('.start-reach')).toContainText('Reads any file you can read')
    const reach = dialog.locator('.start-reach')
    await expect(reach).toHaveAttribute('data-protected', 'block')
    await drawn(dialog.getByRole('region', { name: 'Before it starts' }))
    await drawn(reach.getByText(/Reads any file you can read/))
    await drawn(reach.getByText(/I understand what these coding agents can read/))
    await drawn(dialog.getByRole('group', { name: 'Agents allowed' }))
    await drawn(dialog.getByText('Ask me before'))
    await drawn(dialog.getByText('Only risky actions'))
    await drawn(dialog.locator('label[for="start-cap"]'))
    await drawn(dialog.getByLabel(/^Spend cap/))
    await drawn(dialog.getByRole('button', { name: 'Start the job' }))
    await custom(page)
  })

  test('hidden policy text, reach text or limits refuse the click on Start and nothing is sent', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await wear(page)
    const { dialog, sent } = await openLeadStart(page)
    await acceptLeadStart(dialog)
    // The rule lands in the same task as the click (no timer or observer can notice it first): the only thing that can
    // stop the action is the vetting of the decision. The colour is inherited, so no class names are involved.
    await page.evaluate(() => {
      document.adoptedStyleSheets
        .at(-1)!
        .insertRule(
          '.start-ask, .start-ask *, .start-reach, .start-reach *, .start-limits, .start-limits * { color: transparent !important; }',
        )
      document.querySelector<HTMLButtonElement>('.start-go')!.click()
    })
    await expectStopped(page, sent)
  })

  test('accepted CSS aimed at a field of the form never reaches it, and a rule that slips in refuses the first click', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await wear(
      page,
      `${ACCEPTED_TOKEN}\n.bold-frame label.lab, .bold-frame .start-what, .bold-frame .check { color: transparent; opacity: 0; }`,
    )
    const { dialog, sent } = await openLeadStart(page)
    // The whole dialog is one protected surface: the accepted rule stays outside it and the field reads as Score draws it.
    await drawn(dialog.getByLabel('What should the team do?'))
    await drawn(dialog.locator('label.lab').first())
    await custom(page)
    // A rule that got past the sanitiser anyway: the first click inside the form is stopped.
    const first = dialog
      .getByRole('group', { name: 'Agents allowed' })
      .getByRole('checkbox')
      .first()
    await page.evaluate(() => {
      document.adoptedStyleSheets
        .at(-1)!
        .insertRule(
          '.bold-start-dialog label.lab, .bold-start-dialog .start-what { color: transparent !important; }',
        )
    })
    // The click is stopped, so the box does not change: click it, don't wait for it to be checked.
    await first.click()
    await expectStopped(page, sent)
    // Score's own look is back: the same form goes ahead.
    await acceptLeadStart(dialog)
    await dialog.getByRole('button', { name: 'Start the job' }).click()
    await expect.poll(() => sent.length).toBe(1)
  })
})

// L1 (1.8.1 verification, problem 1): the page wears a cached theme from the first paint, so its decisions are vetted
// from then on, while the theme list or the theme itself is still on its way. Nothing here waits for the server.
test.describe('L1: a cached theme is vetted while the list or the theme is still pending', () => {
  const hiddenField =
    "html[data-look='custom'] .bold-start-dialog label.lab { color: transparent !important; }"

  async function wearCached(page: Page, pending: 'list' | 'detail') {
    const look = { active: 'gate', mode: 'light' as const }
    await mockThemes(
      page,
      [{ id: 'gate', name: 'Gate', source: 'imported', manifest: {}, css: hiddenField }],
      look,
    )
    // The last visit's boot cache, written by an earlier page: its CSS is what the page wears before React has the theme.
    await page.addInitScript((css) => {
      localStorage.setItem(
        'score.look.cache',
        JSON.stringify({
          id: 'gate',
          attributes: {
            'data-look': 'custom',
            'data-pack': 'score',
            'data-layout': 'top',
            'data-density': 'comfortable',
          },
          css,
        }),
      )
    }, hiddenField)
    let release = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    await page.route(
      pending === 'list' ? /\/api\/themes$/ : /\/api\/themes\/gate$/,
      async (route) => {
        await gate
        await route.fallback().catch(() => undefined)
      },
    )
    await pair(page)
    return release
  }

  for (const pending of ['list', 'detail'] as const) {
    test(`the first click inside the form is refused while the theme ${pending} is pending`, async ({
      page,
    }) => {
      test.setTimeout(90_000)
      const release = await wearCached(page, pending)
      const { dialog, sent } = await openLeadStart(page, { vetted: true })
      // The cached rule is on the page before React has the theme; the guard may already have switched it off.
      await expect
        .poll(() =>
          page.evaluate(() => {
            const label = document.querySelector('.bold-start-dialog label.lab')
            const off = document.documentElement.getAttribute('data-look') !== 'custom'
            return off || (!!label && getComputedStyle(label).color === 'rgba(0, 0, 0, 0)')
          }),
        )
        .toBe(true)
      const first = dialog
        .getByRole('group', { name: 'Agents allowed' })
        .getByRole('checkbox')
        .first()
      await first.click()
      await expectStopped(page, sent)
      // The theme list arrives afterwards: this device keeps the choice the guard made.
      release()
      await page.waitForTimeout(500)
      await dropped(page)
      await first.check()
    })
  }
})

// ---------------------------------------------------------------------------------------------------------------------
// Starting a workflow

// 2.8.0: starting a saved recipe is Start a job. The decision (the "Before it starts" checklist, the coding reach, the
// button) is one protected surface there; hostile accepted theme CSS can't hide any part of it.
test.describe('X1: starting a recipe from Start a job is one decision', () => {
  const startCss = [
    '.start-checks, .start-checks * { opacity: 0; color: transparent; }',
    '.start-reach, .start-reach * { opacity: 0; color: transparent; }',
    '.start-limits, .start-limits * { opacity: 0; color: transparent; }',
    '.start-ask, .start-ask * { opacity: 0; color: transparent; }',
    '.start-ack { opacity: 0; }',
    '.start-actions { opacity: 0; }',
  ].join('\n')

  /** The guard may catch the hidden rule before the click or at it: either way the theme is off and nothing is sent. */
  async function expectOff(page: Page, sent: unknown[]) {
    await expect(page.locator('.look-banner')).toContainText('Score switched your theme off', {
      timeout: 15_000,
    })
    await dropped(page)
    expect(sent).toEqual([])
  }

  async function startDialog(page: Page) {
    const opened = await openCodingRecipeStart(page, `Consent ${Date.now().toString(36)}`)
    await custom(page)
    // The theme's own sheet is on the page (the last adopted one) before a rule is added to it.
    await expect
      .poll(() => page.evaluate(() => document.adoptedStyleSheets.length))
      .toBeGreaterThan(0)
    return opened
  }

  test('accepted theme CSS cannot hide the checklist, the reach or the button', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await wear(page, `${ACCEPTED_TOKEN}\n${startCss}`)
    const { dialog } = await startDialog(page)
    await drawn(dialog.getByRole('region', { name: 'Before it starts' }))
    const reach = dialog.locator('.start-reach')
    await expect(reach).toHaveAttribute('data-protected', 'block')
    await drawn(reach.getByText(/Reads any file you can read/))
    await drawn(dialog.getByRole('button', { name: 'Start the job' }))
    await drawn(dialog.locator('label[for="start-cap"]'))
    await drawn(dialog.getByLabel(/^Spend cap/))
    await drawn(dialog.getByText('Ask me before'))
    await drawn(dialog.getByText('Only risky actions'))
    await custom(page)
  })

  test('a budget field hidden past the theme guard refuses the click on Start and nothing is sent', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await wear(page)
    const { dialog, bodies } = await startDialog(page)
    await dialog.getByRole('checkbox', { name: /Score controls the work it starts/ }).check()
    await dialog
      .locator('.start-reach')
      .getByRole('checkbox', { name: /I understand what these coding agents can read/ })
      .check()
    await expect(dialog.getByRole('button', { name: 'Start the job' })).toBeEnabled({
      timeout: 20_000,
    })
    // Accepted CSS can't hide a field of this form (the dialog is protected); a rule that slipped past is caught when
    // the person acts, because the whole decision is measured, not only the control.
    await page.evaluate(() => {
      document.adoptedStyleSheets
        .at(-1)!
        .insertRule(
          '.start-limits, .start-limits * { opacity: 0 !important; color: transparent !important; }',
        )
      // In the same task, so a re-applied theme can't drop the rule before the click.
      document.querySelector<HTMLButtonElement>('.start-go')!.click()
    })
    await expectOff(page, bodies)
  })

  test('hidden reach text refuses the click on Start and nothing is sent', async ({ page }) => {
    test.setTimeout(90_000)
    await wear(page)
    const { dialog, bodies } = await startDialog(page)
    await dialog.getByRole('checkbox', { name: /Score controls the work it starts/ }).check()
    await dialog
      .locator('.start-reach')
      .getByRole('checkbox', { name: /I understand what these coding agents can read/ })
      .check()
    await expect(dialog.getByRole('button', { name: 'Start the job' })).toBeEnabled({
      timeout: 20_000,
    })
    await page.evaluate(() => {
      document.adoptedStyleSheets
        .at(-1)!
        .insertRule('.start-reach, .start-reach * { color: transparent !important; }')
      document.querySelector<HTMLButtonElement>('.start-go')!.click()
    })
    await expectOff(page, bodies)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// MCP access

test.describe('X1: MCP read and write access is one decision', () => {
  async function mcpSection(page: Page) {
    const sent: string[] = []
    await page.route('**/api/agents/lead/mcp', async (route) => {
      if (route.request().method() !== 'PUT') return route.fallback()
      sent.push(route.request().url())
      await route.abort()
    })
    await page.goto('/b/team/lead')
    await page
      .getByRole('button', {
        name: 'More: memory, skills, tools, workspace, repeating jobs, delete',
      })
      .click()
    const section = page.locator('#agent-score-access')
    await expect(section).toBeVisible()
    await expect(section).toHaveAttribute('data-protected', 'flex')
    await custom(page)
    return { section, sent }
  }

  test('accepted theme CSS cannot hide the read and write switches or what they mean', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await wear(
      page,
      `${ACCEPTED_TOKEN}\n.bold-mc { opacity: 0; color: transparent; }\n.bold-mc .small { opacity: 0; }\n.bold-mc .check { opacity: 0; color: transparent; }\n#agent-score-access { opacity: 0; }`,
    )
    const { section } = await mcpSection(page)
    await drawn(section.getByText('Write too', { exact: false }).first())
    await drawn(section.getByText('Lets lead use Score’s rooms', { exact: false }))
    await drawn(section.getByRole('checkbox', { name: /Read rooms, tasks and notes/ }))
    await drawn(section.getByRole('checkbox', { name: /Write too/ }))
    await custom(page)
  })

  test('a section whose words were made unreadable refuses the click on a switch and sends nothing', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await wear(page)
    const { sent } = await mcpSection(page)
    await page.evaluate(() => {
      document.adoptedStyleSheets
        .at(-1)!
        .insertRule('#agent-score-access, #agent-score-access * { color: transparent !important; }')
      document
        .querySelector<HTMLInputElement>('#agent-score-access input[type="checkbox"]')!
        .click()
    })
    await expectRefused(page, sent)
  })
})

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
    const section = page.locator('#remote-access')
    await expect(section).toBeVisible()
    await section.getByLabel('Security password').fill('correct horse battery')
    await expect(section.getByRole('button', { name: 'Pair another device' })).toBeEnabled()
    await custom(page)
    return { section, sent }
  }

  test('accepted theme CSS cannot hide the password field, the pairing buttons or the paired browsers', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await wear(
      page,
      `${ACCEPTED_TOKEN}\n.settings-password { opacity: 0; color: transparent; }\n.settings-pill { opacity: 0; }\n.settings-start { color: transparent; }\n#remote-access li { color: transparent; }`,
    )
    const { section } = await remoteSection(page)
    await drawn(section.locator('label.settings-password'))
    await drawn(section.getByRole('button', { name: 'Pair another device' }))
    await drawn(section.getByRole('button', { name: /^Renew/ }).first())
    await drawn(section.getByRole('button', { name: 'End all other pairings' }))
    await drawn(section.getByRole('button', { name: 'Add a passkey' }))
    await custom(page)
  })

  for (const [name, button] of [
    ['Pair another device', 'Pair another device'],
    ['Renew', 'Renew this browser'],
    ['End all other pairings', 'End all other pairings'],
  ] as const) {
    test(`unreadable words in the section refuse “${name}” and send nothing`, async ({ page }) => {
      test.setTimeout(90_000)
      await wear(page)
      const { sent } = await remoteSection(page)
      await page.evaluate((label) => {
        document.adoptedStyleSheets
          .at(-1)!
          .insertRule('#remote-access, #remote-access * { color: transparent !important; }')
        ;[...document.querySelectorAll<HTMLButtonElement>('#remote-access button')]
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
