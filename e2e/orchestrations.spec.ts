import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'

// PLAN 7.5b against the fake adapter's scripted lead: no model is called. A goal with [fake:ask] makes the lead ask a
// question; an instruction with [fake:hold] keeps a step running until it is stopped.

test.describe.configure({ mode: 'serial' })

async function start(page: Page, goal: string, policy?: string) {
  await page.goto('/chat')
  await page.getByRole('button', { name: /New orchestration/ }).click()
  const dialog = page.getByRole('dialog', { name: 'New orchestration' })
  await dialog.getByRole('textbox', { name: 'Goal' }).fill(goal)
  await dialog.getByRole('combobox', { name: 'Lead' }).selectOption({ label: 'lead' })
  await dialog.getByRole('checkbox', { name: /builder/ }).check()
  await dialog.getByRole('checkbox', { name: /reviewer/ }).check()
  if (policy) await dialog.getByRole('radio', { name: policy }).check()
  // The acknowledgement, the estimates note and the preflight are on the start screen.
  await expect(dialog.getByText(/Score controls the work it starts/).first()).toBeVisible()
  await expect(dialog.getByRole('list', { name: 'Preflight checks' })).toContainText(
    'The lead has an MCP token',
  )
  await expect(dialog.getByText(/per lead turn and per step/)).toBeAttached()
  const startButton = dialog.getByRole('button', { name: 'Start orchestration' })
  await expect(startButton).toBeDisabled()
  await dialog.getByRole('checkbox', { name: /Score controls the work it starts/ }).check()
  await expect(startButton).toBeEnabled({ timeout: 15_000 })
  await startButton.click()
  await expect(dialog).toBeHidden()
  await expect(page.getByLabel('Orchestration', { exact: true }).first()).toBeVisible()
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

async function openLive(page: Page) {
  await page.getByRole('link', { name: 'Open the live diagram' }).first().click()
  await expect(page.locator('[data-node="lead"]')).toBeVisible()
}

test('start with every-step gates, approve each step, watch the diagram reach succeeded, replay it', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await pair(page)
  await start(page, 'Write the release notes e2e-a')
  // The room is an ordinary room marked as an orchestration in the list; its composer answers 409 with a hint.
  await expect(page.getByRole('link', { name: /Orchestration/ }).first()).toBeVisible()
  await openLive(page)

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
  const log = page.getByRole('log', { name: 'Events' })
  await expect(log).toContainText('Assigned s1 to builder')
  await expect(log).toContainText('You approved s1')
  await expect(log).toContainText('s1 succeeded')
  // Clicking a node filters the log to it and opens its output.
  await page.locator('[data-node="s2"]').click()
  await expect(page.getByText('Showing s2')).toBeVisible()
  await expect(log).not.toContainText('Assigned s1')
  await expect(page.getByRole('region', { name: 'Selected node' })).toContainText('Result')
  await page.getByRole('button', { name: 'Show everything' }).click()

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
  await expect(log).toContainText('Assigned s1')
  await expect(log).not.toContainText('s1 succeeded')
  await page.getByRole('button', { name: 'Step forward' }).click()
  await expect(page.locator('[data-node="s1"]')).toHaveAttribute('data-state', 'gate')
})

test('dots travel along the edges for real events', async ({ page }) => {
  test.setTimeout(120_000)
  await pair(page)
  await start(page, 'Dots e2e-b')
  await openLive(page)
  await approve(page, 's1')
  await expect(page.locator('.orch-dot').first()).toBeAttached({ timeout: 30_000 })
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
    await openLive(page)
    await approve(page, 's1')
    await expect(page.locator('.orch-node--lit').first()).toBeAttached({ timeout: 30_000 })
    await expect(page.locator('.orch-dot')).toHaveCount(0)
    await approve(page, 's2')
    await expect(page.getByText('Succeeded', { exact: true }).first()).toBeVisible({
      timeout: 60_000,
    })
  } finally {
    await context.close()
  }
})

test('the lead asks a question: it appears on Now, the answer reaches the lead and the run finishes', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await pair(page)
  await start(page, 'Ask first [fake:ask] e2e-d', 'Never ask')
  await page.goto('/now')
  const needs = page.getByRole('region', { name: 'Orchestrations that need you' })
  const question = needs.getByRole('region', { name: 'Question from the lead' })
  await expect(question).toContainText('Which audience is this for?', { timeout: 30_000 })
  await question.getByLabel(/Your answer/).fill('ANSWER q1: engineers')
  await question.getByRole('button', { name: 'Send answer' }).click()
  await expect(needs).toBeHidden({ timeout: 60_000 })
})

test('Stop: the run is Stopping and its attempts are not confirmed ended until the person abandons them, then it is Stopped', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await pair(page)
  await start(page, 'Hold [fake:hold] e2e-e', 'Never ask')
  await openLive(page)
  await expect(page.locator('[data-node="s1"]')).toHaveAttribute('data-state', 'running', {
    timeout: 60_000,
  })
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await page.getByRole('button', { name: 'Stop the run' }).click()
  // The fake Hermes answers a Stop with a cancelled run, which is not termination evidence: "not confirmed ended".
  await expect(page.getByText('Stopping', { exact: true }).first()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-node="s1"]')).toHaveAttribute('data-state', 'unknown', {
    timeout: 30_000,
  })
  await expect(page.getByRole('region', { name: 'Finish' })).toContainText('Not confirmed ended')
  // Abandoning is a separate, acknowledged human decision.
  const card = page.getByRole('region', { name: 'Attempt not confirmed ended' })
  await expect(async () => {
    const before = await card.count()
    if (before > 0) {
      await card.first().getByRole('checkbox').check()
      await card.first().getByRole('button', { name: 'Abandon this attempt' }).click()
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
  await page.goto('/settings')
  const backup = page.locator('#backup')
  await expect(backup).toContainText('scripts/score restore')
  await expect(backup).toContainText("can't be detected")
})
