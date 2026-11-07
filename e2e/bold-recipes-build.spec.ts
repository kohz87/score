import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'
import { startRecipe, uniqueRecipeName } from './recipe-run.ts'
import {
  chooseStep,
  createViaApi,
  inspector,
  nameRecipe,
  openDetails,
  openRecipes,
  openRecipeText,
  showText,
  step,
  workflows,
} from './bold-recipes-helpers.ts'

test('build a gate and branch as a step list, save, run and approve it', async ({ page }) => {
  test.setTimeout(180_000)
  await pair(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openRecipes(page, 'new')
  await showText(page)

  const name = uniqueRecipeName('Release notes')
  // Other specs leave their gates pending on the shared server: a title of its own keeps this run's card unambiguous.
  const gateTitle = `Sign off ${name.slice(-6)}`
  await nameRecipe(page, name)
  await openDetails(page)
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
  await inspector(page).getByLabel('Title').fill(gateTitle)
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

  const created = (await workflows(page)).find((workflow) => workflow.name === name)!
  await startRecipe(page, created.id, { Topic: 'the 2.4 release' })
  const gate = page.getByRole('region', { name: `Decide on ${gateTitle}` })
  await expect(gate).toBeVisible({ timeout: 60_000 })
  await expect(gate).toContainText('Publish it?')
  await expect(async () => {
    if (await gate.isVisible()) await gate.getByRole('button', { name: 'Approve' }).click()
    await expect(gate).toBeHidden({ timeout: 4000 })
  }).toPass({ timeout: 45_000 })
  // 3.29.0: the chat's Graph tab says how the run ended (no run page): its state line and the End step reached.
  await expect(page.locator('p', { hasText: /Run · .*Succeeded/ }).first()).toBeVisible({
    timeout: 60_000,
  })
  await expect(page.getByRole('button', { name: /^End Published, reached/ })).toBeVisible()
})

test('retries and a failure path, and a join that waits for both paths', async ({ page }) => {
  test.setTimeout(150_000)
  await pair(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: 'reduce' })

  const failureName = uniqueRecipeName('Failure path')
  const failureId = await createViaApi(page, {
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
  await openRecipeText(page, failureName)
  await chooseStep(page, 'Build')
  await inspector(page).getByLabel('Retries').selectOption('2')
  await inspector(page).getByLabel('If it fails').selectOption('route')
  await inspector(page).getByLabel('Failure goes to').selectOption('fixed')
  await expect(page.getByRole('status').filter({ hasText: 'Looks good' })).toBeVisible({
    timeout: 20_000,
  })
  await page.getByRole('button', { name: 'Save as version 2' }).click()
  await expect(page.getByText('Saved as version 2.')).toBeVisible({ timeout: 20_000 })
  await startRecipe(page, failureId)
  await expect(page.getByRole('log', { name: 'Events' })).toContainText('The run ended', {
    timeout: 60_000,
  })

  const joinName = uniqueRecipeName('Wait for both')
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
  await openRecipeText(page, joinName)
  await expect(step(page, 'Wait for both')).toContainText('Waits for Left, Right')
  await chooseStep(page, 'Wait for both')
  await expect(inspector(page)).toContainText('A join waits for every path that leads into it.')
  await inspector(page).getByLabel('Title').fill('Wait for both sides')
  await page.getByRole('button', { name: 'Save as version 2' }).click()
  await expect(page.getByText('Saved as version 2.')).toBeVisible({ timeout: 20_000 })
})
