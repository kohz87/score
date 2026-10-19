import { expect, test, type Page } from '@playwright/test'
import { acquireLock } from './locks.ts'
import { pair } from './pair.ts'
import { packFiles, zipOf } from './pet-pack.ts'
import { mockThemes, type MockTheme } from './themes-fixtures.ts'

// PLAN 10.2b (decisions 107–108): choose a look and a shape from the real forms, then give an agent a pet pack, watch it
// play, and remove it again, against the real server (fake Hermes). The packs are generated here (flat-coloured
// creatures, animated PNG), never anyone's art.
const web = { 'x-score-client': 'web' }
// A deleted agent's name is retired for good: each test, repeat and retry gets its own.
const helperName = (info: { repeatEachIndex: number; retry: number; title: string }) => {
  const kind = info.title.startsWith('a pet pack')
    ? 'pack'
    : info.title.includes('crossfades')
      ? 'fade'
      : info.title.includes('hops')
        ? 'hop'
        : 'shape'
  return info.repeatEachIndex || info.retry
    ? `looks-${kind}-${info.repeatEachIndex}-${info.retry}`
    : `looks-${kind}`
}

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

// The helper is on the team for a moment, and other specs count agents (locks.ts).
let release: (() => void) | undefined
test.beforeEach(async () => {
  release = await acquireLock('roster')
})
test.afterEach(async ({ page }, testInfo) => {
  try {
    await removeHelper(page, helperName(testInfo))
  } finally {
    release?.()
    release = undefined
  }
})

async function addHelper(page: Page, helper: string) {
  await pair(page)
  await page.goto('/team')
  await page.getByRole('button', { name: 'Add agent', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add agent' })
  await dialog.getByLabel('Agent name').fill(helper)
  await dialog.getByLabel('Role or description').fill('Checks how agents look')
  await dialog.getByLabel('Model', { exact: true }).fill('fake-model')
  return dialog
}

async function createAndOpen(dialog: ReturnType<Page['getByRole']>) {
  await dialog.getByRole('button', { name: 'Preview changes' }).click()
  await dialog.getByRole('button', { name: 'Create agent' }).click()
  await expect(dialog.getByRole('heading', { name: / joined the team$/ })).toBeVisible()
  await dialog.getByRole('link', { name: /^Open / }).click()
}

test('look and shape: add an agent as a ring with a new shape, then change both on the agent page', async ({
  page,
}, testInfo) => {
  const helper = helperName(testInfo)
  const dialog = await addHelper(page, helper)

  // Two looks and twenty shapes, as radio groups; the keyboard moves through a group like any native one.
  const shapes = dialog.getByRole('radiogroup', { name: 'Shape' })
  await expect(shapes.getByRole('radio')).toHaveCount(20)
  await expect(dialog.getByRole('radiogroup', { name: 'Look' }).getByRole('radio')).toHaveCount(2)
  await expect(dialog.getByRole('radio', { name: 'Cut-out' })).toBeChecked()
  const triangle = dialog.getByRole('radio', { name: 'triangle' })
  await expect(triangle).toBeChecked()
  await triangle.focus()
  await page.keyboard.press('ArrowRight')
  await expect(dialog.getByRole('radio', { name: 'diamond' })).toBeChecked()
  await dialog.getByRole('radio', { name: 'gem' }).check()
  await dialog.getByRole('radio', { name: 'Ring' }).check()
  await expect(dialog.getByRole('img', { name: `${helper}, gem` })).toHaveClass(/agent-glyph--ring/)
  await createAndOpen(dialog)

  // The agent page shows the chosen look; the style button opens the same choices.
  const trigger = page.getByRole('button', { name: /^Change .* look, colour and shape$/ })
  await expect(trigger.locator('.agent-glyph--ring')).toHaveCount(1)
  await trigger.click()
  const appearance = page.getByRole('dialog', { name: 'Agent appearance' })
  await expect(appearance.getByRole('radio', { name: 'Ring' })).toBeChecked()
  await expect(appearance.getByRole('radio', { name: 'gem' })).toBeChecked()
  await appearance.getByRole('radio', { name: 'Cut-out' }).check()
  await appearance.getByRole('radio', { name: 'cloud' }).check()
  await appearance.getByRole('button', { name: 'Save appearance' }).click()
  await expect(appearance).toBeHidden()
  await expect(trigger.locator('.agent-glyph--cut')).toHaveCount(1)
  const saved = await (await page.request.get(`/api/agents/${helper}`)).json()
  expect(saved.style).toMatchObject({ shape: 'cloud', look: 'cut', pack: null })
  // The server refuses the old looks.
  const refused = await page.request.patch(`/api/agents/${helper}/style`, {
    headers: web,
    data: { look: 'bot' },
  })
  expect(refused.status()).toBe(400)
})

test('a pet pack: refused with reasons, accepted from a zip with its stray files listed, played by mood, removed', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1400, height: 1000 })
  const helper = helperName(testInfo)
  const dialog = await addHelper(page, helper)
  await createAndOpen(dialog)
  const trigger = page.getByRole('button', { name: /^Change .* look, colour and shape$/ })
  await trigger.click()
  const appearance = page.getByRole('dialog', { name: 'Agent appearance' })

  // How to make a pack: a disclosure with the naming table.
  const guide = appearance.getByText('How to make a pack')
  await guide.click()
  await expect(appearance.getByRole('rowheader', { name: 'idle' })).toBeVisible()
  await expect(appearance.getByText('64–2048 px per side')).toBeVisible()
  await guide.click()

  // A pack without idle, and a file named for no activity, are refused with the server's reasons and nothing is stored.
  const input = appearance.getByLabel('Pet pack files')
  await input.setInputFiles(packFiles(['work']))
  await appearance.getByRole('button', { name: 'Use this pack' }).click()
  await expect(appearance.getByRole('alert')).toContainText(/idle/i)
  await appearance.getByRole('button', { name: 'Cancel pack' }).click()
  await input.setInputFiles(packFiles(['idle', 'sparkle']))
  await appearance.getByRole('button', { name: 'Use this pack' }).click()
  await expect(appearance.getByRole('alert')).toContainText(/sparkle/i)
  await appearance.getByRole('button', { name: 'Cancel pack' }).click()
  expect((await (await page.request.get(`/api/agents/${helper}`)).json()).style.pack).toBeNull()

  // A zip with one top-level folder, an activity file in each case, pet.json and stray files the server leaves out.
  const files = packFiles(['idle', 'work', 'sleep'])
  const zip = zipOf([
    ...files.map((file) => ({ name: `luna/${file.name}`, buffer: file.buffer })),
    {
      name: 'luna/pet.json',
      buffer: Buffer.from(JSON.stringify({ name: 'Test pack', floor: 0.02 })),
    },
    { name: '__MACOSX/luna/._idle.png', buffer: Buffer.from('x') },
    { name: 'luna/.DS_Store', buffer: Buffer.from('x') },
  ])
  await input.setInputFiles({ name: 'luna.zip', mimeType: 'application/zip', buffer: zip })
  await appearance.getByRole('button', { name: 'Use this pack' }).click()
  const added = appearance.getByRole('status')
  await expect(added).toContainText('Pack added: idle, work, sleep')
  const ignored = (await added.getByRole('listitem').allTextContents()).map((text) => text.trim())
  expect(ignored).toEqual([...ignored].sort())
  expect(ignored.join(' ')).toContain('.DS_Store')
  await expect(appearance.getByText('Test pack')).toBeVisible()
  // The panel is bounded by the window and scrolls inside that, so the last line is reachable and visible.
  const bottom = await appearance.evaluate((panel) => panel.getBoundingClientRect().bottom)
  expect(bottom).toBeLessThanOrEqual(1000)
  await added.scrollIntoViewIfNeeded()
  await expect(added).toBeInViewport({ ratio: 1 })

  const stored = (await (await page.request.get(`/api/agents/${helper}`)).json()).style.pack
  expect(stored.activities).toEqual(expect.arrayContaining(['idle', 'work', 'sleep']))
  expect(stored.floor).toBe(0.02)
  // The files are served at their revision, as the images they are, and nowhere else.
  const url = `/api/agents/${helper}/pack/idle?rev=${stored.rev}`
  const served = await page.request.get(url)
  expect(served.status()).toBe(200)
  expect(served.headers()['content-type']).toBe('image/png')
  expect((await page.request.get(`/api/agents/${helper}/pack/idle?rev=stale`)).status()).toBe(404)
  expect(
    (await page.request.get(`/api/agents/${helper}/pack/think?rev=${stored.rev}`)).status(),
  ).toBe(404)
  expect((await page.request.get(`/api/agents/${helper}/pack/idle`)).status()).toBe(400)

  // The page header now wears the pet, with the agent's mark as its badge.
  await page.keyboard.press('Escape')
  await expect(trigger.locator('.pet-avatar')).toHaveCount(1)
  await expect(trigger.locator('.pet-avatar__badge .agent-glyph')).toHaveCount(1)
  await expect(trigger.locator('img[data-anim="idle"]')).toHaveAttribute('src', url)

  // The Team card plays the file for what the agent is doing (the agents snapshot is answered with a status).
  const withStatus = async (status: string, activity: string) => {
    await page.route('**/api/agents', async (route) => {
      const body = await (await route.fetch()).json()
      for (const item of body.items)
        if (item.id === helper) Object.assign(item, { status, activity })
      await route.fulfill({ json: body })
    })
    await page.goto('/team')
    return page.locator('.team-agent-card', { hasText: helper })
  }
  let card = await withStatus('working', 'Typing')
  await expect(card.locator('img[data-anim="work"]')).toHaveClass(/pet-avatar__anim--on/)
  await expect(card.locator('.pet-avatar__fx')).toHaveCount(0)
  // No `needs` file in this pack: idle plays with the "!" overlay and a hop.
  await page.unroute('**/api/agents')
  card = await withStatus('waiting', 'Needs you')
  await expect(card.locator('img[data-anim="idle"]')).toHaveClass(/pet-avatar__anim--on/)
  await expect(card.locator('.pet-avatar__alert')).toBeVisible()
  await expect(card.locator('.pet-avatar__stage--hop')).toHaveCount(1)
  await page.unroute('**/api/agents')

  // Pointing at it says hi (no greet file), and Still shows one still frame on a canvas instead of the animation.
  card = await withStatus('idle', '')
  await card.locator('.pet-avatar').hover()
  await expect(card.locator('.pet-avatar__say')).toBeVisible()
  await page.unroute('**/api/agents')
  await page.evaluate(() => localStorage.setItem('score.liveliness', 'still'))
  card = await withStatus('idle', '')
  await expect(page.locator('html')).toHaveAttribute('data-liveliness', 'still')
  await expect(card.locator('.pet-avatar canvas')).toHaveCount(1)
  await expect(card.locator('.pet-avatar img.pet-avatar__anim')).toHaveCount(0)
  await page.unroute('**/api/agents')
  await page.evaluate(() => localStorage.removeItem('score.liveliness'))

  // Remove the pack: the mark comes back and the files are gone.
  await page.goto(`/team/${helper}`)
  await trigger.click()
  await appearance.getByRole('button', { name: 'Remove pack' }).click()
  await expect(trigger.locator('.pet-avatar')).toHaveCount(0)
  await expect(trigger.locator('.agent-glyph--cut')).toHaveCount(1)
  expect((await page.request.get(url)).status()).toBe(404)
})

// A custom theme must not break the pet: protected.css pins opacity and transform on everything inside a protected
// surface, and the crossfade (opacity), the centring and the hop (transform) are Score's own. Found in review (10.2b).
test('a pet under a custom theme still crossfades to the current file only, stays centred and hops', async ({
  page,
}, testInfo) => {
  const helper = helperName(testInfo)
  await addHelper(page, helper).then(createAndOpen)
  const files = packFiles(['idle', 'sleep'])
  const put = await page.request.put(`/api/agents/${helper}/pack`, {
    headers: web,
    multipart: Object.fromEntries(
      files.map((file) => [
        file.name,
        { name: file.name, mimeType: file.mimeType, buffer: file.buffer },
      ]),
    ),
  })
  expect(put.status()).toBe(200)

  const theme: MockTheme = { id: 'gate', name: 'Gate', source: 'imported', manifest: {}, css: '' }
  await mockThemes(page, [theme], { active: 'gate', mode: 'light' })
  // The page's timers are ours: a resting pet sleeps after about 25 seconds, which changes its file inside the page.
  await page.clock.install()
  await page.goto('/team')
  await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
  const card = page.locator('.team-agent-card', { hasText: helper })
  const idle = card.locator('img[data-anim="idle"]')
  const sleep = card.locator('img[data-anim="sleep"]')
  await expect(idle).toHaveClass(/pet-avatar__anim--on/)
  const opacity = (image: typeof idle) => image.evaluate((el) => getComputedStyle(el).opacity)
  await expect.poll(() => opacity(idle)).toBe('1')
  await page.clock.fastForward(26_000)
  await expect(sleep).toHaveClass(/pet-avatar__anim--on/)
  await expect(idle).not.toHaveClass(/pet-avatar__anim--on/)
  // Only the current file is visible: the cached one has faded out, not been pinned on top.
  await expect.poll(() => opacity(idle)).toBe('0')
  await expect.poll(() => opacity(sleep)).toBe('1')
  // Centred by Score's own transform, not flattened to none.
  for (const image of [idle, sleep])
    expect(await image.evaluate((el) => getComputedStyle(el).transform)).not.toBe('none')
})

test('a pet under a custom theme still hops when it needs you (no needs file: idle with the "!" overlay)', async ({
  page,
}, testInfo) => {
  const helper = helperName(testInfo)
  await addHelper(page, helper).then(createAndOpen)
  const files = packFiles(['idle'])
  await page.request.put(`/api/agents/${helper}/pack`, {
    headers: web,
    multipart: { idle: { name: 'idle.png', mimeType: 'image/png', buffer: files[0]!.buffer } },
  })
  const theme: MockTheme = { id: 'gate', name: 'Gate', source: 'imported', manifest: {}, css: '' }
  await mockThemes(page, [theme], { active: 'gate', mode: 'light' })
  await page.route('**/api/agents', async (route) => {
    const body = await (await route.fetch()).json()
    for (const item of body.items)
      if (item.id === helper) Object.assign(item, { status: 'waiting', activity: 'Needs you' })
    await route.fulfill({ json: body })
  })
  await page.goto('/team')
  await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
  const card = page.locator('.team-agent-card', { hasText: helper })
  const stage = card.locator('.pet-avatar__stage--hop')
  await expect(stage).toHaveCount(1)
  await expect(card.locator('.pet-avatar__alert')).toBeVisible()
  // Its transform really moves (pinned to none, the hop would never show).
  const seen = new Set<string>()
  for (let i = 0; i < 20; i += 1) {
    seen.add(await stage.evaluate((el) => getComputedStyle(el).transform))
    await page.waitForTimeout(80)
  }
  expect(seen.size).toBeGreaterThan(1)
})
