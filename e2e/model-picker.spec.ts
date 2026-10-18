import { expect, test, type Page } from '@playwright/test'
import { acquireLock } from './locks.ts'
import { pair } from './pair.ts'

const web = { 'x-score-client': 'web' }
// A deleted agent's name is retired for good, and a failed run leaves its agent behind: each repeat and retry gets its
// own name (the first keeps the plain one).
const helperName = (info: { repeatEachIndex: number; retry: number }) =>
  info.repeatEachIndex || info.retry
    ? `picker-helper-${info.repeatEachIndex}-${info.retry}`
    : 'picker-helper'

// Other specs count the team's agents (team.spec.ts, reports.spec.ts): whatever happened above, the helper must go.
async function removeHelper(page: Page, id: string) {
  const live = async () => {
    const response = await page.request.get('/api/agents')
    if (!response.ok()) return undefined
    const body = (await response.json()) as {
      items: { id: string; lifecycle?: { state?: string } }[]
    }
    return body.items.find((agent) => agent.id === id && agent.lifecycle?.state !== 'removed')
  }
  if (!(await live())) return
  // A creation that was still running when the test stopped has to finish before the agent can be deleted.
  await expect.poll(async () => (await live())?.lifecycle?.state, { timeout: 30_000 }).toBe('ready')
  const preview = await page.request.post('/api/agents/preview', {
    headers: web,
    data: { kind: 'delete', agentId: id },
  })
  const { hash } = (await preview.json()) as { hash: string }
  const removal = await page.request.delete(`/api/agents/${id}`, {
    headers: { ...web, 'Idempotency-Key': crypto.randomUUID() },
    data: { typedName: id, previewHash: hash },
  })
  const { id: opId } = (await removal.json()) as { id: string }
  await expect
    .poll(
      async () =>
        (
          (await (await page.request.get(`/api/agents/operations/${opId}`)).json()) as {
            state: string
          }
        ).state,
      { timeout: 30_000 },
    )
    .toBe('completed')
}

// The helper is on the team for a moment (reports.spec.ts and team.spec.ts count agents) and the chosen-models list is
// server-wide (model-settings.spec.ts narrows it for a moment): hold both locks, see locks.ts.
let release: (() => void)[] = []
test.beforeEach(async () => {
  release = [await acquireLock('roster'), await acquireLock('model-lists')]
})
test.afterEach(async ({ page }, testInfo) => {
  try {
    await removeHelper(page, helperName(testInfo))
  } finally {
    for (const free of release.reverse()) free()
    release = []
  }
})

test('pick a model from the connected providers in Add agent and on the Model tab', async ({
  page,
}, testInfo) => {
  const helper = helperName(testInfo)
  await pair(page)
  await page.goto('/team')
  await page.getByRole('button', { name: 'Add agent', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add agent' })
  await dialog.getByLabel('Agent name').fill(helper)
  await dialog.getByLabel('Role or description').fill('Checks the model picker')
  const picker = dialog.getByRole('combobox', { name: 'Model' })
  await picker.fill('gpt')
  const list = dialog.getByRole('listbox', { name: 'Model suggestions' })
  await expect(list.getByRole('group', { name: 'ChatGPT (Codex)' })).toBeVisible()
  await expect(list.getByRole('group', { name: 'Nous Portal' })).toBeVisible()
  await expect(
    list.getByRole('option', { name: /^gpt-6.1-sol.*\$2.00 \/ \$10.00 per 1M/ }),
  ).toBeVisible()
  const unavailable = list.getByRole('option', { name: /openai\/gpt-6.1-sol/ })
  await expect(unavailable).toHaveAttribute('aria-disabled', 'true')
  await expect(unavailable).toContainText('Not on your plan')
  await list.getByRole('option', { name: /^gpt-6.1-sol/ }).click()
  await expect(picker).toHaveValue('gpt-6.1-sol')
  await dialog.getByRole('button', { name: 'Preview changes' }).click()
  await expect(dialog.getByText('Set the model to gpt-6.1-sol via ChatGPT (Codex).')).toBeVisible()
  await dialog.getByRole('button', { name: 'Create agent' }).click()
  await expect(dialog.getByRole('heading', { name: / joined the team$/ })).toBeVisible()
  await dialog.getByRole('link', { name: /^Open / }).click()

  await page.getByRole('tab', { name: 'Model' }).click()
  const panel = page.getByRole('tabpanel')
  await expect(panel.getByText('Through openai-codex.')).toBeVisible()
  const tabPicker = panel.getByRole('combobox', { name: 'Model', exact: true })
  await tabPicker.fill('solar')
  // Only this picker's own list: the tab also has speech settings whose dropdowns have options too.
  const tabList = page.locator(`[id="${await tabPicker.getAttribute('aria-controls')}"]`)
  await expect(tabList.getByRole('option', { name: /upstage/ })).toBeVisible()
  await expect(tabList.getByRole('option')).toHaveCount(1)
  await tabPicker.press('ArrowDown')
  await tabPicker.press('Enter')
  await expect(tabPicker).toHaveValue('upstage/solar-mini4:free')
  await panel.getByRole('button', { name: 'Change model' }).click()
  await expect(panel.getByText('Saved: upstage/solar-mini4:free')).toBeVisible()
  await expect(panel.getByText('Through nous.')).toBeVisible()

  await page.getByRole('tab', { name: 'Overview' }).click()
  await page.getByRole('button', { name: 'Delete agent', exact: true }).click()
  await page.getByLabel(`Type ${helper} to confirm`).fill(helper)
  await page.getByRole('button', { name: 'Confirm deletion' }).click()
  await expect(page.getByRole('heading', { name: 'Agent removed' })).toBeVisible()
})
