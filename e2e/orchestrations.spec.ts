import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'

// PLAN 7.5b against the fake adapter's scripted lead: no model is called. A goal with [fake:ask] makes the lead ask a
// question; an instruction with [fake:hold] keeps a step running until it is stopped.

test.describe.configure({ mode: 'serial' })

const tab = (page: Page, name: string) => page.getByRole('tab', { name }).click()

async function start(page: Page, goal: string, policy: 'plan' | 'handoff' | 'risky' = 'plan') {
  await page.goto('/b?start=job')
  const dialog = page.getByRole('dialog', { name: 'Start a job' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('What should the team do?').fill(goal)
  // Only the seeded agents are team members for the lead's preflight (other specs add agents to the shared server).
  const picker = dialog.getByRole('group', { name: 'Agents allowed' })
  for (const box of await picker.getByRole('checkbox').all()) {
    const name = (await box.locator('xpath=ancestor::label').innerText()).trim()
    if (['builder', 'reviewer'].includes(name)) await box.check()
    else await box.uncheck()
  }
  const ask = { plan: 'The plan starts', handoff: 'Every hand-off', risky: 'Only risky actions' }
  await dialog.getByRole('radio', { name: ask[policy] }).check()
  // The acknowledgement and the preflight are on the start screen.
  await expect(dialog.getByText(/Score controls the work it starts/).first()).toBeVisible()
  await expect(dialog.getByRole('region', { name: 'Before it starts' })).toContainText(
    'The lead has an MCP token',
  )
  const startButton = dialog.getByRole('button', { name: 'Start the job' })
  await expect(startButton).toBeDisabled()
  await dialog.getByRole('checkbox', { name: /Score controls the work it starts/ }).check()
  await expect(startButton).toBeEnabled({ timeout: 15_000 })
  await startButton.click()
  await expect(dialog.getByRole('heading', { name: 'Started' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toBeHidden()
}

// The run lives in the Runs side panel, addressed by its brief id.
async function runBriefId(page: Page, goal: string): Promise<string> {
  let briefId = ''
  await expect
    .poll(async () => {
      const response = await page.request.get('/api/orchestrations')
      const body = (await response.json()) as { items: { title: string; briefId: string }[] }
      briefId = body.items.find((item) => item.title.includes(goal.slice(0, 30)))?.briefId ?? ''
      return briefId
    })
    .not.toBe('')
  return briefId
}

// A gate decision carries the revision the page showed; a click that races a fresh update is answered with a
// conflict, the page reads the run again and the person decides again. The test does the same.
async function approve(page: Page, step: string) {
  const gate = page.getByRole('region', { name: `Approve ${step}` })
  await expect(gate).toBeVisible({ timeout: 60_000 })
  await expect(async () => {
    if (await gate.isVisible()) await gate.getByRole('button', { name: `Approve ${step}` }).click()
    await expect(gate).toBeHidden({ timeout: 4000 })
  }).toPass({ timeout: 45_000 })
}

// A dot or a lit node is a short-lived effect that plays right after the event, which can be before a slow run of the
// test looks for it. Record it from the moment it appears instead of polling for a window that may already be over.
async function recordSeen(page: Page, selector: string) {
  await page.evaluate((css) => {
    const w = window as unknown as { __seen?: Record<string, boolean> }
    w.__seen = { ...w.__seen, [css]: false }
    const check = () => {
      if (document.querySelector(css)) w.__seen![css] = true
    }
    new MutationObserver(check).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
    })
    check()
  }, selector)
}
async function wasSeen(page: Page, selector: string) {
  await expect
    .poll(
      () =>
        page.evaluate(
          (css) => (window as unknown as { __seen?: Record<string, boolean> }).__seen?.[css],
          selector,
        ),
      { timeout: 30_000 },
    )
    .toBe(true)
}

async function openLive(page: Page, goal: string) {
  // The run opens in the Runs side panel, addressed by its brief id; its Graph and Log tabs carry the diagram and the
  // log. Selection and replay carry over between them; the decisions are above every tab.
  await page.goto(`/b?run=${encodeURIComponent(await runBriefId(page, goal))}`)
  await tab(page, 'Graph')
  // 3.14: the Graph tab opens on the Job map; the step diagram these checks are about is one click away.
  await page.getByRole('button', { name: 'Show the step diagram' }).click()
  await expect(page.locator('[data-node="lead"]')).toBeVisible()
}

test('start with every-step gates, approve each step, watch the diagram reach succeeded, replay it', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await pair(page)
  const goal = 'Write the release notes e2e-a'
  await start(page, goal)
  // While the run owns its room the composer is disabled with a hint.
  const runs = await page.request.get('/api/orchestrations')
  const roomId = ((await runs.json()) as { items: { title: string; roomId: string }[] }).items.find(
    (item) => item.title.includes(goal.slice(0, 30)),
  )!.roomId
  await page.goto(`/b?room=${encodeURIComponent(roomId)}`)
  const composer = page.getByRole('combobox', { name: /^Message/ })
  await composer.fill('Can I add something?')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText(/running orchestration/)
  await openLive(page, goal)

  // The first step waits for the person, with the frozen assignment shown.
  const gate = page.getByRole('region', { name: 'Approve s1' })
  await expect(gate).toBeVisible({ timeout: 30_000 })
  await expect(gate).toContainText('Draft: Write the release notes e2e-a')
  await expect(page.locator('[data-node="s1"]')).toHaveAttribute('data-state', 'gate')
  await approve(page, 's1')

  // Dots are the playback of real events: the step result sends one back to the lead.
  await expect(page.locator('[data-node="s1"]')).toHaveAttribute('data-state', 'succeeded', {
    timeout: 60_000,
  })
  await approve(page, 's2')
  await expect(page.locator('[data-node="s2"]')).toHaveAttribute('data-state', 'succeeded', {
    timeout: 60_000,
  })
  await expect(page.getByText('Succeeded', { exact: true }).first()).toBeVisible({
    timeout: 60_000,
  })

  // The log carries the lead's calls with Score's verdicts, the gates and the results.
  await tab(page, 'Log')
  const log = page.getByRole('log', { name: 'Events' })
  await expect(log).toContainText('Assigned s1 to builder')
  await expect(log).toContainText('You approved s1')
  await expect(log).toContainText('s1 succeeded')
  // Clicking a node filters the log to it and opens its output.
  await tab(page, 'Graph')
  await page.locator('[data-node="s2"]').click()
  await expect(page.getByRole('region', { name: 'Selected step' })).toContainText('Result')
  await tab(page, 'Log')
  await expect(page.getByText('Showing s2')).toBeVisible()
  await expect(log).not.toContainText('Assigned s1')
  await page.getByRole('button', { name: 'Show everything' }).click()
  await tab(page, 'Graph')

  // Replay: the scrubber starts at the beginning and the diagram and log follow it.
  await page.getByRole('button', { name: 'Replay this run' }).click()
  const scrub = page.getByRole('slider', { name: 'Replay position' })
  await expect(scrub).toHaveValue('0')
  await expect(page.locator('[data-node="s1"]')).toHaveCount(0)
  await page.getByRole('radio', { name: '16×' }).click()
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect(page.locator('[data-node="s2"]')).toHaveAttribute('data-state', 'succeeded', {
    timeout: 60_000,
  })
  const max = await scrub.getAttribute('max')
  await expect(scrub).toHaveValue(max!)
  // Stepping from the start: s1 appears queued the moment its assignment is accepted, then waits at its gate.
  await scrub.fill('0')
  await expect(page.locator('[data-node="s1"]')).toHaveCount(0)
  for (let i = 0; i < 12 && (await page.locator('[data-node="s1"]').count()) === 0; i++)
    await page.getByRole('button', { name: 'Step forward' }).click()
  await expect(page.locator('[data-node="s1"]')).toHaveAttribute('data-state', 'queued')
  await tab(page, 'Log')
  await expect(log).toContainText('Assigned s1')
  await expect(log).not.toContainText('s1 succeeded')
  await tab(page, 'Graph')
  await page.getByRole('button', { name: 'Step forward' }).click()
  await expect(page.locator('[data-node="s1"]')).toHaveAttribute('data-state', 'gate')
})

test('dots travel along the edges for real events', async ({ page }) => {
  test.setTimeout(120_000)
  await pair(page)
  await start(page, 'Dots e2e-b')
  await openLive(page, 'Dots e2e-b')
  await recordSeen(page, '.orch-dot')
  await approve(page, 's1')
  await wasSeen(page, '.orch-dot')
  // Let the run finish: approve the second step.
  await approve(page, 's2')
  await expect(page.getByText('Succeeded', { exact: true }).first()).toBeVisible({
    timeout: 60_000,
  })
})

test('reduced motion: no travelling dot, the nodes and the edge light up instead', async ({
  browser,
}) => {
  test.setTimeout(120_000)
  const context = await browser.newContext({ reducedMotion: 'reduce' })
  const page = await context.newPage()
  try {
    await pair(page)
    await start(page, 'Reduced e2e-c')
    await openLive(page, 'Reduced e2e-c')
    await recordSeen(page, '.orch-node--lit')
    await recordSeen(page, '.orch-dot')
    await approve(page, 's1')
    await wasSeen(page, '.orch-node--lit')
    // No dot ever appeared, not merely none right now.
    expect(
      await page.evaluate(
        () => (window as unknown as { __seen: Record<string, boolean> }).__seen['.orch-dot'],
      ),
    ).toBe(false)
    await approve(page, 's2')
    await expect(page.getByText('Succeeded', { exact: true }).first()).toBeVisible({
      timeout: 60_000,
    })
  } finally {
    await context.close()
  }
})

test('the lead asks a question: it appears on the run, the answer reaches the lead and the run finishes', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await pair(page)
  await start(page, 'Ask first [fake:ask] e2e-d', 'risky')
  await openLive(page, 'Ask first [fake:ask] e2e-d')
  // The run page carries the question inside its protected Needs-you wrapper.
  const needs = page.locator('.orch-needs[aria-label="Needs you"]')
  await expect(needs).toHaveAttribute('data-protected', 'grid')
  const question = needs.getByRole('region', { name: 'Question from the lead' })
  await expect(question).toContainText('Which audience is this for?', { timeout: 30_000 })
  await question.getByLabel(/Your answer/).fill('ANSWER q1: engineers')
  await question.getByRole('button', { name: 'Send answer' }).click()
  await expect(question).toBeHidden({ timeout: 60_000 })
})

test('Stop: the run is Stopping and its attempts are not confirmed ended until the person abandons them, then it is Stopped', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await pair(page)
  await start(page, 'Hold [fake:hold] e2e-e', 'risky')
  await openLive(page, 'Hold [fake:hold] e2e-e')
  await expect(page.locator('[data-node="s1"]')).toHaveAttribute('data-state', 'running', {
    timeout: 60_000,
  })
  // The room's own strip also has a Stop for this run; this is the run view's.
  const panel = page.locator('.bold-run')
  await panel.getByRole('button', { name: 'Stop', exact: true }).click()
  await panel.getByRole('button', { name: 'Stop the run' }).click()
  // The fake Hermes answers a Stop with a cancelled run, which is not termination evidence: "not confirmed ended".
  await expect(page.getByText('Stopping', { exact: true }).first()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-node="s1"]')).toHaveAttribute('data-state', 'unknown', {
    timeout: 30_000,
  })
  await tab(page, 'Steps')
  await expect(page.getByRole('region', { name: 'Finish' })).toContainText('Not confirmed as ended')
  // Abandoning is a separate, acknowledged human decision.
  const card = page.getByRole('region', { name: 'Not confirmed as ended' })
  await expect(async () => {
    const before = await card.count()
    if (before > 0) {
      await card.first().getByRole('checkbox').first().check()
      await card.first().getByRole('button', { name: 'Stop waiting for this' }).click()
      await expect(card).toHaveCount(before - 1, { timeout: 4000 })
    }
    expect(await card.count()).toBe(0)
  }).toPass({ timeout: 45_000 })
  await expect(card).toHaveCount(0, { timeout: 30_000 })
  await expect(page.getByText('Stopped', { exact: true }).first()).toBeVisible({ timeout: 60_000 })
})

test('Settings › Backup repeats that a restore outside scripts/score restore cannot be detected', async ({
  page,
}) => {
  await pair(page)
  await page.goto('/b/settings/system')
  const backup = page.locator('#backup')
  await expect(backup).toContainText('scripts/score restore')
  await expect(backup).toContainText('can’t detect a restore done any other way')
})
