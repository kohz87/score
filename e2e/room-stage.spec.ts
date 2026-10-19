import { expect, test, type Page } from '@playwright/test'
import { acquireLock } from './locks.ts'
import { pair } from './pair.ts'
import { packFiles } from './pet-pack.ts'
import { makeRoom } from './rooms.ts'

// PLAN 10.10 (decision 110): the room stage under a chat room's title. The pack is generated (flat-coloured creature,
// animated PNG), never anyone's art; the helper agent and its pack are removed in `finally`.
const web = { 'x-score-client': 'web' }
const helperName = (info: { repeatEachIndex: number; retry: number }) =>
  info.repeatEachIndex || info.retry
    ? `stage-${info.repeatEachIndex}-${info.retry}`
    : 'stage-helper'

async function agentState(page: Page, id: string) {
  const response = await page.request.get('/api/agents')
  if (!response.ok()) return undefined
  const body = (await response.json()) as {
    items: { id: string; lifecycle?: { state?: string } }[]
  }
  return body.items.find((agent) => agent.id === id && agent.lifecycle?.state !== 'removed')
}

async function removeHelper(page: Page, id: string) {
  if (!(await agentState(page, id))) return
  await expect
    .poll(async () => (await agentState(page, id))?.lifecycle?.state, { timeout: 30_000 })
    .toBe('ready')
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

async function addHelper(page: Page, name: string) {
  await page.goto('/team')
  await page.getByRole('button', { name: 'Add agent', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add agent' })
  await dialog.getByLabel('Agent name').fill(name)
  await dialog.getByLabel('Role or description').fill('Stands on the stage')
  await dialog.getByLabel('Model', { exact: true }).fill('fake-model')
  await dialog.getByRole('button', { name: 'Preview changes' }).click()
  await dialog.getByRole('button', { name: 'Create agent' }).click()
  await expect(dialog.getByRole('heading', { name: / joined the team$/ })).toBeVisible()
  await page.keyboard.press('Escape')
  const upload = await page.request.put(`/api/agents/${name}/pack`, {
    headers: web,
    multipart: Object.fromEntries(
      packFiles(['idle', 'work', 'needs', 'walk', 'coffee']).map(
        (file) => [file.name, file] as const,
      ),
    ),
  })
  expect(upload.ok()).toBe(true)
}

const member = (page: Page, name: string) =>
  page
    .getByRole('group', { name: 'Room members' })
    .getByRole('button', { name: new RegExp(`^${name},`) })

test('the room stage shows pets and marks, follows the room’s mood, mentions on click and hides per device', async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000)
  const helper = helperName(testInfo)
  const release = await acquireLock('roster')
  try {
    await pair(page)
    await addHelper(page, helper)
    const room = await makeRoom(page, 'stage', ['lead', helper, 'builder'], 'lead')
    await page.goto(`/chat/${room.id}`)

    // Members: the pack agent is a pet with its mark as a badge; the others are marks. All have names.
    const stage = page.getByRole('group', { name: 'Room members' })
    await expect(stage).toBeVisible()
    await expect(stage.getByRole('button')).toHaveCount(3)
    const pet = member(page, helper)
    await expect(pet.locator('img.room-stage__anim--on')).toHaveAttribute('data-anim', 'idle')
    await expect(pet.locator('.room-stage__badge .agent-glyph')).toHaveCount(1)
    await expect(pet.locator('.room-stage__name')).toHaveText(helper)
    await expect(member(page, 'builder').locator('img')).toHaveCount(0)
    await expect(member(page, 'builder').locator('.room-stage__mark .agent-glyph')).toHaveCount(1)
    // The strip has real size and the pet is not squeezed thin.
    const box = await pet.locator('img.room-stage__anim--on').boundingBox()
    expect(box!.height).toBeGreaterThan(90)
    expect(box!.width).toBeGreaterThan(60)

    // Click a member: its mention goes into the composer, which has focus.
    const composer = page.getByRole('combobox', { name: /^Message/ })
    await member(page, 'builder').click()
    await expect(composer).toHaveValue('@builder ')
    await expect(composer).toBeFocused()
    await expect(member(page, 'builder').locator('.room-stage__say')).toBeVisible()
    await composer.fill('')

    // A turn in the room: the lead is thinking or working while the reply is open.
    const quiet = `Please go quiet ${Date.now()}`
    await composer.fill(quiet)
    await composer.press('Enter')
    await expect
      .poll(async () => member(page, 'lead').getAttribute('data-mood'), { timeout: 20_000 })
      .toMatch(/^(think|work)$/)
    const reply = page
      .getByRole('region', { name: 'Message history' })
      .getByRole('article')
      .filter({
        has: page.getByRole('button', { name: /^Stop reply from/ }),
      })
    await reply.getByRole('button', { name: /^Stop reply from/ }).click()
    await expect(member(page, 'lead')).toHaveAttribute('data-mood', 'rest', { timeout: 20_000 })

    // Waiting for you: a "!" and a step to the front, until the approval is answered.
    await composer.fill(`Please ask for approval before installing ${Date.now()}`)
    await composer.press('Enter')
    const lead = member(page, 'lead')
    await expect(lead).toHaveAttribute('data-mood', 'needs', { timeout: 20_000 })
    await expect(lead).toHaveAttribute('data-front', 'true')
    await expect(lead.locator('.room-stage__bang')).toBeVisible()
    const card = page.getByRole('group', { name: /^Approval: / }).last()
    await card.getByRole('button', { name: 'Approve' }).click()
    await expect(lead).not.toHaveAttribute('data-mood', 'needs', { timeout: 20_000 })

    // Hide stage: gone, remembered across a reload; Show stage brings it back.
    await page.getByRole('button', { name: 'Hide stage' }).click()
    await expect(stage).toHaveCount(0)
    await page.reload()
    await expect(page.getByRole('button', { name: 'Show stage' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    await expect(stage).toHaveCount(0)
    await page.getByRole('button', { name: 'Show stage' }).click()
    await expect(stage).toBeVisible()

    // Still: first frames only, no animated image anywhere on the stage.
    await page.evaluate(() => localStorage.setItem('score.liveliness', 'still'))
    await page.reload()
    await expect(stage).toBeVisible()
    await expect(stage.locator('img')).toHaveCount(0)
    await expect(pet.locator('canvas.room-stage__anim--on')).toHaveCount(1)
    await page.evaluate(() => localStorage.removeItem('score.liveliness'))
  } finally {
    try {
      await removeHelper(page, helper)
    } finally {
      release()
    }
  }
})

test('on a phone the strip is shorter', async ({ page }) => {
  await pair(page)
  await page.setViewportSize({ width: 390, height: 800 })
  const room = await makeRoom(page, 'stage-phone', ['lead', 'builder'], 'lead')
  await page.goto(`/chat/${room.id}`)
  const stage = page.getByRole('group', { name: 'Room members' })
  await expect(stage.getByRole('button')).toHaveCount(2)
  const strip = await stage.locator('.room-stage__strip').boundingBox()
  expect(strip!.height).toBeLessThanOrEqual(122)
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
})
