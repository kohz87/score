import { mkdirSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { fixtureNow } from './now-fixture.ts'
import { orchestrationFixtures } from './orchestration-fixtures.ts'
import { pair } from './pair.ts'
import { openRoom, makeRoom } from './rooms.ts'
import { visualFixtures, visualHello } from './visual-fixtures.ts'

// PLAN 8.6: the quota guard in the browser, against the fake adapter. No model is called and no real CLI is started.
// The coding agent's setting runs against the real server and the fake CLI's own rate-limit record; the held step's card
// is put in front of the real live diagram and the real user view by answering the browser's own requests (the technique
// of coding-workers.spec.ts). The server's side of the guard is covered by the server tests.

const shots = process.env['SCORE_UI_SHOTS']
const shot = async (page: Page, name: string, selector?: string) => {
  if (!shots) return
  mkdirSync(shots, { recursive: true })
  if (selector)
    await page
      .locator(selector)
      .first()
      .screenshot({ path: `${shots}/${name}.png` })
  else await page.screenshot({ path: `${shots}/${name}.png` })
}

const resetsAt = new Date(Date.parse(fixtureNow) + 3 * 3_600_000 + 40 * 60_000).toISOString()
const held = {
  kind: 'quota_low',
  stepId: 's3',
  agentId: 'reviewer',
  window: '5 hours',
  group: null,
  leftPercent: 6,
  resetsAt,
}

/** The fixture run with s3 held because the reviewer's 5-hour limit is low, and the people-facing card to answer. */
function heldRun() {
  const snapshot = structuredClone(orchestrationFixtures['/api/orchestrations/orch-1']) as {
    orchestration: Record<string, unknown> & {
      needsYou: unknown[]
      stepsList: Record<string, unknown>[]
      gates: unknown[]
    }
  }
  const run = snapshot.orchestration
  run.needsYou = [held]
  run.gates = []
  run.coding = { stepLimit: 10, acceptedUnknownCost: [], workers: [] }
  const s3 = run.stepsList.find((step) => step.id === 's3')!
  Object.assign(s3, {
    agentId: 'reviewer',
    status: 'queued',
    gateId: null,
    disposition: 'quota_low',
    quotaHold: {
      agentId: 'reviewer',
      window: '5 hours',
      group: null,
      leftPercent: 6,
      resetsAt,
      state: 'held',
    },
  })
  const list = structuredClone(orchestrationFixtures['/api/orchestrations']) as {
    items: { needsYou: unknown[] }[]
  }
  list.items[0]!.needsYou = [held]
  return { snapshot, list }
}

async function serveHeldRun(page: Page): Promise<{ answers: { url: string; body: unknown }[] }> {
  const { snapshot, list } = heldRun()
  const answers: { url: string; body: unknown }[] = []
  await page.clock.setFixedTime(new Date(fixtureNow))
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === '/api/stream') {
      await route.fulfill({
        contentType: 'text/event-stream',
        body: `event: stream.hello\ndata: ${JSON.stringify(visualHello)}\n\n`,
      })
      return
    }
    if (request.method() === 'POST' && url.pathname.endsWith('/quota')) {
      answers.push({ url: url.pathname, body: request.postDataJSON() })
      await route.fulfill({ json: list.items[0] as unknown })
      return
    }
    url.searchParams.delete('tz')
    const key = `${url.pathname}${url.search}`
    const fixture =
      key === '/api/orchestrations/orch-1'
        ? snapshot
        : key === '/api/orchestrations'
          ? list
          : { ...visualFixtures, ...orchestrationFixtures }[key]
    if (fixture === undefined) {
      await route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'none' } } })
      return
    }
    await route.fulfill({ json: fixture })
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  return { answers }
}

test.describe('a step held for a low limit', () => {
  test.use({ timezoneId: 'UTC', locale: 'en-GB' })

  test('admin view: the diagram says why, and the card sends each of the three answers', async ({
    page,
  }) => {
    const { answers } = await serveHeldRun(page)
    await page.setViewportSize({ width: 1280, height: 1100 })
    await page.goto('/now/flow/brief-orch-1')
    const node = page.locator('[data-node="s3"]')
    await expect(node).toBeVisible()
    await expect(node).toContainText(/Held: limit low \(6% left, resets [^)]+\)/)
    const card = page.getByRole('region', { name: 'reviewer’s limit is low' })
    await expect(card).toBeVisible()
    await expect(card).toContainText('s3 is held:')
    await expect(card).toContainText(/has 6% of its 5-hour limit left, and it resets at [^.]+\./)
    await page.evaluate(() => document.fonts.ready)
    await shot(page, 'held', '.orch-live')
    await card.getByRole('button', { name: 'Wait until it resets' }).click()
    await expect.poll(() => answers.length).toBe(1)
    await card.getByRole('button', { name: 'Use it anyway' }).click()
    await card.getByRole('button', { name: 'Stop the run' }).click()
    await expect.poll(() => answers.length).toBe(3)
    expect(answers.map((a) => a.url)).toEqual(
      Array(3).fill('/api/orchestrations/orch-1/steps/s3/quota'),
    )
    expect(answers.map((a) => a.body)).toEqual([
      { answer: 'wait', orchestrationRevision: 9 },
      { answer: 'use_anyway', orchestrationRevision: 9 },
      { answer: 'stop', orchestrationRevision: 9 },
    ])
  })

  test('user view: the same card appears at the end of the conversation and answers the same way', async ({
    page,
  }) => {
    const { answers } = await serveHeldRun(page)
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/u/rooms/room-activity-feed')
    const card = page
      .locator('.user-needs')
      .getByRole('region', { name: 'reviewer’s limit is low' })
    await expect(card).toBeVisible()
    await expect(card).toContainText('Steps that are already running carry on.')
    await page.evaluate(() => document.fonts.ready)
    await page.evaluate(() => {
      const scroll = document.querySelector('.chat-scroll')
      if (scroll) scroll.scrollTop = scroll.scrollHeight
    })
    await shot(page, 'user')
    await card.getByRole('button', { name: 'Use it anyway' }).click()
    await expect.poll(() => answers.length).toBe(1)
    expect(answers[0]).toEqual({
      url: '/api/orchestrations/orch-1/steps/s3/quota',
      body: { answer: 'use_anyway', orchestrationRevision: 9 },
    })
  })
})

test('coding agent page: the floor is a setting, marked on the limit bars, and it is saved', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const id = `quota-${Date.now().toString(36)}`
  await pair(page)
  const created = await page.request.post('/api/coding-agents', {
    headers: { 'x-score-client': 'web' },
    data: { id, name: id, runtime: 'claude-code', style: { color: '#19C39A', shape: 'hexagon' } },
  })
  expect(created.ok()).toBe(true)
  expect(((await created.json()) as { quotaFloorPercent: number }).quotaFloorPercent).toBe(10)
  // One turn, so the fake CLI's rate-limit record gives the page a reading to draw (94% and 78% left).
  const room = await makeRoom(page, 'qg')
  await openRoom(page, room.label)
  const composer = page.getByRole('combobox', { name: /^Message/ })
  await composer.fill(`@${id} please add a greeting`)
  await composer.press('Enter')
  await expect(
    page
      .getByRole('region', { name: 'Message history' })
      .getByRole('article')
      .filter({ hasText: 'Created hello.txt and changed it.' }),
  ).toBeVisible({ timeout: 30_000 })

  await page.goto(`/team/${encodeURIComponent(id)}`)
  const card = page.getByRole('region', { name: 'Coding agent' })
  const meters = card.getByRole('group', { name: 'Claude Code limits' })
  await expect(meters.getByRole('meter', { name: '5 hours left' })).toHaveAttribute(
    'aria-valuenow',
    '94',
  )
  await expect(meters.locator('.quota-floor')).toHaveCount(2)
  await expect(meters.locator('.quota-floor').first()).toHaveAttribute('style', /left: 10%/)
  const field = card.getByLabel(/Stop using this agent in runs when a limit is below/)
  await expect(field).toHaveValue('10')
  await field.fill('25')
  await card.getByRole('button', { name: 'Save' }).click()
  await expect(meters.locator('.quota-floor').first()).toHaveAttribute('style', /left: 25%/)
  await page.reload()
  await expect(
    page
      .getByRole('region', { name: 'Coding agent' })
      .getByLabel(/Stop using this agent in runs when a limit is below/),
  ).toHaveValue('25')
  await page.evaluate(() => document.fonts.ready)
  await shot(page, 'agent', 'section[aria-label="Coding agent"]')

  // Clean up so other specs see the usual team.
  page.once('dialog', (confirm) => void confirm.accept())
  await page.getByRole('button', { name: 'Remove agent' }).click()
  await expect(page).toHaveURL(/\/team$/)
})
