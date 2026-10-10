import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'

// PLAN 7.1b against the fake adapter: no model is called. Instruction markers script the agents: [fake:verdict:passed]
// replies with a score-verdict block, [fake:fail] ends the step's run failed.

test.describe.configure({ mode: 'serial' })
const web = { 'x-score-client': 'web' }

const node = (page: Page, id: string) => page.locator(`[data-node="${id}"]`)

async function createWorkflow(page: Page, definition: unknown): Promise<string> {
  const response = await page.request.post('/api/workflows', {
    headers: web,
    data: { definition },
  })
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { workflowId: string }).workflowId
}

async function startFromList(page: Page, name: string, inputs: Record<string, string> = {}) {
  await page.goto('/now/flow/workflows')
  const card = page.getByRole('listitem', { name })
  await card.getByRole('button', { name: /^Run/ }).click()
  const dialog = page.getByRole('dialog', { name: new RegExp(`Start ${name}`) })
  for (const [label, value] of Object.entries(inputs))
    await dialog.getByLabel(new RegExp(`^${label}`)).fill(value)
  await expect(dialog.getByRole('list', { name: 'Preflight checks' })).toBeVisible()
  await expect(dialog.getByRole('list', { name: 'Agent mapping' })).toContainText('builder')
  await dialog.getByRole('checkbox', { name: /Score controls the work it starts/ }).check()
  const start = dialog.getByRole('button', { name: 'Start the run' })
  await expect(start).toBeEnabled({ timeout: 20_000 })
  await start.click()
  await expect(dialog).toBeHidden()
}

test('build a workflow with a gate and a branch in the editor, save it, run it, approve the gate and replay it', async ({
  page,
}) => {
  test.setTimeout(180_000)
  await pair(page)
  const unique = `Release notes ${Date.now().toString(36)}`
  await page.goto('/now/flow/workflows')
  await expect(page.getByRole('heading', { name: 'Workflows', level: 2 })).toBeVisible()
  await page.getByRole('link', { name: 'New workflow' }).click()

  // The editor starts with one step and an end, already connected.
  await expect(page.getByRole('heading', { name: 'Nothing selected' })).toBeVisible()
  await page.getByRole('textbox', { name: 'Workflow name' }).fill(unique)

  // A start input the steps can read.
  await page.getByRole('button', { name: 'Add an input' }).click()
  const inputs = page.getByRole('region', { name: 'Start inputs' })
  await inputs.getByLabel('Name').fill('topic')
  await inputs.getByLabel('Label').fill('Topic')

  // Replace the starter end: delete it with the keyboard, then build the route with the palette.
  await node(page, 'end1').focus()
  await page.keyboard.press('Delete')
  await expect(node(page, 'end1')).toHaveCount(0)

  // Step 1: the draft, by builder. The instruction reads the input through the autocomplete.
  await node(page, 'step1').click()
  const inspector = page.getByRole('complementary', { name: 'Node settings' })
  await inspector.getByLabel('Title').fill('Draft')
  await inspector.getByLabel('Agent').selectOption({ label: 'builder' })
  const instruction = inspector.getByRole('combobox', { name: 'Instruction' })
  await instruction.fill('Write the release notes about {{')
  const options = page.getByRole('listbox', { name: /Values for Instruction/ })
  await expect(options).toBeVisible()
  await expect(options.getByRole('option')).toContainText(['inputs.topic'])
  await page.keyboard.press('Enter')
  await expect(instruction).toHaveValue('Write the release notes about {{inputs.topic}}')
  await instruction.press('End')
  await instruction.pressSequentially(' [fake:verdict:passed]')

  // Problems are shown on the node they are about while the rest is unfinished.
  await expect(page.getByRole('region', { name: 'Problems' })).toContainText('no end', {
    ignoreCase: true,
  })

  // Add a gate after it (connected from "when done"), then a branch after the gate.
  await page.getByRole('button', { name: 'Add a gate' }).click()
  await inspector.getByLabel('Title').fill('Approve the draft')
  await inspector
    .getByRole('combobox', { name: 'Question' })
    .fill('Is the draft good enough to publish?')
  await page.getByRole('button', { name: 'Add a branch' }).click()
  await inspector.getByLabel('Title').fill('Passed review?')
  await inspector.getByLabel('Looks at').selectOption({ label: 'Draft' })
  // Rule 1 is "the verdict is: passed"; its path goes to an end, the "otherwise" path to a repair step.
  await page.getByRole('button', { name: 'Add an end' }).click()
  await inspector.getByLabel('Title').fill('Published')
  await node(page, 'branch1').click()
  await page.getByRole('button', { name: /Add an agent step for reviewer/ }).click()
  await inspector.getByLabel('Title').fill('Repair')
  await inspector
    .getByRole('combobox', { name: 'Instruction' })
    .fill('Fix the draft: {{nodes.step1.output}}')
  await page.getByRole('button', { name: 'Add an end' }).click()
  await inspector.getByLabel('Title').fill('Repaired')

  // The outline lists the same graph as text.
  const outline = page.getByRole('region', { name: 'Outline' })
  await expect(outline).toContainText('Draft')
  await expect(outline).toContainText('when done goes to Approve the draft')
  await expect(outline).toContainText('otherwise goes to Repair')

  // Valid: save as version 1.
  await expect(page.getByRole('status').filter({ hasText: 'Looks good' })).toBeVisible({
    timeout: 20_000,
  })
  await page.getByRole('button', { name: 'Save as new version' }).click()
  await expect(page.getByText('Saved as version 1.').first()).toBeVisible()

  // Start it from the editor.
  await page.getByRole('button', { name: 'Run…' }).click()
  const dialog = page.getByRole('dialog', { name: /Start/ })
  await dialog.getByLabel(/^Topic/).fill('the 2.4 release')
  await expect(dialog.getByRole('list', { name: 'Agent mapping' })).toContainText('builder')
  await expect(dialog.getByText(/Score controls the work it starts/).first()).toBeVisible()
  await expect(dialog.getByRole('radio', { name: /Ask me only at gates/ })).toBeChecked()
  await dialog.getByRole('checkbox', { name: /Score controls the work it starts/ }).check()
  const startButton = dialog.getByRole('button', { name: 'Start the run' })
  await expect(startButton).toBeEnabled({ timeout: 20_000 })
  await startButton.click()

  // The run view: the gate waits for the person with the draft the question is about.
  const gate = page.getByRole('region', { name: 'Decide on Approve the draft' })
  await expect(gate).toBeVisible({ timeout: 60_000 })
  await expect(gate).toContainText('Is the draft good enough to publish?')
  await expect(gate).toContainText('Draft')
  await expect(page.locator('[data-node="gate1"]')).toHaveAttribute('data-state', 'gate')
  await expect(node(page, 'step1')).toHaveAttribute('data-state', 'succeeded')
  await expect(async () => {
    if (await gate.isVisible()) await gate.getByRole('button', { name: 'Approve' }).click()
    await expect(gate).toBeHidden({ timeout: 4000 })
  }).toPass({ timeout: 45_000 })

  // The branch takes the "verdict passed" path; the repair step is skipped, struck and faded.
  await expect(page.getByText('Succeeded', { exact: true }).first()).toBeVisible({
    timeout: 60_000,
  })
  await expect(page.getByText('Graph reached the end').first()).toBeVisible()
  await expect(node(page, 'step2')).toHaveAttribute('data-state', 'skipped')
  await expect(node(page, 'end1')).toHaveAttribute('data-state', 'succeeded')
  await expect(node(page, 'end2')).toHaveAttribute('data-state', 'skipped')
  await expect(page.locator('[data-edge-state="skipped"]').first()).toBeAttached()
  const log = page.getByRole('log', { name: 'Events' })
  await expect(log).toContainText("Passed review? took 'verdict passed'")

  // Clicking a node filters the log to it and shows what it read and its verdict.
  await node(page, 'step1').click()
  const panel = page.getByRole('region', { name: 'Selected node' })
  await expect(panel).toContainText('Verdict: passed')
  await node(page, 'branch1').click()
  await expect(panel).toContainText('Branch')

  // Replay the finished run from its recorded events.
  await page.getByRole('button', { name: 'Replay this run' }).click()
  const scrub = page.getByRole('slider', { name: 'Replay position' })
  await expect(scrub).toHaveValue('0')
  await expect(node(page, 'step1')).toHaveAttribute('data-state', 'waiting')
  await page.getByRole('radio', { name: '16×' }).click()
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  const max = await scrub.getAttribute('max')
  await expect(scrub).toHaveValue(max!, { timeout: 60_000 })
  await expect(node(page, 'end1')).toHaveAttribute('data-state', 'succeeded')
  await expect(node(page, 'step2')).toHaveAttribute('data-state', 'skipped')
})

test('a failing step is routed to a repair step, and the run still reaches its end', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await pair(page)
  const name = `Repair route ${Date.now().toString(36)}`
  await createWorkflow(page, {
    name,
    inputs: [],
    nodes: [
      {
        id: 'build',
        kind: 'agent',
        label: 'Build',
        agentId: 'builder',
        instruction: '[fake:fail] Build the thing',
        retries: 0,
        onFailure: 'route',
      },
      {
        id: 'fix',
        kind: 'agent',
        label: 'Repair',
        agentId: 'reviewer',
        instruction: 'Repair the failed build.',
        retries: 0,
        onFailure: 'fail_run',
      },
      { id: 'good', kind: 'end', label: 'Built' },
      { id: 'fixed', kind: 'end', label: 'Repaired' },
    ],
    edges: [
      { id: 'e1', from: 'build', port: 'ok', to: 'good' },
      { id: 'e2', from: 'build', port: 'failed', to: 'fix' },
      { id: 'e3', from: 'fix', port: 'ok', to: 'fixed' },
    ],
  })
  await startFromList(page, name)
  await expect(node(page, 'build')).toHaveAttribute('data-state', 'failed', { timeout: 60_000 })
  await expect(node(page, 'fix')).toHaveAttribute('data-state', 'succeeded', { timeout: 60_000 })
  await expect(node(page, 'good')).toHaveAttribute('data-state', 'skipped')
  await expect(node(page, 'fixed')).toHaveAttribute('data-state', 'succeeded')
  await expect(page.getByText('Graph reached the end').first()).toBeVisible({ timeout: 30_000 })
  // The failure route is drawn as such, with its words on the edge.
  await expect(page.locator('[data-edge="e2"]')).toHaveClass(/orch-edge--failed/)
  await expect(page.locator('.orch-edge-label', { hasText: 'if it fails' })).toBeVisible()
})

test('an attempt that is not confirmed ended is abandoned, the step is retried, and the run says both what it did and what the graph did', async ({
  page,
}) => {
  test.setTimeout(150_000)
  await pair(page)
  const name = `Flaky step ${Date.now().toString(36)}`
  await createWorkflow(page, {
    name,
    inputs: [],
    nodes: [
      {
        id: 'flaky',
        kind: 'agent',
        label: 'Flaky step',
        agentId: 'builder',
        instruction: '[fake:lose:1] Do the thing',
        retries: 1,
        onFailure: 'fail_run',
      },
      { id: 'done', kind: 'end', label: 'Done' },
    ],
    edges: [{ id: 'e1', from: 'flaky', port: 'ok', to: 'done' }],
  })
  await startFromList(page, name)
  // The fake Hermes reports the first run cancelled, which is not termination evidence.
  const unknown = page.getByRole('region', { name: 'Attempt not confirmed ended' })
  await expect(unknown).toContainText('Not confirmed ended: Flaky step', { timeout: 60_000 })
  await expect(node(page, 'flaky')).toHaveAttribute('data-state', 'running')
  await unknown.getByRole('checkbox').first().check()
  await unknown.getByRole('button', { name: 'Abandon this attempt' }).click()
  // Abandoning pauses the run; the step is unresolved and offers Retry once the run is resumed.
  await expect(page.getByText(/Paused/).first()).toBeVisible({ timeout: 30_000 })
  await expect(node(page, 'flaky')).toHaveAttribute('data-state', 'abandoned')
  await page.getByRole('button', { name: 'Resume', exact: true }).click()
  const retry = page.getByRole('region', { name: 'Retry Flaky step' })
  await expect(retry).toBeVisible({ timeout: 30_000 })
  const button = retry.getByRole('button', { name: 'Retry Flaky step' })
  await expect(button).toBeDisabled()
  await retry.getByRole('checkbox').check()
  await expect(async () => {
    if (await retry.isVisible()) await button.click()
    await expect(retry).toBeHidden({ timeout: 4000 })
  }).toPass({ timeout: 45_000 })
  await expect(node(page, 'flaky')).toHaveAttribute('data-state', 'succeeded', { timeout: 60_000 })
  await expect(page.getByText('Finished, not everything confirmed')).toBeVisible({
    timeout: 60_000,
  })
  await expect(page.getByText('Graph reached the end', { exact: true })).toBeVisible()
  await expect(
    page.getByText('Graph reached the end — 1 abandoned attempt not confirmed ended'),
  ).toBeVisible()
  // The retried attempt is the second of two logical attempts.
  await node(page, 'flaky').click()
  await expect(page.getByRole('region', { name: 'Selected node' })).toContainText('2 of 2 used')
})
