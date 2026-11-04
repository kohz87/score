import { expect, test, type Page } from '@playwright/test'
import { startInOwnChat } from './one-job-helpers.ts'
import { pair } from './pair.ts'

// PLAN 7.5b against the fake adapter's scripted lead: no model is called. A goal with [fake:ask] makes the lead ask a
// question; an instruction with [fake:hold] keeps a step running until it is stopped.

test.describe.configure({ mode: 'serial' })

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
  // 3.28.0: the team room holds jobs already, so the run starts in a chat of its own.
  await startInOwnChat(page, 'Orch')
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
  // 3.29.0: no run page. `/b?run=` opens the run's chat with the Graph tab; the decisions are its needs-you cards, the
  // Job map (3.29.1: the step diagram was removed) is the Graph tab's only graph and carries its Session log.
  await page.goto(`/b?run=${encodeURIComponent(await runBriefId(page, goal))}`)
  await expect(page.getByRole('region', { name: 'Job map' })).toBeVisible()
}

test('start with every-step gates, approve each step, watch the Job map reach succeeded', async ({
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
  // 3.29.1: the step diagram was removed (owner): the diagram node states are gone; the gate is the chat's card.
  await approve(page, 's1')

  // Dots are the playback of real events: the step result sends one back to the lead.
  const jobMap = page.getByRole('region', { name: 'Job map' })
  await expect(jobMap.getByText('s1 ✓')).toBeVisible({ timeout: 60_000 })
  await approve(page, 's2')
  await expect(jobMap.getByText('s2 ✓')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('Succeeded', { exact: true }).first()).toBeVisible({
    timeout: 60_000,
  })

  // The log carries the lead's calls with Score's verdicts, the gates and the results.
  const log = page.getByRole('region', { name: 'Session log' })
  // The Job map's own log shows the latest lines only (the older s1 lines are scrolled out of it).
  await expect(log).toContainText('s2 succeeded')
  await expect(log).toContainText('Run ended: succeeded')
  // 3.29.1: the step diagram was removed (owner): Replay, the scrubber, the diagram node states and "Selected step" are gone.
})

test('dots travel along the edges for real events', async ({ page }) => {
  test.setTimeout(120_000)
  await pair(page)
  await start(page, 'Dots e2e-b')
  await openLive(page, 'Dots e2e-b')
  await recordSeen(page, '.jobmap-dot')
  await approve(page, 's1')
  await wasSeen(page, '.jobmap-dot')
  // Let the run finish: approve the second step.
  await approve(page, 's2')
  await expect(page.getByText('Succeeded', { exact: true }).first()).toBeVisible({
    timeout: 60_000,
  })
})

test('reduced motion: no travelling dot on the Job map', async ({ browser }) => {
  test.setTimeout(120_000)
  const context = await browser.newContext({ reducedMotion: 'reduce' })
  const page = await context.newPage()
  try {
    await pair(page)
    await start(page, 'Reduced e2e-c')
    await openLive(page, 'Reduced e2e-c')
    await recordSeen(page, '.jobmap-dot')
    await approve(page, 's1')
    // No dot ever appeared, not merely none right now.
    expect(
      await page.evaluate(
        () => (window as unknown as { __seen: Record<string, boolean> }).__seen['.jobmap-dot'],
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
  // 3.29.0: the question is a protected needs-you card in the chat.
  const needs = page.getByRole('article', { name: 'Needs you: The lead asks' })
  await expect(needs).toHaveAttribute('data-protected', /.+/)
  const question = page.getByRole('region', { name: 'Question from the lead' })
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
  await expect(page.getByRole('region', { name: 'Job map' }).getByText('s1 running')).toBeVisible({
    timeout: 60_000,
  })
  // The Graph tab's own Pause / Resume / Stop (3.29.0), above the Job map.
  const panel = page.locator('.bold-topic-graph')
  await panel.getByRole('button', { name: 'Stop', exact: true }).click()
  await panel.getByRole('button', { name: 'Stop the run' }).click()
  // The fake Hermes answers a Stop with a cancelled run, which is not termination evidence: "not confirmed ended".
  await expect(page.getByText('Stopping', { exact: true }).first()).toBeVisible({ timeout: 30_000 })
  // 3.29.0: the old run page's "Finish" summary is gone; the chat's needs-you cards say it.
  // Abandoning is a separate, acknowledged human decision.
  const card = page.getByRole('region', { name: 'Not confirmed as ended' })
  await expect(card.first()).toBeVisible({ timeout: 30_000 })
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
