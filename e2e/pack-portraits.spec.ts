import { expect, test, type Page } from '@playwright/test'
import { acquireLock } from './locks.ts'
import { pair } from './pair.ts'
import { packFiles } from './pet-pack.ts'

// PLAN 10.8 (decision 109): an agent with a pet pack is drawn as its portrait wherever AgentGlyph draws it. The pack is
// generated (flat-coloured creature, animated PNG), never anyone's art.
const web = { 'x-score-client': 'web' }
const helperName = (info: { repeatEachIndex: number; retry: number }) =>
  info.repeatEachIndex || info.retry
    ? `portrait-${info.repeatEachIndex}-${info.retry}`
    : 'portrait-helper'

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

test('an agent with a pet pack shows its portrait in lists and pages, plays on hover, and the mark returns without the pack', async ({
  page,
}, testInfo) => {
  const helper = helperName(testInfo)
  const release = await acquireLock('roster')
  try {
    await pair(page)
    await page.goto('/team')
    await page.getByRole('button', { name: 'Add agent', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Add agent' })
    await dialog.getByLabel('Agent name').fill(helper)
    await dialog.getByLabel('Role or description').fill('Checks portraits')
    await dialog.getByLabel('Model', { exact: true }).fill('fake-model')
    await dialog.getByRole('button', { name: 'Preview changes' }).click()
    await dialog.getByRole('button', { name: 'Create agent' }).click()
    await expect(dialog.getByRole('heading', { name: / joined the team$/ })).toBeVisible()
    await page.keyboard.press('Escape')

    const upload = await page.request.put(`/api/agents/${helper}/pack`, {
      headers: web,
      multipart: Object.fromEntries(packFiles(['idle']).map((file) => [file.name, file] as const)),
    })
    expect(upload.ok()).toBe(true)

    // The Team member list (xs, plain shape before): the portrait clipped to the shape, outlined.
    await page.goto('/team')
    const members = page.getByRole('navigation', { name: 'Team members' })
    const listed = members.getByRole('link', { name: new RegExp(helper) })
    await expect(listed.locator('.agent-glyph--portrait')).toHaveCount(1)
    await expect(
      listed.locator('img.agent-glyph__still, image.agent-glyph__portrait-image'),
    ).toHaveCount(1)
    // Seeded agents have no pack: their marks are as before.
    await expect(
      members.getByRole('link', { name: /builder/ }).locator('.agent-glyph--portrait'),
    ).toHaveCount(0)

    // Wherever else the helper is drawn at sm and up: a round portrait, the mark as a badge, still until pointed at.
    await page.goto('/chat')
    const roundGlyph = 'span.agent-glyph--portrait:not(.agent-glyph--tile)'
    const glyph = page.locator(roundGlyph).first()
    await expect(glyph.locator('.agent-glyph__portrait')).toBeVisible()
    await expect(glyph.locator('.agent-glyph__badge svg')).toHaveCount(1)
    await expect(glyph.locator('img.agent-glyph__anim')).toHaveCount(0)
    await glyph.hover()
    await expect(glyph.locator('img.agent-glyph__anim')).toHaveCount(1)
    await page.mouse.move(0, 0)
    await expect(glyph.locator('img.agent-glyph__anim')).toHaveCount(0)

    // Under Still it never plays.
    await page.evaluate(() => localStorage.setItem('score.liveliness', 'still'))
    await page.reload()
    const still = page.locator(roundGlyph).first()
    await expect(still).toBeVisible()
    await still.hover()
    await expect(page.locator('img.agent-glyph__anim')).toHaveCount(0)
    await page.evaluate(() => localStorage.removeItem('score.liveliness'))

    // Removing the pack brings the marks back.
    const removed = await page.request.delete(`/api/agents/${helper}/pack`, { headers: web })
    expect(removed.ok()).toBe(true)
    await page.goto('/team')
    await expect(
      members.getByRole('link', { name: new RegExp(helper) }).locator('.agent-glyph--portrait'),
    ).toHaveCount(0)
  } finally {
    try {
      await removeHelper(page, helper)
    } finally {
      release()
    }
  }
})
