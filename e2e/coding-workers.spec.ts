import { mkdirSync } from 'node:fs'
import { ORCH_ACKNOWLEDGEMENT_TEXT } from '../packages/contract/src/index.ts'
import { expect, test, type Page } from '@playwright/test'
import { fixtureNow } from './now-fixture.ts'
import { orchestrationFixtures } from './orchestration-fixtures.ts'
import { pair } from './pair.ts'
import { visualFixtures, visualHello } from './visual-fixtures.ts'

// PLAN 7.7b, coding agents as workers, in the browser against the fake adapter. No real coding agent is started and no
// model is called. Fake mode has no supervised units and the team has no coding agent, so each test puts one in front of
// the real dialog or diagram by answering the browser's own requests (the technique of the visual baselines).

const shots = process.env.SCORE_UI_SHOTS
const shot = async (page: Page, name: string) => {
  if (!shots) return
  mkdirSync(shots, { recursive: true })
  await page.screenshot({ path: `${shots}/${name}.png`, fullPage: false })
}

const policy = 'c'.repeat(64)
const readyPreflight = {
  ok: true,
  checks: [{ id: 'listener', status: 'ok', message: 'The loopback MCP listener is up' }],
  workers: [
    {
      agentId: '',
      runtime: 'codex',
      readiness: 'ready',
      detail: null,
      policyId: policy,
      reach:
        'Reads any file you can read, not only the ones in /home/example/site. It changes files only inside /home/example/site and temporary folders.',
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
}

/**
 * A coding agent in front of the real server's team list, by answering the browser's own request. Making a real one
 * would change the team that the other specs count, which they run in parallel with this one.
 */
async function withCodingAgent(page: Page, id: string) {
  await page.route('**/api/agents', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const response = await route.fetch()
    const body = (await response.json()) as { items: Record<string, unknown>[] }
    body.items.push({
      ...body.items[0],
      id,
      name: id,
      role: 'Codex coding agent',
      runtime: 'codex',
      style: { color: '#19C39A', shape: 'hexagon' },
      status: 'idle',
      activity: null,
      served: true,
    })
    await route.fulfill({ response, json: body })
  })
}

async function openDialog(page: Page, agent: string) {
  await page.goto('/chat')
  await page.getByRole('button', { name: /New orchestration/ }).click()
  const dialog = page.getByRole('dialog', { name: 'New orchestration' })
  await dialog.getByRole('textbox', { name: 'Goal' }).fill('Add a changelog page to the site')
  await dialog.getByRole('combobox', { name: 'Lead' }).selectOption({ label: 'lead' })
  await dialog.getByRole('checkbox', { name: new RegExp(agent) }).check()
  return dialog
}

test('a coding agent the computer can’t run as a service is refused in plain words', async ({
  page,
}) => {
  const id = `coder-${Date.now().toString(36)}`
  await pair(page)
  await withCodingAgent(page, id)
  // What the real server answers on a computer without supervised services (covered by the server tests).
  await page.route('**/api/orchestrations/preflight*', async (route) => {
    await route.fulfill({
      status: 422,
      json: {
        error: {
          code: 'coding_workers_need_units',
          message: 'Coding agents can take steps only where Score runs them as system services.',
        },
      },
    })
  })
  const dialog = await openDialog(page, id)
  await expect(dialog.getByRole('alert')).toContainText(
    'Coding agents can take steps only where Score runs them as system services',
  )
  await dialog.getByRole('checkbox', { name: /Score controls the work it starts/ }).check()
  await expect(dialog.getByRole('button', { name: 'Start orchestration' })).toBeDisabled()
})

test('the start dialog explains what a coding agent can read and asks for one acknowledgement', async ({
  page,
}) => {
  const id = `coder-${Date.now().toString(36)}`
  await pair(page)
  await withCodingAgent(page, id)
  await page.route('**/api/orchestrations/preflight*', async (route) => {
    await route.fulfill({
      json: { ...readyPreflight, workers: [{ ...readyPreflight.workers[0], agentId: id }] },
    })
  })
  let created: Record<string, unknown> | undefined
  await page.route('**/api/orchestrations', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    created = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({
      status: 409,
      json: { error: { code: 'policy_changed', message: 'changed', details: { agentId: id } } },
    })
  })
  const dialog = await openDialog(page, id)
  const section = dialog.getByRole('region', { name: 'Coding agents in this run' })
  await expect(section).toContainText('Reads any file you can read')
  await expect(section).toContainText(
    'Whatever a coding agent can read, it can repeat in its answer',
  )
  await dialog.getByRole('checkbox', { name: /Score controls the work it starts/ }).check()
  const start = dialog.getByRole('button', { name: 'Start orchestration' })
  await expect(start).toBeDisabled()
  await section
    .getByRole('checkbox', { name: /I understand what these coding agents can read/ })
    .check()
  await expect(start).toBeEnabled()
  await dialog.getByText('Limits and estimates').click()
  await dialog.getByLabel('Most coding steps').fill('6')
  await dialog.evaluate((element) => element.scrollTo(0, 0))
  await shot(page, 'start-dialog-top')
  await section.scrollIntoViewIfNeeded()
  await shot(page, 'start-dialog-coding')
  await start.click()
  await expect(dialog.getByText(/A coding agent changed since you looked/)).toBeVisible()
  expect(created).toMatchObject({
    allowedAgents: [id],
    codingPolicies: { [id]: policy },
    acknowledgeCodingReach: { policyIds: [policy] },
    codingSteps: 6,
  })
})

test.describe('a coding step in the live diagram', () => {
  test.use({ timezoneId: 'UTC', locale: 'en-GB' })

  test('the step names its program, the log tags it, and a blocked step offers its actions', async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date(fixtureNow))
    const agents = structuredClone(visualFixtures['/api/agents']) as {
      items: { id: string; runtime?: string }[]
    }
    for (const agent of agents.items) if (agent.id === 'reviewer') agent.runtime = 'claude-code'
    const snapshot = structuredClone(orchestrationFixtures['/api/orchestrations/orch-1']) as {
      orchestration: Record<string, unknown> & { needsYou: unknown[] }
    }
    snapshot.orchestration.needsYou.push({
      kind: 'policy_changed',
      stepId: 's2',
      agentId: 'reviewer',
      currentPolicyId: policy,
    })
    snapshot.orchestration.coding = { stepLimit: 10, acceptedUnknownCost: [], workers: [] }
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === '/api/stream') {
        await route.fulfill({
          contentType: 'text/event-stream',
          body: `event: stream.hello\ndata: ${JSON.stringify(visualHello)}\n\n`,
        })
        return
      }
      url.searchParams.delete('tz')
      if (url.pathname === '/api/orchestrations/preflight') {
        await route.fulfill({
          json: {
            ...readyPreflight,
            workers: [
              {
                ...readyPreflight.workers[0],
                agentId: 'reviewer',
                runtime: 'claude-code',
                reach: 'Reads and edits files in /home/example/site.',
                reachBeyondWorkspace: false,
              },
            ],
          },
        })
        return
      }
      const key = `${url.pathname}${url.search}`
      const fixture =
        key === '/api/agents'
          ? agents
          : key === '/api/orchestrations/orch-1'
            ? snapshot
            : { ...visualFixtures, ...orchestrationFixtures }[key]
      if (fixture === undefined) {
        await route.fulfill({
          status: 404,
          json: { error: { code: 'not_found', message: 'none' } },
        })
        return
      }
      await route.fulfill({ json: fixture })
    })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.setViewportSize({ width: 1280, height: 1100 })
    await page.goto('/runs/brief-orch-1')
    const node = page.locator('[data-node="s2"]')
    await expect(node).toBeVisible()
    await expect(node).toContainText('Claude Code')
    await expect(node).toHaveAttribute('aria-label', /reviewer \(Claude Code\)/)
    await expect(page.locator('[data-node="s1"]')).not.toContainText('Claude Code')
    await expect(
      page.getByRole('log', { name: 'Events' }).getByText('Claude Code').first(),
    ).toBeVisible()
    const card = page.getByRole('region', { name: 'New settings for reviewer' })
    await expect(card).toBeVisible()
    await expect(card.getByRole('button', { name: 'Use the new settings' })).toBeEnabled()
    await page.evaluate(() => document.fonts.ready)
    if (shots) {
      mkdirSync(shots, { recursive: true })
      await page.locator('.orch-live').screenshot({ path: `${shots}/flow-coding-step.png` })
    }
  })
})
