import { expect, test, type Page } from '@playwright/test'
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

/** A coding agent in front of the team list and a preflight that needs the reach to be accepted; nothing is created. */
async function openNewOrchestration(page: Page) {
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
  await page.goto('/chat')
  await page.getByRole('button', { name: /New orchestration/ }).click()
  const dialog = page.getByRole('dialog', { name: 'New orchestration' })
  await dialog.getByRole('textbox', { name: 'Goal' }).fill('Add a changelog page to the site')
  await dialog.getByRole('combobox', { name: 'Lead' }).selectOption({ label: 'lead' })
  await custom(page)
  return { dialog, agent, sent }
}

// Rules a theme author could write: each names a class of the form and is accepted by the sanitiser today. (The agent
// pick and the goal are left alone: they are plain fields, and the next test covers those.)
const orchestrationCss = [
  '.orch-policy { opacity: 0; color: transparent; }',
  '.orch-risk p, .orch-workers p, .orch-workers h3 { opacity: 0; color: transparent; }',
  '.orch-row .orch-field { opacity: 0; color: transparent; }',
  '.orch-workers ~ fieldset { opacity: 0; color: transparent; }',
  '.orch-actions { opacity: 0; }',
].join('\n')

test.describe('X1: starting an orchestration is one decision', () => {
  test('accepted theme CSS cannot hide the policy, the reach, the spend choices, the limits or the button', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await wear(page, `${ACCEPTED_TOKEN}\n${orchestrationCss}`)
    const { dialog, agent } = await openNewOrchestration(page)
    await dialog.getByRole('checkbox', { name: new RegExp(agent) }).check()
    const section = dialog.getByRole('region', { name: 'Coding agents in this run' })
    await expect(section).toContainText('Reads any file you can read')
    await dialog.getByText('Limits and estimates').click()
    const policy = dialog.locator('label.orch-policy', { hasText: 'Ask me before each step' })
    await drawn(policy)
    await drawn(policy.locator('strong'))
    await drawn(section.locator('li p'))
    await drawn(section.locator('.orch-risk p'))
    await drawn(dialog.getByText(/Keep going when the cost of Codex is unknown/))
    await drawn(dialog.getByText(/Quota floor/))
    await drawn(dialog.getByLabel('Budget in USD (optional)'))
    await drawn(dialog.getByRole('button', { name: 'Start orchestration' }))
    await custom(page)
  })

  test('hidden policy text, reach text or quota field refuse the click on Start and nothing is sent', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await wear(page)
    const { dialog, agent, sent } = await openNewOrchestration(page)
    await dialog.getByRole('checkbox', { name: new RegExp(agent) }).check()
    const section = dialog.getByRole('region', { name: 'Coding agents in this run' })
    await expect(section).toContainText('Reads any file you can read')
    await section
      .getByRole('checkbox', { name: /I understand what these coding agents can read/ })
      .check()
    await dialog.getByRole('checkbox', { name: /Score controls the work it starts/ }).check()
    await expect(dialog.getByRole('button', { name: 'Start orchestration' })).toBeEnabled({
      timeout: 15_000,
    })
    // The rule lands in the same task as the click (no timer or observer can notice it first): the only thing that can
    // stop the action is the vetting of the decision. The colour is inherited, so no class names are involved.
    await page.evaluate(() => {
      document.adoptedStyleSheets
        .at(-1)!
        .insertRule(
          '.orch-policy, .orch-policy *, .orch-workers p, .orch-risk p { color: transparent !important; }',
        )
      document.querySelector<HTMLButtonElement>('.orch-dialog .orch-primary')!.click()
    })
    await expectRefused(page, sent)
  })

  test('a field of the form hidden by accepted CSS refuses the first click inside the form', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await wear(page, `${ACCEPTED_TOKEN}\n.orch-form > label.orch-field { color: transparent; }`)
    const { dialog, agent, sent } = await openNewOrchestration(page)
    // The click is stopped, so the box does not change: click it, don't wait for it to be checked.
    await dialog.getByRole('checkbox', { name: new RegExp(agent) }).click()
    await expectRefused(page, sent)
    // Score's own look is back: the same form goes ahead.
    await dialog.getByRole('checkbox', { name: new RegExp(agent) }).check()
    const section = dialog.getByRole('region', { name: 'Coding agents in this run' })
    await section
      .getByRole('checkbox', { name: /I understand what these coding agents can read/ })
      .check()
    await dialog.getByRole('checkbox', { name: /Score controls the work it starts/ }).check()
    await dialog.getByRole('button', { name: 'Start orchestration' }).click()
    await expect.poll(() => sent.length).toBe(1)
  })
})

// L1 (1.8.1 verification, problem 1): the page wears a cached theme from the first paint, so its decisions are vetted
// from then on, while the theme list or the theme itself is still on its way. Nothing here waits for the server.
test.describe('L1: a cached theme is vetted while the list or the theme is still pending', () => {
  const hiddenField = '.orch-form > label.orch-field { opacity: 0; }'

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
      const { dialog, agent, sent } = await openNewOrchestration(page)
      await expect
        .poll(() =>
          dialog
            .locator('label.orch-field')
            .first()
            .evaluate((label) => getComputedStyle(label).opacity),
        )
        .toBe('0')
      await dialog.getByRole('checkbox', { name: new RegExp(agent) }).click()
      await expectRefused(page, sent)
      // The theme list arrives afterwards: this device keeps the choice the guard made.
      release()
      await page.waitForTimeout(500)
      await dropped(page)
      await dialog.getByRole('checkbox', { name: new RegExp(agent) }).check()
    })
  }
})

// ---------------------------------------------------------------------------------------------------------------------
// Starting a workflow

// 2.8.0: the list's Run button and its start dialog are gone; Start a job is the one start dialog (its protection is
// covered by bold-protection.spec). The classic dialog is left only behind "Run again" on a finished run page, which
// the Runs rebuild retires, so these three wait for that instead of an address that no longer shows it.
test.describe.skip('X1: starting a workflow is one decision', () => {
  async function workflowDialog(page: Page) {
    const name = `Consent ${Date.now().toString(36)}`
    const sent: string[] = []
    const created = await page.request.post('/api/workflows', {
      headers: { 'x-score-client': 'web' },
      data: {
        definition: {
          name,
          inputs: [{ name: 'topic', label: 'Topic', required: false, maxChars: 200 }],
          nodes: [
            {
              id: 'one',
              kind: 'agent',
              label: 'First',
              agentId: 'builder',
              instruction: 'Say hello',
              retries: 0,
              onFailure: 'fail_run',
            },
            { id: 'done', kind: 'end', label: 'Done' },
          ],
          edges: [{ id: 'e1', from: 'one', port: 'ok', to: 'done' }],
        },
      },
    })
    expect(created.ok()).toBe(true)
    await page.route('**/api/workflow-runs', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      sent.push(route.request().url())
      await route.fulfill({
        status: 409,
        json: { error: { code: 'conflict', message: 'changed' } },
      })
    })
    await page.goto('/workflows')
    await page.getByRole('listitem', { name }).getByRole('button', { name: /^Run/ }).click()
    const dialog = page.getByRole('dialog', { name: new RegExp(`Start ${name}`) })
    await expect(dialog.getByRole('list', { name: 'Agent mapping' })).toContainText('builder')
    await custom(page)
    return { dialog, sent, name }
  }

  test('accepted theme CSS cannot hide the approval policy, the spend choice, the limits or the button', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await wear(
      page,
      `${ACCEPTED_TOKEN}\n.orch-policy { opacity: 0; color: transparent; }\n.orch-field { opacity: 0; }\n.orch-actions { opacity: 0; }`,
    )
    const { dialog } = await workflowDialog(page)
    const policy = dialog.locator('label.orch-policy', { hasText: 'Ask me only at gates' })
    await drawn(policy)
    await drawn(dialog.getByRole('button', { name: 'Start the run' }))
    await drawn(dialog.getByLabel(/^Budget in USD/))
    await custom(page)
  })

  test('hidden policy text refuses the click on Start the run and nothing is sent', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await wear(page)
    const { dialog, sent } = await workflowDialog(page)
    await dialog.getByRole('checkbox', { name: /Score controls the work it starts/ }).check()
    await expect(dialog.getByRole('button', { name: 'Start the run' })).toBeEnabled({
      timeout: 20_000,
    })
    await page.evaluate(() => {
      document.adoptedStyleSheets
        .at(-1)!
        .insertRule('.orch-policy, .orch-policy * { color: transparent !important; }')
      document.querySelector<HTMLButtonElement>('.orch-dialog .orch-primary')!.click()
    })
    await expectRefused(page, sent)
  })

  test('a field hidden by accepted CSS refuses the first click inside the form', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await wear(page, `${ACCEPTED_TOKEN}\n.wf-fieldset .orch-field { color: transparent; }`)
    const { dialog, sent } = await workflowDialog(page)
    await dialog.getByRole('checkbox', { name: /Score controls the work it starts/ }).click()
    await expectRefused(page, sent)
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
    await page.goto('/team/lead')
    await page.getByRole('tab', { name: 'Tools' }).click()
    const section = page.getByRole('region', { name: 'MCP access' })
    await expect(section).toBeVisible()
    await custom(page)
    return { section, sent }
  }

  test('accepted theme CSS cannot hide the read and write switches or what they mean', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await wear(
      page,
      `${ACCEPTED_TOKEN}\n.team-rows li { opacity: 0; color: transparent; }\n.team-rows small { opacity: 0; }\n.team-toggle { opacity: 0; }`,
    )
    const { section } = await mcpSection(page)
    await drawn(section.getByText('Writes', { exact: false }).first())
    await drawn(section.getByRole('switch', { name: /MCP access enabled/ }))
    await drawn(section.getByRole('switch', { name: /MCP writes enabled/ }))
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
        .insertRule('.team-rows li, .team-rows li * { color: transparent !important; }')
      document
        .querySelector<HTMLButtonElement>('[aria-labelledby="team-mcp-heading"] [role=switch]')!
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
    await asRemote(page, '/settings/remote-access')
    await page.goto('/settings/remote-access')
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
