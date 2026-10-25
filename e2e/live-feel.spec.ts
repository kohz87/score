import { expect, test, type Page } from '@playwright/test'
import { releaseDefinition } from './workflow-fixtures.ts'
import { pair } from './pair.ts'

// PLAN 5.39 against the fake adapter: no model is called. Status lines, check chips, run summaries, the halo and the
// workflow editor's preview and live overlay.

test.describe.configure({ mode: 'serial' })
const web = { 'x-score-client': 'web' }

async function room(page: Page, text: string, lead = 'builder') {
  return page.evaluate(
    async ({ text, lead }) => {
      const post = async (path: string, body: object) => {
        const response = await fetch(`/api/${path}`, {
          method: 'POST',
          headers: {
            'X-Score-Client': 'web',
            'Content-Type': 'application/json',
            'Idempotency-Key': crypto.randomUUID(),
          },
          body: JSON.stringify(body),
        })
        return response.json() as Promise<Record<string, unknown>>
      }
      const created = await post('rooms', { name: `live-${Date.now()}`, leadAgentId: lead })
      await post(`rooms/${String(created.id)}/messages`, { text })
      return String(created.id)
    },
    { text, lead },
  )
}

test('a running reply shows its status line in Chat (under the reply and in the room header)', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await pair(page)
  await page.goto('/chat')
  // "go quiet" leaves the run running and silent until it is stopped.
  const id = await room(page, 'Please go quiet for a moment')
  await page.goto(`/chat/${id}`)
  const history = page.getByRole('region', { name: 'Message history' })
  await expect(history.locator('.live-status').last()).toHaveText('Thinking…', { timeout: 30_000 })
  await expect(page.getByRole('list', { name: 'Working now' })).toContainText('Thinking…')

  // End the run so it doesn't linger for the other specs.
  await page.goto(`/chat/${id}`)
  await page.getByRole('button', { name: /^Stop/ }).first().click()
  await expect(history.locator('.live-status')).toHaveCount(0, { timeout: 30_000 })
})

test('a reply waiting for approval says so; deciding turns the card into a check chip with the time', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await pair(page)
  await page.goto('/chat')
  const id = await room(page, `Please ask for approval before installing ${Date.now()}`, 'designer')
  await page.goto(`/chat/${id}`)
  const history = page.getByRole('region', { name: 'Message history' })
  const card = history.getByRole('group', { name: /^Approval: / }).last()
  await expect(card.getByRole('button', { name: 'Approve' })).toBeVisible({ timeout: 30_000 })
  await expect(history.locator('.live-status').last()).toHaveText('Waiting for your approval')
  await card.getByRole('button', { name: 'Approve' }).click()
  const chip = card.locator('.live-chip--ok')
  await expect(chip).toBeVisible({ timeout: 15_000 })
  await expect(chip).toContainText('Approved by you')
  await expect(chip).toContainText(/\d{2}:\d{2}/)
  // The question is gone: only the chip is left where it was.
  await expect(card.getByRole('button', { name: 'Approve' })).toHaveCount(0)
})

async function startOrchestration(page: Page, goal: string, policy?: string) {
  await page.goto('/chat')
  await page.getByRole('button', { name: /New orchestration/ }).click()
  const dialog = page.getByRole('dialog', { name: 'New orchestration' })
  await dialog.getByRole('textbox', { name: 'Goal' }).fill(goal)
  await dialog.getByRole('combobox', { name: 'Lead' }).selectOption({ label: 'lead' })
  await dialog.getByRole('checkbox', { name: /builder/ }).check()
  await dialog.getByRole('checkbox', { name: /reviewer/ }).check()
  if (policy) await dialog.getByRole('radio', { name: policy }).check()
  await dialog.getByRole('checkbox', { name: /Score controls the work it starts/ }).check()
  const start = dialog.getByRole('button', { name: 'Start orchestration' })
  await expect(start).toBeEnabled({ timeout: 15_000 })
  await start.click()
  await expect(dialog).toBeHidden()
  const toggle = page.getByRole('button', { name: /Orchestration · / }).first()
  await expect(toggle).toBeVisible()
  await expect(async () => {
    if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true', { timeout: 2000 })
  }).toPass({ timeout: 20_000 })
  await page.getByRole('link', { name: 'Open the live diagram' }).first().click()
  await expect(page.locator('[data-node="lead"]')).toBeVisible()
}

test('an orchestration: the running step has a halo and a status line, a decided gate stays as a chip, the run ends with a summary', async ({
  page,
}) => {
  test.setTimeout(150_000)
  await pair(page)
  await startOrchestration(page, 'Live feel e2e-a')
  const gate = page.getByRole('region', { name: 'Approve s1' })
  await expect(gate).toBeVisible({ timeout: 30_000 })
  await expect(async () => {
    if (await gate.isVisible()) await gate.getByRole('button', { name: 'Approve s1' }).click()
    await expect(gate).toBeHidden({ timeout: 4000 })
  }).toPass({ timeout: 45_000 })
  // Where the card was, a chip says it was approved by you, for a little while.
  const needs = page.getByRole('region', { name: 'Needs you' })
  await expect(
    page.getByRole('list', { name: 'Just decided' }).locator('.live-chip--ok'),
  ).toContainText('Approved by you')
  void needs

  // Second step: approve, and the run finishes with its summary (only facts Score has).
  const second = page.getByRole('region', { name: 'Approve s2' })
  await expect(second).toBeVisible({ timeout: 60_000 })
  await expect(async () => {
    if (await second.isVisible()) await second.getByRole('button', { name: 'Approve s2' }).click()
    await expect(second).toBeHidden({ timeout: 4000 })
  }).toPass({ timeout: 45_000 })
  await expect(page.getByText('Succeeded', { exact: true }).first()).toBeVisible({
    timeout: 60_000,
  })
  const summary = page.locator('[data-run-summary]')
  await expect(summary).toContainText('2 steps')
  await expect(summary).toContainText('2 approvals')
  await expect(summary).not.toContainText('NaN')
  // The counter shows the final figure.
  await expect(page.locator('.orch-status')).toContainText('2 of 2 steps done')
})

test('a running step in the live diagram: status line as its caption and a halo that stops with reduced motion', async ({
  browser,
}) => {
  test.setTimeout(150_000)
  for (const reduced of [false, true]) {
    const context = await browser.newContext({
      reducedMotion: reduced ? 'reduce' : 'no-preference',
    })
    const page = await context.newPage()
    try {
      await pair(page)
      await startOrchestration(page, `Hold [fake:hold] e2e-b${reduced ? 'r' : ''}`, 'Never ask')
      const step = page.locator('[data-node="s1"]')
      await expect(step).toHaveAttribute('data-state', 'running', { timeout: 60_000 })
      // What the agent is doing now, whichever moment the fake run is at.
      await expect(step).toContainText(
        /Thinking…|Writing the reply…|Waiting for your approval|Calling /,
      )
      const style = await step.evaluate((el) => {
        const css = getComputedStyle(el)
        return { animation: css.animationName, shadow: css.boxShadow }
      })
      // A halo is always there; it breathes slowly, and not at all with reduced motion.
      expect(style.shadow).not.toBe('none')
      expect(style.animation).toBe(reduced ? 'none' : 'orch-halo')
      if (reduced) {
        expect(await page.evaluate(() => document.getAnimations().length)).toBe(0)
      }
      // Stop it so the run doesn't linger.
      await page.getByRole('button', { name: 'Stop', exact: true }).click()
      await page.getByRole('button', { name: 'Stop the run' }).click()
      // The fake Hermes answers a Stop with a run that is not confirmed ended: stop waiting for it, so the agent is
      // free for the specs that follow.
      await expect(step).toHaveAttribute('data-state', 'unknown', { timeout: 30_000 })
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
      await expect(page.getByText('Stopped', { exact: true }).first()).toBeVisible({
        timeout: 60_000,
      })
    } finally {
      await context.close()
    }
  }
})

async function createWorkflow(page: Page, name: string): Promise<string> {
  const response = await page.request.post('/api/workflows', {
    headers: web,
    data: { definition: { ...releaseDefinition, name } },
  })
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { workflowId: string }).workflowId
}

test('the workflow editor previews a gate and a branch without calling the server, and Stop returns to the canvas', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await pair(page)
  const id = await createWorkflow(page, `Preview ${Date.now().toString(36)}`)
  const posts: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && !request.url().endsWith('/api/workflows/validate'))
      posts.push(request.url())
  })
  await page.goto(`/workflows/${id}`)
  const preview = page.getByRole('button', { name: 'Preview' })
  await expect(preview).toBeEnabled({ timeout: 20_000 })
  await preview.click()
  await expect(page.getByText('Preview: nothing runs, no tokens')).toBeVisible()
  await page.getByRole('button', { name: '4×' }).click()

  // The first steps light up in order, then the gate waits for a choice.
  const gate = page.getByLabel('Preview: Approve the draft')
  await expect(gate).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-node="draft"]')).toHaveAttribute('data-state', 'succeeded')
  await expect(page.locator('[data-node="approve"]')).toHaveAttribute('data-state', 'gate')
  await gate.getByRole('button', { name: 'Continue as approved' }).click()

  // The branch asks which outcome to follow; the first rule is chosen by default. Choose "otherwise" instead.
  const branch = page.getByLabel('Preview: Passed review?')
  await expect(branch).toBeVisible({ timeout: 30_000 })
  await expect(branch.getByRole('radio').first()).toBeChecked()
  await branch.getByRole('radio', { name: 'otherwise' }).check()
  await branch.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText('Preview finished. Nothing ran.')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-node="repair"]')).toHaveAttribute('data-state', 'succeeded')
  await expect(page.locator('[data-node="publish"]')).toHaveAttribute('data-state', 'skipped')

  await page
    .getByRole('region', { name: 'Preview' })
    .getByRole('button', { name: 'Stop', exact: true })
    .click()
  await expect(page.getByText('Preview: nothing runs, no tokens')).toHaveCount(0)
  await expect(page.locator('[data-wf-node="draft"]')).toBeVisible()
  expect(posts).toEqual([])
})

test('the editor draws a run of the version on screen over the canvas and links to it', async ({
  page,
}) => {
  test.setTimeout(150_000)
  await pair(page)
  const name = `Overlay ${Date.now().toString(36)}`
  const id = await createWorkflow(page, name)
  await page.goto(`/workflows/${id}`)
  await page.getByRole('button', { name: 'Run…' }).click()
  const dialog = page.getByRole('dialog', { name: /Start/ })
  await dialog.getByLabel(/^Topic/).fill('the live overlay')
  await dialog.getByRole('checkbox', { name: /Score controls the work it starts/ }).check()
  const start = dialog.getByRole('button', { name: 'Start the run' })
  await expect(start).toBeEnabled({ timeout: 20_000 })
  await start.click()
  const approve = page.getByRole('region', { name: 'Decide on Approve the draft' })
  await expect(approve).toBeVisible({ timeout: 60_000 })

  // Back in the editor, the run is drawn over the version that is open.
  await page.goto(`/workflows/${id}`)
  const live = page.getByText(/Live: run started/)
  await expect(live).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('[data-node="approve"]')).toHaveClass(/orch-node--gate/)
  await expect(page.locator('[data-node="draft"]')).toHaveClass(/orch-node--succeeded/)
  // The draft is untouched.
  await expect(page.getByText(/unsaved changes/)).toHaveCount(0)
  await page.getByRole('link', { name: /Open the run/ }).click()
  await expect(page.getByRole('region', { name: 'Decide on Approve the draft' })).toBeVisible({
    timeout: 30_000,
  })
  // Finish the run: approve the gate (rejecting would stop it).
  const gate = page.getByRole('region', { name: 'Decide on Approve the draft' })
  await expect(async () => {
    if (await gate.isVisible()) await gate.getByRole('button', { name: 'Approve' }).click()
    await expect(gate).toBeHidden({ timeout: 4000 })
  }).toPass({ timeout: 45_000 })
  // The decided gate stays where it was, as a chip.
  await expect(
    page.getByRole('list', { name: 'Just decided' }).locator('.live-chip--ok'),
  ).toContainText('Approved by you')
})
