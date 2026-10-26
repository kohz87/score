import { mkdirSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { fixtureNow } from './now-fixture.ts'
import { pair } from './pair.ts'
import { openCodingRecipeStart, startPolicyA, startPolicyB } from './recipe-run.ts'
import { visualFixtures, visualHello } from './visual-fixtures.ts'
import {
  codingPolicyB,
  codingPreflight,
  codingRunSnapshot,
  codingTeam,
  workflowFixtures,
} from './workflow-fixtures.ts'

// PLAN 7.7c, coding agents in workflows, in the browser against the fake adapter. No real coding agent is started and no
// model is called. Fake mode has no supervised units and the team has no coding agent, so each test puts one in front of
// the real page by answering the browser's own requests (the technique of 7.7b's coding-workers.spec.ts); nothing is
// created on the shared server except plain Hermes workflows with unique names.

const shots = process.env.SCORE_UI_SHOTS
const shot = async (page: Page, name: string) => {
  if (!shots) return
  mkdirSync(shots, { recursive: true })
  await page.screenshot({ path: `${shots}/${name}.png`, fullPage: false })
}

/** Coding agents in front of the real server's team list (and an Antigravity one, which workflows refuse). */
async function withCodingAgents(page: Page) {
  await page.route('**/api/agents', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const response = await route.fetch()
    const body = (await response.json()) as { items: Record<string, unknown>[] }
    const template = body.items[0]!
    body.items.push(
      ...[
        { id: 'coder-a', runtime: 'codex', shape: 'hexagon', color: '#19C39A' },
        { id: 'coder-b', runtime: 'claude-code', shape: 'triangle', color: '#FFB61E' },
        { id: 'coder-c', runtime: 'antigravity', shape: 'diamond', color: '#6B4EFF' },
      ].map((agent) => ({
        ...template,
        id: agent.id,
        name: agent.id,
        role: 'Coding agent',
        runtime: agent.runtime,
        style: { color: agent.color, shape: agent.shape },
        status: 'idle',
        activity: null,
        served: true,
      })),
    )
    await route.fulfill({ response, json: body })
  })
}

test('the editor offers coding agents for a step, refuses Antigravity with the reason, and Validate says what is wrong with a coding step', async ({
  page,
}) => {
  await pair(page)
  await withCodingAgents(page)
  // What the real server answers on a computer without supervised services (the server tests cover the rules itself).
  await page.route('**/api/workflows/validate', async (route) => {
    const sent = route.request().postDataJSON() as {
      definition: { nodes: { id: string; agentId?: string }[] }
    }
    const coding = sent.definition.nodes.filter((n) => n.agentId?.startsWith('coder-'))
    if (coding.length === 0) return route.fallback()
    await route.fulfill({
      json: {
        ok: false,
        stats: { nodes: sent.definition.nodes.length, edges: 1, maxSteps: 1, bytes: 400 },
        issues: coding.map((n) => ({
          code: 'coding_workers_need_units',
          severity: 'error',
          nodeId: n.id,
          edgeId: null,
          field: 'agentId',
          message:
            'Coding agents can take workflow steps only where Score runs them as supervised system services, and this computer isn’t set up for that right now. Settings › Coding shows what is missing.',
        })),
      },
    })
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/b/recipes/new')
  await page.locator('[data-node="step1"]').click()
  const inspector = page.getByRole('complementary', { name: 'Selected step' })
  const picker = inspector.getByLabel(/^Agent/)
  await expect(picker.locator('option', { hasText: 'coder-a · Codex' })).not.toHaveAttribute(
    'disabled',
  )
  await expect(picker.locator('option', { hasText: 'coder-b · Claude Code' })).not.toHaveAttribute(
    'disabled',
  )
  const refused = picker.locator('option', { hasText: 'coder-c · Antigravity' })
  await expect(refused).toHaveAttribute('disabled', '')
  await expect(refused).toHaveText(/can’t take workflow steps/)
  await inspector.getByRole('combobox', { name: 'Instruction' }).fill('Build the page.')
  await picker.selectOption({ label: 'coder-a · Codex' })
  await expect(inspector).toContainText('Codex works on this computer')
  await expect(page.locator('[data-node="step1"]')).toHaveAttribute(
    'aria-label',
    /coder-a \(Codex\)/,
  )
  await expect(page.locator('[data-node="step1"]')).toContainText('Codex')
  await shot(page, 'editor-agent-picker')
  // Validate: the problem is on the step, with words for what to do.
  const problems = page.getByRole('region', { name: 'Problems' })
  await expect(problems).toContainText(
    'Coding agents can take workflow steps only where Score runs them',
    {
      timeout: 20_000,
    },
  )
  await expect(problems).toContainText('Settings › Coding')
  await expect(page.locator('[data-node="step1"]')).toHaveAttribute('aria-label', /1 problem/)
  await expect(page.getByRole('button', { name: /^Save as version \d+$/ })).toBeDisabled()
  await shot(page, 'validate-coding-issue')
  // A Hermes agent clears it.
  await picker.selectOption({ label: 'builder' })
  await expect(page.locator('[data-node="step1"]')).not.toHaveAttribute('aria-label', /1 problem/, {
    timeout: 20_000,
  })
  await expect(problems).not.toContainText('Coding agents can take workflow steps')
})

test('Start a job shows the reach of a coding recipe, asks once, sends policies and options, and asks again when a policy changed', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await pair(page)
  await page.setViewportSize({ width: 1280, height: 1300 })
  const { dialog, bodies, policy } = await openCodingRecipeStart(
    page,
    `Coding start ${Date.now().toString(36)}`,
  )
  const reach = dialog.locator('.start-reach')
  await expect(reach).toBeVisible()
  await expect(reach).toHaveAttribute('data-protected', 'block')
  await expect(reach).toContainText('Reads any file you can read')
  await dialog.getByRole('checkbox', { name: /Score controls the work it starts/ }).check()
  const start = dialog.getByRole('button', { name: 'Start the job' })
  await expect(start).toBeDisabled()
  const accept = reach.getByRole('checkbox', {
    name: /I understand what these coding agents can read/,
  })
  await accept.check()
  await expect(start).toBeEnabled()

  await dialog.getByText('More options').click()
  await expect(dialog.getByLabel('Most coding steps')).toHaveValue('4')
  await dialog.getByLabel('Most coding steps').fill('5')
  await dialog.getByLabel(/^Quota floor/).fill('15')
  // The agent changes while the person decides: the next read says so, and the 409 is the server's own answer.
  policy.id = startPolicyB
  await start.click()
  await expect.poll(() => bodies.length).toBe(1)
  expect(bodies[0]).toMatchObject({
    codingPolicies: { builder: startPolicyA },
    acknowledgeCodingReach: { policyIds: [startPolicyA] },
    codingSteps: 5,
    quotaFloorPercent: 15,
  })
  // The reach is read again, and what changed has to be accepted again.
  await expect(accept).not.toBeChecked({ timeout: 20_000 })
  await expect(start).toBeDisabled()
})

test.describe('a coding step in the live workflow view', () => {
  test.use({ timezoneId: 'UTC', locale: 'en-GB' })

  /** The real page over frozen fixtures, the coding run being the one the page reads. */
  async function liveView(page: Page, snapshot: unknown, posted: { url: string; body: unknown }[]) {
    await page.clock.setFixedTime(new Date(fixtureNow))
    const agents = structuredClone(visualFixtures['/api/agents']) as {
      items: Record<string, unknown>[]
    }
    for (const agent of codingTeam)
      agents.items.push({ activity: null, model: null, served: true, ...agent })
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === '/api/stream') {
        await route.fulfill({
          contentType: 'text/event-stream',
          body: `event: stream.hello\ndata: ${JSON.stringify(visualHello)}\n\n`,
        })
        return
      }
      if (route.request().method() === 'POST') {
        posted.push({ url: url.pathname, body: route.request().postDataJSON() })
        await route.fulfill({ status: 500, json: { error: { code: 'x', message: 'stop here' } } })
        return
      }
      url.searchParams.delete('tz')
      const key = `${url.pathname}${url.search}`
      const fixture =
        key === '/api/agents'
          ? agents
          : key === '/api/workflow-runs/wfrun-1'
            ? snapshot
            : key === '/api/workflow-runs/preflight?workflowId=wf-release&version=1'
              ? codingPreflight
              : { ...visualFixtures, ...workflowFixtures }[key]
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
    await page.setViewportSize({ width: 1280, height: 1300 })
    await page.goto('/runs/brief-wfrun-1')
    // 2.5.0: the diagram is the Graph tab of the run; the decisions are on the Steps tab it opens on.
    await page.getByRole('tab', { name: 'Graph' }).click()
    await expect(page.locator('[data-node="draft"]')).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    await page.getByRole('tab', { name: 'Steps' }).click()
  }

  test('8.6: a coding step below its agent’s limit floor waits, and the card sends the three answers', async ({
    page,
  }) => {
    const posted: { url: string; body: unknown }[] = []
    await liveView(
      page,
      codingRunSnapshot(
        [
          {
            kind: 'quota_low',
            nodeId: 'draft',
            agentId: 'coder-a',
            window: '5 hours',
            group: null,
            leftPercent: 6,
            resetsAt: '2026-10-08T12:40:00.000Z',
          },
        ],
        { waitingFor: 'quota_low' },
      ),
      posted,
    )
    const card = page.getByRole('region', { name: 'coder-a’s limit is low' })
    await expect(card).toContainText('Draft the notes is held:')
    await expect(card).toContainText('has 6% of its 5-hour limit left')
    for (const name of ['Wait until it resets', 'Use it anyway', 'Stop the run'])
      await card.getByRole('button', { name }).click()
    await expect.poll(() => posted.length).toBe(3)
    expect(posted.map((p) => p.url)).toEqual(
      Array(3).fill('/api/workflow-runs/wfrun-1/nodes/draft/quota'),
    )
    expect(posted.map((p) => (p.body as { answer: string }).answer)).toEqual([
      'wait',
      'use_anyway',
      'stop',
    ])
  })

  test('the step names its program; new settings and the step limit are decided from the Needs-you cards', async ({
    page,
  }) => {
    // Several decisions in one run, now behind a heavier page (the Runs panel): more than the default 30 s under load.
    test.setTimeout(90_000)
    const posted: { url: string; body: unknown }[] = []
    await liveView(
      page,
      codingRunSnapshot(
        [
          {
            kind: 'coding_agent_changed',
            nodeId: 'draft',
            agentId: 'coder-a',
            newPolicyId: null,
            reach: null,
          },
          { kind: 'coding_limit', used: 4, limit: 4 },
        ],
        { waitingFor: 'coding_settings' },
      ),
      posted,
    )
    await page.getByRole('tab', { name: 'Graph' }).click()
    const node = page.locator('[data-node="draft"]')
    await expect(node).toContainText('Codex')
    await expect(node).toHaveAttribute('aria-label', /coder-a \(Codex\)/)
    await expect(page.locator('[data-node="review"]')).toContainText('Claude Code')
    await page.getByRole('tab', { name: 'Steps' }).click()
    const card = page.getByRole('region', { name: 'New settings for coder-a' })
    await expect(card).toContainText('With the new settings: Reads any file you can read')
    await card.getByRole('checkbox', { name: /I understand what it can read now/ }).check()
    await expect(page.getByRole('region', { name: 'Coding step limit' })).toBeVisible()
    await page.locator('.orch-needs').scrollIntoViewIfNeeded()
    await shot(page, 'live-workflow-coding')
    await card.getByRole('button', { name: 'Use the new settings' }).click()
    await expect.poll(() => posted.length).toBeGreaterThan(0)
    expect(posted[0]).toMatchObject({
      url: '/api/workflow-runs/wfrun-1/nodes/draft/policy-remap',
      body: {
        policyId: codingPolicyB,
        acknowledgeCodingReach: { policyIds: [codingPolicyB] },
        expectedNodeRevision: 4,
        orchestrationRevision: 14,
      },
    })
    const limit = page.getByRole('region', { name: 'Coding step limit' })
    await limit.getByLabel(/New limit/).fill('8')
    await limit.getByRole('button', { name: 'Raise the limit and continue' }).click()
    await expect.poll(() => posted.length).toBeGreaterThan(1)
    expect(posted[1]).toMatchObject({
      url: '/api/workflow-runs/wfrun-1/limits',
      body: { orchestrationRevision: 14, codingSteps: 8 },
    })
  })

  test('a step held back 20 times can be tried again, and a step that lost its input can be retried', async ({
    page,
  }) => {
    const posted: { url: string; body: unknown }[] = []
    await liveView(
      page,
      codingRunSnapshot(
        [
          { kind: 'coding_held_back', nodeId: 'draft' },
          { kind: 'node_inputs_withdrawn', nodeId: 'review' },
        ],
        { waitingFor: 'held_back', renewals: 1 },
      ),
      posted,
    )
    const held = page.getByRole('region', { name: 'Draft the notes was held back' })
    await expect(held).toContainText('2 chances left for this step')
    await held.getByRole('button', { name: 'Try again' }).click()
    await expect.poll(() => posted.length).toBeGreaterThan(0)
    expect(posted[0]).toMatchObject({
      url: '/api/workflow-runs/wfrun-1/nodes/draft/try-again',
      body: { expectedNodeRevision: 4, orchestrationRevision: 14 },
    })
    const lost = page.getByRole('region', { name: 'Review the draft lost its input' })
    await expect(lost).toContainText('nothing ran and the try wasn’t used')
  })
})
