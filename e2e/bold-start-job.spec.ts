import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'

// PLAN 11.10c: every kind of start on the fake adapter, at both review sizes. The seeded demo moves on over time, so
// each test only looks at the job, run, routine or trigger it created itself.
test.use({ reducedMotion: 'reduce' })

const web = { 'x-score-client': 'web' }
const sizes = [
  { name: '1440×900', viewport: { width: 1440, height: 900 } },
  { name: '390×844', viewport: { width: 390, height: 844 } },
] as const

function tag(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

async function openStart(page: Page, from: 'link' | 'room') {
  if (from === 'link') await page.goto('/b?start=job')
  else {
    await page.goto('/b')
    await page.getByRole('button', { name: 'Start a job' }).click()
  }
  const dialog = page.getByRole('dialog', { name: 'Start a job' })
  await expect(dialog).toBeVisible()
  return dialog
}

async function fillAndAcknowledge(page: Page, what: string) {
  const dialog = page.getByRole('dialog', { name: 'Start a job' })
  // A saved recipe takes no free-text "what" (its inputs say what to do).
  const field = dialog.getByLabel('What should the team do?')
  if (await field.isVisible().catch(() => false)) await field.fill(what)
  await dialog.getByRole('checkbox', { name: /Score controls the work it starts/ }).check()
  const start = dialog.getByRole('button', { name: 'Start the job' })
  await expect(start).toBeEnabled({ timeout: 30_000 })
  return { dialog, start }
}

async function createWorkflow(page: Page, name: string): Promise<string> {
  const response = await page.request.post('/api/workflows', {
    headers: web,
    data: {
      definition: {
        name,
        description: 'A recipe for the Start a job e2e.',
        inputs: [],
        nodes: [
          {
            id: 'work',
            kind: 'agent',
            label: 'Do the work',
            agentId: 'builder',
            instruction: 'Write a short release note.',
            retries: 0,
            onFailure: 'fail_run',
          },
          { id: 'done', kind: 'end', label: 'Done' },
        ],
        edges: [{ id: 'work_done', from: 'work', port: 'ok', to: 'done' }],
      },
    },
  })
  expect(response.status()).toBe(201)
  return ((await response.json()) as { workflowId: string }).workflowId
}

async function teamJobs(page: Page) {
  const response = await page.request.get('/api/team-room')
  expect(response.ok()).toBe(true)
  return (
    (await response.json()) as {
      jobs: { id: string; title: string; recipe: { kind: string; ref: string } | null }[]
    }
  ).jobs
}

for (const size of sizes) {
  test.describe(`Start a job at ${size.name}`, () => {
    test.use({ viewport: size.viewport })

    test('lead decides starts a job in the team room with an orchestration', async ({ page }) => {
      await pair(page)
      const title = tag('Lead job')
      const dialog = await openStart(page, 'link')
      expect(await dialog.getAttribute('data-protected')).toBe('block')
      const { start } = await fillAndAcknowledge(page, title)
      await start.click()

      await expect(dialog.getByRole('heading', { name: 'Started' })).toBeVisible()
      await expect(dialog).toContainText(title)
      await expect(dialog).toContainText('The lead is planning it in an orchestration.')
      await expect
        .poll(async () => (await teamJobs(page)).some((job) => job.title === title))
        .toBe(true)
      const runs = await page.request.get('/api/orchestrations')
      expect(runs.ok()).toBe(true)
      const body = (await runs.json()) as { items: { id: string; title: string }[] }
      const run = body.items.find((item) => item.title === title)
      expect(run).toBeDefined()
      // The team-room job is linked to the orchestration it started (11.10c contract).
      const job = (await teamJobs(page)).find((item) => item.title === title)
      expect(job?.recipe).toEqual({ kind: 'orchestration', ref: run!.id })
    })

    test('None starts a plain job in the team room from the room button', async ({ page }) => {
      await pair(page)
      const title = tag('Plain job')
      const dialog = await openStart(page, 'room')
      await dialog.getByRole('radio', { name: 'None' }).click()
      const { start } = await fillAndAcknowledge(page, title)
      await start.click()

      await expect(dialog.getByRole('heading', { name: 'Started' })).toBeVisible()
      await expect(dialog).toContainText('It is waiting in the team room for you.')
      await expect
        .poll(async () => (await teamJobs(page)).some((job) => job.title === title))
        .toBe(true)
    })

    test('a saved recipe starts a workflow run', async ({ page }) => {
      await pair(page)
      const name = tag('Recipe')
      const workflowId = await createWorkflow(page, name)
      const dialog = await openStart(page, 'link')
      await dialog.getByRole('radio', { name }).click()
      await expect(dialog).toContainText('version 1')
      const { start } = await fillAndAcknowledge(page, `${name} run`)
      await start.click()

      await expect(dialog.getByRole('heading', { name: 'Started' })).toBeVisible()
      await expect(dialog).toContainText('The recipe is running in its own room.')
      const runs = await page.request.get('/api/workflow-runs')
      expect(runs.ok()).toBe(true)
      const body = (await runs.json()) as { items: { workflowId: string; title: string }[] }
      expect(body.items.some((run) => run.workflowId === workflowId)).toBe(true)
    })

    test('a schedule creates a routine that appears as a scheduled job', async ({ page }) => {
      await pair(page)
      const title = tag('Scheduled job')
      const dialog = await openStart(page, 'link')
      await dialog.getByRole('radio', { name: 'On a schedule' }).click()
      // People pick the label; the routine gets the value Hermes' scheduler takes (asserted below).
      await expect(dialog.getByRole('combobox', { name: 'Schedule' })).toHaveValue(
        'Every weekday at 9:00',
      )
      const { start } = await fillAndAcknowledge(page, title)
      await start.click()

      await expect(dialog.getByRole('heading', { name: 'Scheduled' })).toBeVisible()
      await expect(dialog).toContainText('It repeats every weekday at 9:00.')
      const routines = await page.request.get('/api/agents/lead/routines')
      expect(routines.ok()).toBe(true)
      const body = (await routines.json()) as { items: { title: string; schedule: string }[] }
      expect(body.items.find((routine) => routine.title === title)?.schedule).toBe('0 9 * * 1-5')

      await dialog.getByRole('button', { name: 'Done' }).click()
      const reopened = await openStart(page, 'room')
      const scheduled = reopened.getByRole('region', { name: 'Scheduled' })
      await expect(scheduled).toContainText(title, { timeout: 30_000 })
      await expect(scheduled).toContainText('lead · Every weekday at 9:00')
    })

    test('a webhook creates a trigger and shows its address and secret once', async ({ page }) => {
      await pair(page)
      const title = tag('Webhook job')
      const triggerName = tag('New ticket')
      const dialog = await openStart(page, 'link')
      await dialog.getByRole('radio', { name: 'When another app calls' }).click()
      await dialog.getByLabel('Trigger name').fill(triggerName)
      await dialog.getByLabel('The app it comes from').fill('Tickets app')
      const { start } = await fillAndAcknowledge(page, title)
      await start.click()

      await expect(dialog.getByRole('heading', { name: 'Trigger created' })).toBeVisible()
      const secretCard = dialog.locator('.start-secret')
      await expect(secretCard).toHaveAttribute('data-protected', 'block')
      const codes = secretCard.locator('code')
      await expect(codes.nth(0)).toContainText('/hooks/trg_')
      const address = await codes.nth(0).textContent()
      const secret = await codes.nth(1).textContent()
      expect(address).toMatch(/^https?:\/\/.+\/hooks\/trg_[a-z0-9]+$/i)
      expect(secret).toMatch(/^whsec_/)

      const triggers = await page.request.get('/api/triggers')
      expect(triggers.ok()).toBe(true)
      const body = (await triggers.json()) as { items: { id: string; name: string; url: string }[] }
      const made = body.items.find((trigger) => trigger.name === triggerName)
      expect(made).toBeDefined()
      expect(made!.url).toBe(address)

      await dialog.getByRole('button', { name: 'Done' }).click()
      const reopened = await openStart(page, 'room')
      await expect(reopened.getByText(secret!, { exact: true })).toHaveCount(0)
    })
  })
}
