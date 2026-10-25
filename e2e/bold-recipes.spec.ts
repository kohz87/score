import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'

// PLAN 11.10d against the fake adapter. A recipe is the 7.1 workflow definition, so every edit here goes through the
// same API and engine; no model is called. Instruction markers script the fake agents: [fake:verdict:passed] replies
// with a passed verdict and [fake:fail] ends that step's attempt failed.

const web = { 'x-score-client': 'web' }
const steps = (page: Page) => page.getByRole('list', { name: 'Steps' })
const exact = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
const step = (page: Page, text: string) =>
  steps(page)
    .locator('.bold-step')
    .filter({ has: page.locator('.bold-step-copy > b', { hasText: exact(text) }) })
const inspector = (page: Page) => page.locator('.bold-recipes-inspector')

async function openRecipes(page: Page) {
  await page.goto('/b?recipes=1')
  await expect(page.getByRole('dialog', { name: 'Recipe editor' })).toBeVisible()
}

async function openDetails(page: Page) {
  const details = page.locator('.bold-recipes-details')
  if (!(await details.evaluate((element) => (element as HTMLDetailsElement).open)))
    await details.locator('summary').click()
  return details
}

async function nameRecipe(page: Page, name: string) {
  const details = await openDetails(page)
  await details.locator('.bold-recipes-details-fields input.bold-field').fill(name)
}

async function chooseStep(page: Page, text: string) {
  await step(page, text).click()
}

async function createViaApi(page: Page, definition: unknown): Promise<string> {
  const response = await page.request.post('/api/workflows', {
    headers: web,
    data: { definition },
  })
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { workflowId: string }).workflowId
}

async function workflows(page: Page) {
  const response = await page.request.get('/api/workflows', { headers: web })
  expect(response.ok()).toBe(true)
  return (
    (await response.json()) as {
      items: { id: string; name: string; latestVersion: number; versions?: unknown[] }[]
    }
  ).items
}

async function workflowDetail(page: Page, id: string) {
  const response = await page.request.get(`/api/workflows/${id}`, { headers: web })
  expect(response.ok()).toBe(true)
  return (await response.json()) as {
    latest: {
      definition: { nodes: { id: string }[]; edges: { from: string; port: string; to: string }[] }
    }
  }
}

/** Coding agents in front of the fake team, including one workflow steps must refuse (the classic editor test). */
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

async function startFromList(page: Page, name: string, inputs: Record<string, string> = {}) {
  await page.goto('/workflows')
  const card = page.getByRole('listitem', { name })
  await card.getByRole('button', { name: /^Run/ }).click()
  const dialog = page.getByRole('dialog', { name: new RegExp(`Start ${name}`) })
  for (const [label, value] of Object.entries(inputs))
    await dialog.getByLabel(new RegExp(`^${label}`)).fill(value)
  await expect(dialog.getByRole('list', { name: 'Agent mapping' })).toContainText('builder')
  await dialog.getByRole('checkbox', { name: /Score controls the work it starts/ }).check()
  const start = dialog.getByRole('button', { name: 'Start the run' })
  await expect(start).toBeEnabled({ timeout: 20_000 })
  await start.click()
  await expect(dialog).toBeHidden()
}

test('build a gate and branch as a step list, save, run and approve it', async ({ page }) => {
  test.setTimeout(180_000)
  await pair(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openRecipes(page)
  await page.getByRole('button', { name: 'New recipe' }).click()

  const name = `Release notes ${Date.now().toString(36)}`
  await nameRecipe(page, name)
  const inputs = page.getByRole('region', { name: 'Start inputs' })
  await inputs.getByRole('button', { name: 'Add an input' }).click()
  await inputs.getByLabel('Name').fill('topic')
  await inputs.getByLabel('Label').fill('Topic')

  await chooseStep(page, 'First step')
  await inspector(page).getByLabel('Title').fill('Draft')
  await inspector(page).getByLabel('Agent').selectOption({ label: 'builder' })
  const instruction = inspector(page).getByRole('combobox', { name: 'Instruction' })
  await instruction.fill('Write the release notes about {{')
  const completions = page.getByRole('listbox', { name: /Values for Instruction/ })
  await expect(completions.getByRole('option')).toContainText(['inputs.topic'])
  await page.keyboard.press('Enter')
  await expect(instruction).toHaveValue('Write the release notes about {{inputs.topic}}')
  await instruction.press('End')
  await instruction.pressSequentially(' [fake:verdict:passed]')

  await page.getByRole('button', { name: 'Gate', exact: true }).click()
  await inspector(page).getByLabel('Title').fill('Approve the draft')
  await inspector(page).getByRole('combobox', { name: 'Question' }).fill('Publish it?')
  await page.getByRole('button', { name: 'Branch', exact: true }).click()
  await inspector(page).getByLabel('Title').fill('Passed review?')
  await inspector(page).getByLabel('Looks at').selectOption({ label: 'Draft' })
  await chooseStep(page, 'Done')
  await inspector(page).getByLabel('Title').fill('Published')

  // The branch's default path goes to a repair step; the new agent continues into Published. The branch row can
  // always repoint either path afterwards.
  await page.getByRole('button', { name: 'Agent step', exact: true }).click()
  await inspector(page).getByLabel('Title').fill('Repair')
  await inspector(page)
    .getByRole('combobox', { name: 'Instruction' })
    .fill('Fix it from {{nodes.step1.output}}')

  // The list is the same graph: branch paths name their numbered targets, the join note is not needed here, and both
  // agents carry their instruction and retries.
  await expect(step(page, 'Passed review?')).toContainText('Branch')
  await expect(page.getByRole('combobox', { name: 'Passed review?: passed goes to' })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'Looks good' })).toBeVisible({
    timeout: 20_000,
  })

  // Undo and redo are the prototype's pair: the rename goes away and comes back.
  await chooseStep(page, 'Repair')
  await inspector(page).getByLabel('Title').fill('Repair once')
  await page.keyboard.press('Control+z')
  await expect(step(page, 'Repair')).toContainText('Repair')
  await page.keyboard.press('Control+Shift+z')
  await expect(step(page, 'Repair once')).toBeVisible()
  await page.keyboard.press('Control+z')

  await page.getByRole('button', { name: 'Save as version 1' }).click()
  await expect(page.getByText('Saved as version 1.')).toBeVisible({ timeout: 20_000 })

  await startFromList(page, name, { Topic: 'the 2.4 release' })
  const gate = page.getByRole('region', { name: 'Decide on Approve the draft' })
  await expect(gate).toBeVisible({ timeout: 60_000 })
  await expect(gate).toContainText('Publish it?')
  await expect(async () => {
    if (await gate.isVisible()) await gate.getByRole('button', { name: 'Approve' }).click()
    await expect(gate).toBeHidden({ timeout: 4000 })
  }).toPass({ timeout: 45_000 })
  await expect(page.getByText('Workflow reached its end').first()).toBeVisible({ timeout: 60_000 })
})

test('retries and a failure path, and a join that waits for both paths', async ({ page }) => {
  test.setTimeout(150_000)
  await pair(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: 'reduce' })

  const failureName = `Failure path ${Date.now().toString(36)}`
  await createViaApi(page, {
    name: failureName,
    inputs: [],
    nodes: [
      {
        id: 'build',
        kind: 'agent',
        label: 'Build',
        agentId: 'builder',
        instruction: '[fake:fail] Build it',
        retries: 0,
        onFailure: 'fail_run',
      },
      {
        id: 'fix',
        kind: 'agent',
        label: 'Fix',
        agentId: 'reviewer',
        instruction: 'Fix it',
        retries: 0,
        onFailure: 'fail_run',
      },
      { id: 'good', kind: 'end', label: 'Built' },
      { id: 'fixed', kind: 'end', label: 'Fixed' },
    ],
    edges: [
      { id: 'e1', from: 'build', port: 'ok', to: 'good' },
      { id: 'e2', from: 'fix', port: 'ok', to: 'fixed' },
    ],
  })
  await openRecipes(page)
  await page.getByRole('button', { name: failureName }).click()
  await chooseStep(page, 'Build')
  await inspector(page).getByLabel('Retries').selectOption('2')
  await inspector(page).getByLabel('If it fails').selectOption('route')
  await inspector(page).getByLabel('Failure goes to').selectOption('fixed')
  await expect(page.getByRole('status').filter({ hasText: 'Looks good' })).toBeVisible({
    timeout: 20_000,
  })
  await page.getByRole('button', { name: 'Save as version 2' }).click()
  await expect(page.getByText('Saved as version 2.')).toBeVisible({ timeout: 20_000 })
  await startFromList(page, failureName)
  await expect(page.getByText('Workflow reached its end').first()).toBeVisible({ timeout: 60_000 })

  const joinName = `Wait for both ${Date.now().toString(36)}`
  await createViaApi(page, {
    name: joinName,
    inputs: [],
    nodes: [
      {
        id: 'start',
        kind: 'agent',
        label: 'Start',
        agentId: 'builder',
        instruction: '[fake:verdict:passed] Start',
        retries: 0,
        onFailure: 'fail_run',
      },
      {
        id: 'pick',
        kind: 'branch',
        label: 'Which way?',
        subject: 'start',
        rules: [{ id: 'rule1', when: { kind: 'verdict', is: 'passed' } }],
      },
      {
        id: 'left',
        kind: 'agent',
        label: 'Left',
        agentId: 'builder',
        instruction: 'Left',
        retries: 0,
        onFailure: 'fail_run',
      },
      {
        id: 'right',
        kind: 'agent',
        label: 'Right',
        agentId: 'reviewer',
        instruction: 'Right',
        retries: 0,
        onFailure: 'fail_run',
      },
      { id: 'both', kind: 'join', label: 'Wait for both', mode: 'all' },
      { id: 'done', kind: 'end', label: 'Done' },
    ],
    edges: [
      { id: 'e1', from: 'start', port: 'ok', to: 'pick' },
      { id: 'e2', from: 'pick', port: 'rule1', to: 'left' },
      { id: 'e3', from: 'pick', port: 'default', to: 'right' },
      { id: 'e4', from: 'left', port: 'ok', to: 'both' },
      { id: 'e5', from: 'right', port: 'ok', to: 'both' },
      { id: 'e6', from: 'both', port: 'ok', to: 'done' },
    ],
  })
  await openRecipes(page)
  await page.getByRole('button', { name: joinName }).click()
  await expect(step(page, 'Wait for both')).toContainText('Waits for Left, Right')
  await chooseStep(page, 'Wait for both')
  await expect(inspector(page)).toContainText('A join waits for every path that leads into it.')
  await page.getByRole('button', { name: 'Save as version 2' }).click()
  await expect(page.getByText('Saved as version 2.')).toBeVisible({ timeout: 20_000 })
})

test('moving and removing steps re-links the saved graph', async ({ page }) => {
  test.setTimeout(150_000)
  await pair(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const name = `Order ${Date.now().toString(36)}`
  const id = await createViaApi(page, {
    name,
    inputs: [],
    nodes: [
      {
        id: 'one',
        kind: 'agent',
        label: 'One',
        agentId: 'builder',
        instruction: 'One',
        retries: 0,
        onFailure: 'fail_run',
      },
      {
        id: 'two',
        kind: 'agent',
        label: 'Two',
        agentId: 'builder',
        instruction: 'Two',
        retries: 0,
        onFailure: 'fail_run',
      },
      {
        id: 'three',
        kind: 'agent',
        label: 'Three',
        agentId: 'builder',
        instruction: 'Three',
        retries: 0,
        onFailure: 'fail_run',
      },
      { id: 'done', kind: 'end', label: 'Done' },
    ],
    edges: [
      { id: 'e1', from: 'one', port: 'ok', to: 'two' },
      { id: 'e2', from: 'two', port: 'ok', to: 'three' },
      { id: 'e3', from: 'three', port: 'ok', to: 'done' },
    ],
  })
  await openRecipes(page)
  await page.getByRole('button', { name }).click()

  await page.getByRole('button', { name: 'Move Two up' }).click()
  await expect(steps(page).locator('.bold-step')).toHaveText([
    /^1.*Two/,
    /^2.*One/,
    /^3.*Three/,
    /^4.*Done/,
  ])
  await expect(page.getByRole('status').filter({ hasText: 'Moved Two to step 1' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Move Two down' })).toBeFocused()
  await page.getByRole('button', { name: 'Save as version 2' }).click()
  await expect(page.getByText('Saved as version 2.')).toBeVisible({ timeout: 20_000 })
  const moved = (await workflowDetail(page, id)).latest.definition.edges
  expect(moved).toHaveLength(3)
  expect(moved).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ from: 'two', port: 'ok', to: 'one' }),
      expect.objectContaining({ from: 'one', port: 'ok', to: 'three' }),
      expect.objectContaining({ from: 'three', port: 'ok', to: 'done' }),
    ]),
  )

  await page.getByRole('button', { name: 'Remove One' }).click()
  await expect(steps(page).locator('.bold-step')).toHaveText([/^1.*Two/, /^2.*Three/, /^3.*Done/])
  await expect(page.getByRole('status').filter({ hasText: 'Removed One' })).toBeVisible()
  await expect(page.locator('[data-recipe-step="three"] .bold-step')).toBeFocused()
  await page.getByRole('button', { name: 'Save as version 3' }).click()
  await expect(page.getByText('Saved as version 3.')).toBeVisible({ timeout: 20_000 })
  const removed = (await workflowDetail(page, id)).latest.definition
  expect(removed.nodes.map((node) => node.id)).toEqual(['two', 'three', 'done'])
  expect(removed.edges).toHaveLength(2)
  expect(removed.edges).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ from: 'two', port: 'ok', to: 'three' }),
      expect.objectContaining({ from: 'three', port: 'ok', to: 'done' }),
    ]),
  )
})

test('the step list offers coding agents, refuses Antigravity, and Validate keeps Save disabled', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await pair(page)
  await withCodingAgents(page)
  // What the server answers on a computer without supervised coding services (the server tests cover the rule itself).
  await page.route('**/api/workflows/validate', async (route) => {
    const sent = route.request().postDataJSON() as {
      definition: { nodes: { id: string; agentId?: string }[] }
    }
    const coding = sent.definition.nodes.filter((node) => node.agentId?.startsWith('coder-'))
    if (coding.length === 0) return route.fallback()
    await route.fulfill({
      json: {
        ok: false,
        stats: { nodes: sent.definition.nodes.length, edges: 1, maxSteps: 1, bytes: 400 },
        issues: coding.map((node) => ({
          code: 'coding_workers_need_units',
          severity: 'error',
          nodeId: node.id,
          edgeId: null,
          field: 'agentId',
          message:
            'Coding agents can take workflow steps only where Score runs them as supervised system services, and this computer isn’t set up for that right now. Settings › Coding shows what is missing.',
        })),
      },
    })
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openRecipes(page)
  await page.getByRole('button', { name: 'New recipe' }).click()
  await chooseStep(page, 'First step')
  const picker = inspector(page).getByLabel('Agent')
  await expect(picker.locator('option', { hasText: 'coder-a · Codex' })).not.toHaveAttribute(
    'disabled',
  )
  await expect(picker.locator('option', { hasText: 'coder-b · Claude Code' })).not.toHaveAttribute(
    'disabled',
  )
  const refused = picker.locator('option', { hasText: 'coder-c · Antigravity' })
  await expect(refused).toHaveAttribute('disabled', '')
  await expect(refused).toHaveText(/can’t take workflow steps/)

  await inspector(page).getByRole('combobox', { name: 'Instruction' }).fill('Build the page.')
  await picker.selectOption({ label: 'coder-a · Codex' })
  await expect(inspector(page)).toContainText('Codex works on this computer')
  await expect(page.getByText(/Coding agents can take workflow steps only/)).toBeVisible({
    timeout: 20_000,
  })
  await expect(page.getByText('Settings › Coding')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save as version 1' })).toBeDisabled()

  await picker.selectOption({ label: 'builder' })
  await expect(page.getByText(/Coding agents can take workflow steps only/)).toBeHidden({
    timeout: 20_000,
  })
  await expect(page.getByRole('button', { name: 'Save as version 1' })).toBeEnabled({
    timeout: 20_000,
  })
})

test('conflict, older version, scrubbed export and delete', async ({ page }) => {
  test.setTimeout(150_000)
  await pair(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const name = `Versions ${Date.now().toString(36)}`
  const id = await createViaApi(page, {
    name,
    inputs: [],
    nodes: [
      {
        id: 'one',
        kind: 'agent',
        label: 'One',
        agentId: 'builder',
        instruction: 'Do it',
        retries: 0,
        onFailure: 'fail_run',
      },
      { id: 'done', kind: 'end', label: 'Done' },
    ],
    edges: [{ id: 'e1', from: 'one', port: 'ok', to: 'done' }],
  })
  await openRecipes(page)
  await page.getByRole('button', { name }).click()
  await chooseStep(page, 'One')
  await inspector(page).getByLabel('Title').fill('One v2')
  await page.getByRole('button', { name: 'Save as version 2' }).click()
  await expect(page.getByText('Saved as version 2.')).toBeVisible({ timeout: 20_000 })

  const advance = await page.request.post(`/api/workflows/${id}/versions`, {
    headers: web,
    data: {
      baseVersion: 2,
      definition: {
        name,
        inputs: [],
        nodes: [
          {
            id: 'one',
            kind: 'agent',
            label: 'One v3',
            agentId: 'builder',
            instruction: 'Do it',
            retries: 0,
            onFailure: 'fail_run',
          },
          { id: 'done', kind: 'end', label: 'Done' },
        ],
        edges: [{ id: 'e1', from: 'one', port: 'ok', to: 'done' }],
      },
    },
  })
  expect(advance.ok()).toBe(true)
  await inspector(page).getByLabel('Title').fill('Mine')
  await page.getByRole('button', { name: 'Save as version 3' }).click()
  const conflict = page.getByRole('alert', { name: 'Someone saved first' })
  await expect(conflict).toBeVisible({ timeout: 20_000 })
  await expect(conflict).toContainText('Version 3')
  await conflict.getByRole('button', { name: /Keep my draft and build on version 3/ }).click()
  await page.getByRole('button', { name: 'Save as version 4' }).click()
  await expect(page.getByText('Saved as version 4.')).toBeVisible({ timeout: 20_000 })

  const details = await openDetails(page)
  await expect(details.getByLabel('Start from an older version')).toBeVisible()
  await inspector(page).getByLabel('Title').fill('Mine, unsaved')
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('unsaved changes')
    await dialog.dismiss()
  })
  await details.getByLabel('Start from an older version').selectOption('1')
  await expect(inspector(page).getByLabel('Title')).toHaveValue('Mine, unsaved')
  await expect(page.getByText(/editing version 1/)).toBeHidden()
  await details.getByLabel('Start from an older version').selectOption('')

  page.once('dialog', (dialog) => dialog.accept())
  await details.getByLabel('Start from an older version').selectOption('1')
  await expect(page.getByText(/editing version 1/)).toBeVisible({ timeout: 20_000 })
  await expect(step(page, 'One')).toBeVisible()
  await chooseStep(page, 'One')
  await page.keyboard.press('Control+z')
  await expect(inspector(page).getByLabel('Title')).toHaveValue('Mine, unsaved')
  await page.keyboard.press('Control+Shift+z')
  await expect(inspector(page).getByLabel('Title')).toHaveValue('One')
  await page.getByRole('button', { name: 'Save as version 5' }).click()
  await expect(page.getByText('Saved as version 5.')).toBeVisible({ timeout: 20_000 })

  await page.getByRole('button', { name: 'Export' }).click()
  const exported = page.getByRole('dialog', { name: new RegExp(`Export ${name}`) })
  await expect(exported).toBeVisible({ timeout: 20_000 })
  await expect(exported).toContainText('Version 5 as JSON')
  await expect(exported.locator('pre.orch-pre').last()).toContainText('score.workflow/1')
  await exported.getByRole('button', { name: 'Close' }).click()

  page.once('dialog', (dialog) => dialog.accept())
  await (await openDetails(page)).getByRole('button', { name: 'Delete recipe' }).click()
  await expect(page.getByText('Deleted the recipe.')).toBeVisible({ timeout: 20_000 })
  expect((await workflows(page)).some((workflow) => workflow.id === id)).toBe(false)
})

test("a failed live check says it couldn't check the recipe and keeps Save disabled", async ({
  page,
}) => {
  await pair(page)
  await page.route('**/api/workflows/validate', (route) =>
    route.fulfill({
      status: 500,
      json: { error: { code: 'internal', message: 'check failed' } },
    }),
  )
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openRecipes(page)
  await expect(page.getByText("Couldn't check this recipe", { exact: true })).toBeVisible({
    timeout: 20_000,
  })
  // Other tests save versions on the shared fake server, so the number varies.
  await expect(page.getByRole('button', { name: /^Save as version \d+$/u })).toBeDisabled()
})

test('Escape and a scrim click ask before closing a dirty recipe', async ({ page }) => {
  await pair(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openRecipes(page)
  const dialog = page.getByRole('dialog', { name: 'Recipe editor' })
  await inspector(page).getByLabel('Title').fill('Changed, not saved')

  page.once('dialog', (prompt) => prompt.dismiss())
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await expect(inspector(page).getByLabel('Title')).toHaveValue('Changed, not saved')

  page.once('dialog', (prompt) => prompt.accept())
  await page.locator('.bold-scrim').click({ position: { x: 2, y: 2 } })
  await expect(dialog).toBeHidden()
})

test('a phone turns the recipe dialog into a full-screen sheet with the inspector below the list', async ({
  page,
}) => {
  await pair(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openRecipes(page)
  await page.getByRole('button', { name: 'New recipe' }).click()
  const dialog = page.getByRole('dialog', { name: 'Recipe editor' })
  const box = await dialog.boundingBox()
  expect(box?.x).toBe(0)
  expect(box?.width).toBe(390)
  expect(box?.height).toBeGreaterThanOrEqual(844)
  const list = await page.locator('.bold-recipes-listcol').boundingBox()
  const panel = await inspector(page).boundingBox()
  expect(panel!.y).toBeGreaterThan(list!.y + list!.height - 1)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0)
  await expect(page.getByRole('button', { name: 'Save as version 1' })).toBeVisible()
})
