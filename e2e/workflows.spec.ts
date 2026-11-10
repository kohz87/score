import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'
import {
  finishStartJob,
  openRunOf,
  recipeIdByName,
  startRecipeByName,
  uniqueRecipeName,
} from './recipe-run.ts'

// PLAN 7.1b against the fake adapter: no model is called. Instruction markers script the agents: [fake:verdict:passed]
// replies with a score-verdict block, [fake:fail] ends the step's run failed.

test.describe.configure({ mode: 'serial' })

const tab = (page: Page, name: string) => page.getByRole('tab', { name }).click()
const web = { 'x-score-client': 'web' }

const node = (page: Page, id: string) => page.locator(`[data-node="${id}"]`)
/** The selected card's "Add a step after" menu in the settings panel, then one of its items. */
async function addAfter(page: Page, item: string | RegExp) {
  await page
    .getByRole('complementary', { name: 'Selected step' })
    .getByRole('button', { name: 'Add a step after', exact: true })
    .click()
  await page.getByRole('menuitem', { name: item }).click()
}

async function createWorkflow(page: Page, definition: unknown): Promise<string> {
  const response = await page.request.post('/api/workflows', {
    headers: web,
    data: { definition },
  })
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { workflowId: string }).workflowId
}

/** Run… on the recipe's page opens Start a job (2.8.0); the run opens on its own page. */
async function startFromList(page: Page, name: string, inputs: Record<string, string> = {}) {
  // No budget, as the classic dialog had: a lost attempt's unknown spend would pause the retry under Start a job's $5 cap.
  await startRecipeByName(page, name, inputs, { noBudget: true })
  // The run opens in the Runs panel (2.5.0); its diagram is the Graph tab.
  await tab(page, 'Graph')
}

test('build a workflow with a gate and a branch in the editor, save it, run it, approve the gate and replay it', async ({
  page,
}) => {
  test.setTimeout(180_000)
  await pair(page)
  const unique = uniqueRecipeName('Release notes')
  // Other specs leave their gates pending on the shared server: a gate title of its own (not containing another's, names match as substrings) keeps this run's card unambiguous.
  const gateTitle = `Sign off ${unique.slice(-6)}`
  await page.goto('/b/tasks/recipes')
  await expect(page.getByRole('heading', { name: 'Recipes', level: 2 })).toBeVisible()
  await page.getByRole('button', { name: 'New recipe' }).click()
  // The editor of the recipe that was open is swapped for the new one a render after the address changes: type only into
  // the new one. Only the new recipe offers "version 1" (the old one is at 1 or later and offers the next).
  await expect(page).toHaveURL(/\/b\/tasks\/recipes\/new$/)
  await expect(page.getByRole('button', { name: /^Save as version 1$/ })).toBeVisible()

  // The editor starts with one step and an end, already connected.
  await expect(page.getByRole('heading', { name: 'Nothing selected' })).toBeVisible()
  await page.getByRole('textbox', { name: 'Recipe name' }).fill(unique)

  // A start input the steps can read.
  await page.getByText('Recipe details').click()
  await page.getByRole('button', { name: 'Add an input' }).click()
  const inputs = page.getByRole('region', { name: 'Start inputs' })
  await inputs.getByLabel('Name').fill('topic')
  await inputs.getByLabel('Label').fill('Topic')

  // Replace the starter end: delete it with the keyboard (the layered view asks first), then build the route from the
  // selected card's "Add a step after" menu.
  page.on('dialog', (prompt) => void prompt.accept())
  await node(page, 'end1').focus()
  await page.keyboard.press('Delete')
  await expect(node(page, 'end1')).toHaveCount(0)

  // Step 1: the draft, by builder. The instruction reads the input through the autocomplete.
  await node(page, 'step1').click()
  const inspector = page.getByRole('complementary', { name: 'Selected step' })
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
  await expect(page.locator('.bold-rp-problem')).toContainText('should be an End')

  // Add a gate after it (connected from "when done"), then a branch after the gate.
  await addAfter(page, 'Add a gate')
  await inspector.getByLabel('Title').fill(gateTitle)
  await inspector
    .getByRole('combobox', { name: 'Question' })
    .fill('Is the draft good enough to publish?')
  await addAfter(page, 'Add a branch')
  await inspector.getByLabel('Title').fill('Passed review?')
  await inspector.getByLabel('Looks at').selectOption({ label: 'Draft' })
  // Rule 1 is "the verdict is: passed"; its path goes to an end, the "otherwise" path to a repair step.
  await addAfter(page, 'Add an end')
  await inspector.getByLabel('Title').fill('Published')
  await node(page, 'branch1').click()
  await addAfter(page, /Add an agent step for reviewer/)
  await inspector.getByLabel('Title').fill('Repair')
  await inspector
    .getByRole('combobox', { name: 'Instruction' })
    .fill('Fix the draft: {{nodes.step1.output}}')
  await addAfter(page, 'Add an end')
  await inspector.getByLabel('Title').fill('Repaired')

  // The outline lists the same graph as text.
  await page.getByText('Outline: the graph as text').click()
  const outline = page.getByRole('region', { name: 'Outline' })
  await expect(outline).toContainText('Draft')
  await expect(outline).toContainText(`when done goes to ${gateTitle}`)
  await expect(outline).toContainText('otherwise goes to Repair')

  // Valid: save as version 1.
  await expect(page.getByRole('status').filter({ hasText: 'Looks good' })).toBeVisible({
    timeout: 20_000,
  })
  await expect(page.getByRole('textbox', { name: 'Recipe name' })).toHaveValue(unique)
  await page.getByRole('button', { name: /^Save as version 1$/ }).click()
  await expect(page.getByText('Saved as version 1.').first()).toBeVisible()

  // Start it from the editor: Run… opens Start a job with this recipe chosen.
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('group', { name: 'More' }).getByRole('button', { name: 'Run…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Start a job' })
  await expect(dialog.getByRole('radio', { name: unique })).toBeChecked({ timeout: 30_000 })
  await expect(dialog.getByText(/Score controls the work it starts/).first()).toBeVisible()
  await finishStartJob(page, { Topic: 'the 2.4 release' })
  await openRunOf(page, await recipeIdByName(page, unique))
  await tab(page, 'Graph')

  // The run view: the gate waits for the person with the draft the question is about.
  const gate = page.getByRole('region', { name: `Decide on ${gateTitle}` })
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
  // 3.29.0: no run page; the chat's Graph tab says "Run · title Succeeded" and the log says the run ended.
  await expect(page.getByRole('log', { name: 'Events' })).toContainText('The run ended')
  await expect(node(page, 'step2')).toHaveAttribute('data-state', 'skipped')
  await expect(node(page, 'end1')).toHaveAttribute('data-state', 'succeeded')
  await expect(node(page, 'end2')).toHaveAttribute('data-state', 'skipped')
  await expect(page.locator('[data-edge-state="skipped"]').first()).toBeAttached()
  // The session log sits under the graph (no Log tab any more).
  const log = page.getByRole('log', { name: 'Events' })
  await expect(log).toContainText("Passed review? took 'verdict passed'")

  // Clicking a node filters the log to it and shows what it read and its verdict.
  await node(page, 'step1').click()
  const panel = page.getByRole('region', { name: 'Selected step' })
  await expect(panel).toContainText('Verdict: passed')
  await node(page, 'branch1').click()
  await expect(panel).toContainText('Branch')

  // Replay the finished run from its recorded events.
  await page.getByRole('button', { name: 'Replay this run' }).first().click()
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
  const name = uniqueRecipeName('Repair route')
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
  await expect(page.getByRole('log', { name: 'Events' })).toContainText('The run ended', {
    timeout: 30_000,
  })
  // The failure route is drawn as such, with its words on the edge.
  await expect(page.locator('[data-edge="e2"]')).toHaveClass(/orch-edge--failed/)
  await expect(page.locator('.orch-edge-label', { hasText: 'if it fails' })).toBeVisible()
})

test('an attempt that is not confirmed ended is abandoned, the step is retried, and the run says both what it did and what the graph did', async ({
  page,
}) => {
  test.setTimeout(150_000)
  await pair(page)
  const name = uniqueRecipeName('Flaky step')
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
  const unknown = page.getByRole('region', { name: 'Not confirmed as ended' })
  await expect(unknown).toContainText('Not confirmed as ended: Flaky step', { timeout: 60_000 })
  await expect(node(page, 'flaky')).toHaveAttribute('data-state', 'running')
  await unknown.getByRole('checkbox').first().check()
  await unknown.getByRole('button', { name: 'Stop waiting for this' }).click()
  // Abandoning pauses the run; the step is unresolved and offers Retry once the run is resumed.
  await expect(page.getByRole('article', { name: 'Needs you: Paused' })).toBeVisible({
    timeout: 30_000,
  })
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
  await expect(page.getByText('Finished, not everything confirmed').first()).toBeVisible({
    timeout: 60_000,
  })
  await expect(page.getByText('Workflow reached its end', { exact: true })).toBeVisible()
  // 3.29.0: the outcome note is in the chat's Graph tab.
  await expect(page.locator('.wf-pane-outcome')).toContainText(
    'Workflow reached its end — 1 step run not confirmed as ended',
  )
  // The retried attempt is the second of two logical attempts.
  await node(page, 'flaky').click()
  await expect(page.getByRole('region', { name: 'Selected step' })).toContainText('2 of 2 used')
})

test('saved positions survive an edit in the layered view, and the run view draws the same arrangement', async ({
  page,
}) => {
  test.setTimeout(180_000)
  await pair(page)
  const name = uniqueRecipeName('Free layout')
  const layout = { nodes: { one: { x: 32, y: 48 }, finish: { x: 464, y: 288 } } }
  const id = await createWorkflow(page, {
    name,
    inputs: [],
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
      { id: 'finish', kind: 'end', label: 'Finish' },
    ],
    edges: [{ id: 'e1', from: 'one', port: 'ok', to: 'finish' }],
    layout,
  })
  await page.goto(`/b/tasks/recipes/${id}`)
  // The editor is the layered view: cards are buttons, never placed by the saved positions.
  await expect(node(page, 'one')).toBeVisible()
  await expect(page.locator('.wf-node')).toHaveCount(0)

  // Edit a step's title in its settings and save: the positions in the saved version are untouched.
  await node(page, 'one').click()
  await page
    .getByRole('complementary', { name: 'Selected step' })
    .getByLabel('Title')
    .fill('First, renamed')
  await expect(page.getByText('unsaved changes')).toBeVisible()
  await page.getByRole('button', { name: /^Save as version 2$/ }).click()
  await expect(page.getByText('Saved as version 2.').first()).toBeVisible()
  const detail = await page.request.get(`/api/workflows/${id}`, { headers: web })
  const saved = (await detail.json()) as {
    latest: { definition: { layout?: typeof layout; nodes: { id: string; label: string }[] } }
  }
  expect(saved.latest.definition.layout).toEqual(layout)
  expect(saved.latest.definition.nodes.find((n) => n.id === 'one')?.label).toBe('First, renamed')

  // A run of this version draws the nodes at the stored coordinates.
  await startFromList(page, name)
  await expect(page.getByRole('log', { name: 'Events' })).toContainText('The run ended', {
    timeout: 60_000,
  })
  const inRun = (nodeId: string) =>
    node(page, nodeId).evaluate((el) => {
      const wrapper = el.closest<HTMLElement>('[style*="left"]')!
      return { left: wrapper.style.left, top: wrapper.style.top }
    })
  expect(await inRun('finish')).toEqual({ left: '464px', top: '288px' })
  expect(await inRun('one')).toEqual({ left: '32px', top: '48px' })
})
