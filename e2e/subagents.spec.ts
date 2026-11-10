import { expect, test } from '@playwright/test'
import { makeTeam } from './one-job-helpers.ts'
import { pair } from './pair.ts'

// Decisions 173-174: an agent's own helpers. The fake adapter starts none of its own, so this covers the limits end to end.

test.beforeEach(async ({ page }) => {
  await pair(page)
})

async function startJob(page: Parameters<typeof makeTeam>[0], roomId: string, title: string) {
  const response = await page.request.post(`/api/rooms/${roomId}/jobs`, {
    headers: {
      'x-score-client': 'web',
      'Idempotency-Key': `job-${title.replace(/\W/g, '-')}-${roomId}`,
    },
    data: { title },
  })
  expect(response.status()).toBe(201)
  return (await response.json()) as { id: string }
}

const limitsOf = async (page: Parameters<typeof makeTeam>[0], roomId: string, jobId: string) => {
  const response = await page.request.get(`/api/rooms/${roomId}/jobs`)
  const body = (await response.json()) as {
    items: { id: string; subagents: { enabled: boolean; maxConcurrent: number | null } }[]
  }
  return body.items.find((job) => job.id === jobId)!.subagents
}

test('/subagents changes the job, shows in the bar, and is never posted to the agents', async ({
  page,
}) => {
  const team = await makeTeam(page, 'Subagents')
  const job = await startJob(page, team.id, 'Add pagination')
  await page.goto(`/b?room=${team.id}`)
  const composer = page.getByRole('combobox', { name: /^Message / })
  await expect(page.getByRole('button', { name: 'Subagents: up to 4' })).toBeVisible()

  await composer.fill('/subagents 2')
  await composer.press('Enter')
  await expect(page.getByRole('button', { name: 'Subagents: 2' })).toBeVisible()
  await expect
    .poll(() => limitsOf(page, team.id, job.id))
    .toMatchObject({ enabled: true, maxConcurrent: 2 })

  await composer.fill('/subagents 9')
  await composer.press('Enter')
  await expect(page.getByText(/that’s the most you can set here/i)).toBeVisible()
  expect(await limitsOf(page, team.id, job.id)).toMatchObject({ maxConcurrent: 2 })

  await composer.fill('/subagents off')
  await composer.press('Enter')
  await expect(page.getByRole('button', { name: 'Subagents: off' })).toBeVisible()

  await composer.fill('/subagents on')
  await composer.press('Enter')
  await expect(page.getByRole('button', { name: 'Subagents: up to 4' })).toBeVisible()
  expect(await limitsOf(page, team.id, job.id)).toMatchObject({
    enabled: true,
    maxConcurrent: null,
  })

  // Nothing went to the agents: the composer's commands are its own.
  await expect(page.getByText('/subagents', { exact: false }).locator('visible=true')).toHaveCount(
    0,
  )
})

test('Start a job sends the choice, and the side panel shows it', async ({ page }) => {
  const team = await makeTeam(page, 'SubagentStart')
  await page.goto(`/b?room=${team.id}&start=job`)
  const dialog = page.getByRole('dialog', { name: 'Start a job' })
  await dialog.getByLabel('What should the team do?').fill('Add a changelog page')
  await dialog.getByRole('radio', { name: '2', exact: true }).click()
  await dialog.getByLabel('Total subagents in this job').fill('7')
  await dialog.getByRole('checkbox', { name: /Score controls the work it starts/ }).check()
  const created = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/api/orchestrations'),
  )
  await dialog.getByRole('button', { name: 'Start the job' }).click()
  const body = (await created).postDataJSON() as {
    topic: { subagents: unknown }
    helpers?: unknown
  }
  expect(body.topic.subagents).toEqual({ enabled: true, maxConcurrent: 2, maxTotal: 7 })
  expect(body.helpers).toBeUndefined()
})

test('voters without helpers are accepted by the server', async ({ page }) => {
  const team = await makeTeam(page, 'SubagentVoters')
  await page.goto(`/b?room=${team.id}&start=job`)
  const dialog = page.getByRole('dialog', { name: 'Start a job' })
  await dialog.getByLabel('What should the team do?').fill('Choose a list library')
  const voters = dialog.locator('.start-voters')
  await voters.getByRole('button', { name: 'Add' }).click()
  await voters.getByRole('button', { name: 'reviewer' }).click()
  await dialog.getByRole('checkbox', { name: /Score controls the work it starts/ }).check()
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().endsWith('/api/orchestrations'),
  )
  await dialog.getByRole('button', { name: 'Start the job' }).click()
  const response = await created
  expect(response.status()).toBe(201)
  expect(response.request().postDataJSON()).toMatchObject({
    helpers: { agentIds: [], voterIds: ['reviewer'] },
  })
})

test('an agent has its subagent settings, and they save', async ({ page }) => {
  await page.goto('/b/agents/builder#agent-subagents')
  const allow = page.getByRole('checkbox', { name: 'Allow subagents' })
  await expect(allow).toBeChecked()
  const card = page.locator('#agent-subagents')
  await card.getByLabel('At once').fill('3')
  await card.getByRole('button', { name: 'Save' }).click()
  await expect
    .poll(
      async () =>
        (await (await page.request.get('/api/agents/builder/subagents')).json()) as object,
    )
    .toMatchObject({ maxConcurrent: 3 })
  await page.request.put('/api/agents/builder/subagents', {
    headers: { 'x-score-client': 'web' },
    data: { maxConcurrent: 4 },
  })
})

test('a phone keeps the page in its width with the subagent control', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const team = await makeTeam(page, 'SubagentPhone')
  await startJob(page, team.id, 'Phone job')
  await page.goto(`/b?room=${team.id}`)
  const control = page.getByRole('button', { name: /Subagents:/ })
  await expect(control).toBeVisible()
  const box = (await control.boundingBox())!
  expect(box.height).toBeGreaterThanOrEqual(44)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
