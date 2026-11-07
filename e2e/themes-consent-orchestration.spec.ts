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
import { makeTeam } from './one-job-helpers.ts'
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
  // 3.28.0: the seeded team room holds jobs, so a start there asks which chat; this starts in a team of its own.
  const team = await makeTeam(page, 'Coding')
  await page.goto(`/b?room=${team.id}&start=job`)
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
    await expectRefused(page, sent)
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
    await page.evaluate(() => {
      document.adoptedStyleSheets
        .at(-1)!
        .insertRule(
          '.bold-start-dialog label.lab, .bold-start-dialog .start-what { color: transparent !important; }',
        )
      // Same task as the click, so no timer or observer can notice the rule first: only click-time vetting can stop it.
      document.querySelector<HTMLInputElement>('.bold-agent-pick input[type="checkbox"]')!.click()
    })
    await expectRefused(page, sent)
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
      // The cached CSS is on the page before the click, so the guard may act first: then the click is not the one that
      // is refused. Either banner is fine here; nothing may have been sent, even after a moment.
      await expect(page.locator('.look-banner')).toContainText(
        /Nothing was sent|Score switched your theme off/,
        { timeout: 15_000 },
      )
      await dropped(page)
      await page.waitForTimeout(500)
      expect(sent).toEqual([])
      // The theme list arrives afterwards: this device keeps the choice the guard made.
      release()
      await page.waitForTimeout(500)
      await dropped(page)
      await first.check()
    })
  }
})
