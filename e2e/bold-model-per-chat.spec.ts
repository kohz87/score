import { expect, test } from '@playwright/test'
import { acquireLock } from './locks.ts'
import { pair } from './pair.ts'
import { composerOf, makeRoom, openAllInfoSections } from './bold-chat-helpers.ts'

// Decision 182: /model sets an agent's model for one chat. Against the fake adapter, which lists `fake-model` and
// `local-gpt-mini`; the alias `e2edeep` points at the second and is set through the agent's model settings.
// Written by reading, not run here: the release's full check runs it.
test.use({ reducedMotion: 'reduce' })

const web = { 'x-score-client': 'web' }
const headers = () => ({ ...web, 'Idempotency-Key': crypto.randomUUID() })

type Alias = { name: string; model: string; provider?: string | null; editable?: boolean }

// builder's model and repeating jobs are shared state: the 'roster' lock keeps the specs that read the team from seeing
// this one's change, and builder's aliases are put back to what they were.
let release: (() => void) | undefined
let originalAliases: Alias[] = []

test.beforeEach(async ({ page }) => {
  release = await acquireLock('roster')
  await pair(page)
  const read = await page.request.get('/api/agents/builder/model-settings')
  expect(read.ok()).toBe(true)
  originalAliases = ((await read.json()) as { aliases: Alias[] }).aliases
  const saved = await page.request.put('/api/agents/builder/model-settings', {
    headers: headers(),
    data: { aliases: [{ name: 'e2edeep', model: 'local-gpt-mini' }] },
  })
  expect(saved.ok()).toBe(true)
})

test.afterEach(async ({ page }) => {
  try {
    const restored = await page.request.put('/api/agents/builder/model-settings', {
      headers: headers(),
      data: {
        aliases: originalAliases
          .filter((alias) => alias.editable !== false)
          .map(({ name, model, provider }) => ({ name, model, ...(provider ? { provider } : {}) })),
      },
    })
    expect(restored.ok()).toBe(true)
  } finally {
    release?.()
    release = undefined
  }
})

async function send(page: import('@playwright/test').Page, text: string) {
  const composer = composerOf(page)
  await composer.fill(text)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
}

test('@builder /model in a group sets this chat’s model: the palette, the tag, the reply label, Back to its own', async ({
  page,
}) => {
  test.slow()
  await page.setViewportSize({ width: 1440, height: 900 })
  const room = await makeRoom(page, 'model', ['lead', 'builder'])
  await page.goto(`/b?room=${room.id}`)

  const composer = composerOf(page)
  await composer.fill('@builder /model e2e')
  const list = page.getByRole('listbox', { name: 'Commands' })
  await expect(list.getByText('Model for builder in this chat')).toBeVisible()
  await expect(list.getByText('/model e2edeep')).toBeVisible()
  await expect(list.getByText('/model default')).toBeVisible()
  await list.getByText('/model e2edeep').click()
  await expect(composer).toHaveValue('@builder /model e2edeep ')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(
    page.getByText('You set builder’s model to e2edeep (local-gpt-mini) for this chat'),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible()

  // The tag reads "model · effort" with the own part muted; Chat info › Members has it too.
  const panel = page.getByRole('complementary', { name: 'Side panel' })
  await openAllInfoSections(panel)
  const tag = panel.getByRole('button', {
    name: /builder in this chat: model e2edeep, effort its own\. Change/,
  })
  await expect(tag).toHaveText('e2edeep · its own')

  // A reply from builder says which model it ran on.
  await send(page, '@builder what model are you on?')
  await expect(
    page.locator('.bold-reply-model', { hasText: 'local-gpt-mini' }).first(),
  ).toBeVisible({
    timeout: 30_000,
  })

  // Back to its own: the tag goes, and the note says so.
  await send(page, '@builder /model default')
  await expect(page.getByText(/builder is back on its own model in this chat/)).toBeVisible()
  await expect(tag).toHaveCount(0)
})

test('changing the agent’s model asks about its repeating jobs; Keep the jobs pins them, then changes it', async ({
  page,
}) => {
  test.slow()
  await page.setViewportSize({ width: 1440, height: 900 })
  const before = (await (await page.request.get('/api/agents/builder')).json()) as {
    model: { id: string } | null
  }
  const original = before.model?.id ?? 'fake-model'
  const routine = await page.request.post('/api/agents/builder/routines', {
    headers: headers(),
    data: {
      title: 'Model warning job',
      schedule: 'every day at 08:00',
      prompt: 'Summarise the day.',
    },
  })
  expect(routine.ok()).toBe(true)
  try {
    await page.goto('/b/agents/builder')
    const model = page.getByRole('region', { name: 'Model' })
    await expect(model.getByText(/unless it sets its own with \/model/)).toBeVisible()
    await model.getByRole('button', { name: 'Change the model' }).click()
    const form = model.getByRole('form', { name: 'Change model' })
    await form
      .getByRole('combobox')
      .fill(original === 'local-gpt-mini' ? 'fake-model' : 'local-gpt-mini')
    await form.getByRole('button', { name: 'Change model' }).click()

    const warning = page.locator('.bold-model-jobs-warning')
    await expect(warning).toHaveAttribute('role', 'alert')
    await expect(warning).toHaveAttribute('data-protected', 'block')
    await expect(
      warning.getByRole('heading', { name: /repeating jobs? follows? builder’s model/ }),
    ).toBeVisible()
    await expect(warning.getByText(/Model warning job/)).toBeVisible()

    await warning.getByRole('button', { name: /^Keep the jobs on .*, then change$/ }).click()
    await expect(model.getByText(/^Saved: /)).toBeVisible()
    await expect(warning).toHaveCount(0)

    // The job now reads pinned on the Work section.
    await page
      .getByRole('region', { name: 'Work' })
      .getByRole('button', { name: 'Manage repeating jobs' })
      .click()
    await expect(page.getByText('Model warning job').first()).toBeVisible()
    // Only this test's own job is expected to be pinned: it is checked through the API, by its id.
    const made = (await routine.json()) as { id: string }
    const jobs = (await (await page.request.get('/api/agents/builder/routines')).json()) as {
      items: { id: string; model?: string | null }[]
    }
    expect(jobs.items.find((job) => job.id === made.id)?.model).toBeTruthy()
  } finally {
    // Leave the team as other specs expect it: no repeating job of ours, the agent's own model back.
    const made = (await routine.json()) as { id: string }
    await page.request.delete(`/api/routines/${encodeURIComponent(made.id)}`, {
      headers: headers(),
    })
    await page.request.put('/api/agents/builder/model', {
      headers: headers(),
      data: { model: original },
    })
  }
})
