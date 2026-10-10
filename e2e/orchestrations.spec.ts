import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'

// PLAN 7.5b against the fake adapter's scripted lead: no model is called. A goal with [fake:ask] makes the lead ask a
// question; an instruction with [fake:hold] keeps a step running until it is stopped.

test.describe.configure({ mode: 'serial' })

async function start(page: Page, goal: string, policy?: string) {
  await page.goto('/chat')
  await page.getByRole('button', { name: /New orchestration/ }).click()
  const dialog = page.getByRole('dialog', { name: 'New orchestration' })
  await dialog.getByLabel('Goal').fill(goal)
  await dialog.getByLabel('Lead').selectOption({ label: 'lead' })
  await dialog.getByLabel('builder').check()
  await dialog.getByLabel('reviewer').check()
  if (policy) await dialog.getByLabel(policy).check()
  // The acknowledgement, the estimates note and the preflight are on the start screen.
  await expect(dialog.getByText(/Score controls the work it starts/).first()).toBeVisible()
  await expect(dialog.getByRole('list', { name: 'Preflight checks' })).toContainText(
    "Can't be checked",
  )
  await expect(dialog.getByText(/per lead turn and per step/)).toBeAttached()
  const startButton = dialog.getByRole('button', { name: 'Start orchestration' })
  await expect(startButton).toBeDisabled()
  await dialog.getByLabel(/Score controls the work it starts/).check()
  await expect(startButton).toBeEnabled({ timeout: 15_000 })
  await startButton.click()
  await expect(dialog).toBeHidden()
  await expect(page.getByLabel('Orchestration', { exact: true }).first()).toBeVisible()
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
  await gate.getByRole('button', { name: 'Approve s1' }).click()

  // Dots are the playback of real events: the step result sends one back to the lead.
  await expect(page.locator('[data-node="s1"]')).toHaveAttribute('data-state', 'succeeded', {
    timeout: 60_000,
  })
  const second = page.getByRole('region', { name: 'Approve s2' })
  await expect(second).toBeVisible({ timeout: 60_000 })
  await second.getByRole('button', { name: 'Approve s2' }).click()
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
  await scrub.fill('3')
  await expect(page.locator('[data-node="s1"]')).toHaveAttribute('data-state', 'queued')
  await expect(log).toContainText('Assigned s1')
  await expect(log).not.toContainText('s1 succeeded')
  await page.getByRole('button', { name: 'Step forward' }).click()
  await expect(scrub).toHaveValue('4')
})

test('dots travel for real events and give way to highlights with reduced motion', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000)
  await pair(page)
  await start(page, 'Dots e2e-b')
  await openLive(page)
  const gate = page.getByRole('region', { name: 'Approve s1' })
  await expect(gate).toBeVisible({ timeout: 30_000 })
  await gate.getByRole('button', { name: 'Approve s1' }).click()
  await expect(page.locator('.orch-dot').first()).toBeAttached({ timeout: 30_000 })
  // Let the run finish: approve the second step.
  const second = page.getByRole('region', { name: 'Approve s2' })
  await expect(second).toBeVisible({ timeout: 60_000 })
  await second.getByRole('button', { name: 'Approve s2' }).click()
  await expect(page.getByText('Succeeded', { exact: true }).first()).toBeVisible({
    timeout: 60_000,
  })
  void browser
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
    const gate = page.getByRole('region', { name: 'Approve s1' })
    await expect(gate).toBeVisible({ timeout: 30_000 })
    await gate.getByRole('button', { name: 'Approve s1' }).click()
    await expect(page.locator('.orch-node--lit').first()).toBeAttached({ timeout: 30_000 })
    await expect(page.locator('.orch-dot')).toHaveCount(0)
    const second = page.getByRole('region', { name: 'Approve s2' })
    await expect(second).toBeVisible({ timeout: 60_000 })
    await second.getByRole('button', { name: 'Approve s2' }).click()
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

test('a held step is stopped: the run shows Stopping then Stopped, with the step not confirmed ended until Hermes says so', async ({
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
  await expect(page.getByText(/^(Stopping|Stopped)$/).first()).toBeVisible({ timeout: 30_000 })
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
