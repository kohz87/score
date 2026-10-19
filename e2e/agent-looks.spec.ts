import { expect, test, type Page } from '@playwright/test'
import { acquireLock } from './locks.ts'
import { pair } from './pair.ts'
import { makePng } from './png.ts'

// PLAN 10.2b: choose a look and a shape from the real forms, then give an agent a picture, mark its eyes, and remove it
// again, against the real server (fake Hermes). The pictures are generated here, flat colours, never anyone's art.
const web = { 'x-score-client': 'web' }
const helperName = (info: { repeatEachIndex: number; retry: number }) =>
  info.repeatEachIndex || info.retry
    ? `looks-helper-${info.repeatEachIndex}-${info.retry}`
    : 'looks-helper'

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

/** A face-like picture: a pale square with two dark "eyes" and a skin-coloured cheek band under them. */
const picture = (size = 160) =>
  makePng(size, size, (x, y) => {
    const eye = (cx: number) => Math.hypot(x - cx * size, y - 0.4 * size) < 0.06 * size
    if (eye(0.35) || eye(0.65)) return [30, 30, 40]
    if (y > 0.45 * size && y < 0.6 * size) return [232, 190, 160]
    return [168, 200, 232]
  })

test('look, shape and picture: add an agent as a chibi, change it to a bot with a new shape, add a picture and mark its eyes', async ({
  page,
}, testInfo) => {
  const helper = helperName(testInfo)
  await pair(page)
  await page.goto('/team')
  await page.getByRole('button', { name: 'Add agent', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add agent' })
  await dialog.getByLabel('Agent name').fill(helper)
  await dialog.getByLabel('Role or description').fill('Checks how agents look')
  await dialog.getByLabel('Model', { exact: true }).fill('fake-model')

  // Twenty shapes and two looks, as radio groups; the keyboard moves through a group like any native one.
  const shapes = dialog.getByRole('radiogroup', { name: 'Shape' })
  await expect(shapes.getByRole('radio')).toHaveCount(20)
  await expect(dialog.getByRole('radiogroup', { name: 'Look' }).getByRole('radio')).toHaveCount(2)
  await expect(dialog.getByRole('radio', { name: 'Bot' })).toBeChecked()
  const triangle = dialog.getByRole('radio', { name: 'triangle' })
  await expect(triangle).toBeChecked()
  await triangle.focus()
  await page.keyboard.press('ArrowRight')
  await expect(dialog.getByRole('radio', { name: 'diamond' })).toBeChecked()
  await dialog.getByRole('radio', { name: 'gem' }).check()
  await dialog.getByRole('radio', { name: 'Chibi' }).check()
  await expect(dialog.getByRole('img', { name: `${helper}, gem` })).toHaveClass(
    /agent-glyph--chibi/,
  )

  await dialog.getByRole('button', { name: 'Preview changes' }).click()
  await dialog.getByRole('button', { name: 'Create agent' }).click()
  await expect(dialog.getByRole('heading', { name: / joined the team$/ })).toBeVisible()
  await dialog.getByRole('link', { name: /^Open / }).click()

  // The agent page shows the chosen look; the style button opens the same choices.
  const trigger = page.getByRole('button', { name: /^Change .* look, colour and shape$/ })
  await expect(trigger.locator('.agent-glyph--chibi')).toHaveCount(1)
  await trigger.click()
  const appearance = page.getByRole('dialog', { name: 'Agent appearance' })
  await expect(appearance.getByRole('radio', { name: 'Chibi' })).toBeChecked()
  await expect(appearance.getByRole('radio', { name: 'gem' })).toBeChecked()
  await appearance.getByRole('radio', { name: 'Bot' }).check()
  await appearance.getByRole('radio', { name: 'cloud' }).check()
  await appearance.getByRole('button', { name: 'Save appearance' }).click()
  await expect(appearance).toBeHidden()
  await expect(trigger.locator('.agent-glyph--bot')).toHaveCount(1)
  const saved = await (await page.request.get(`/api/agents/${helper}`)).json()
  expect(saved.style).toMatchObject({ shape: 'cloud', look: 'bot' })

  // A picture: wrong files are refused with reasons, a good one is previewed, then its eyes are marked.
  await trigger.click()
  await appearance.getByLabel('Picture file').setInputFiles({
    name: 'logo.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
  })
  await expect(appearance.getByRole('alert')).toContainText('PNG, JPEG or WebP')
  await appearance.getByLabel('Picture file').setInputFiles({
    name: 'tiny.png',
    mimeType: 'image/png',
    buffer: makePng(20, 20, () => [200, 200, 200]),
  })
  await appearance.getByRole('button', { name: 'Use this picture' }).click()
  // The server's reasons, not a generic message (each side must be 32 to 2048 px).
  await expect(appearance.getByRole('alert')).toContainText(/32/)
  await appearance.getByRole('button', { name: 'Cancel picture' }).click()

  await appearance.getByLabel('Picture file').setInputFiles({
    name: 'face.png',
    mimeType: 'image/png',
    buffer: picture(),
  })
  await expect(appearance.getByAltText('Preview of face.png')).toBeVisible()
  await appearance.getByRole('button', { name: 'Use this picture' }).click()

  const marker = appearance.getByRole('region', { name: 'Mark the eyes' })
  await expect(marker).toBeVisible()
  const left = marker.getByRole('group', { name: 'Left eye' })
  const right = marker.getByRole('group', { name: 'Right eye' })
  await expect(left).toBeVisible()
  await expect(marker.getByAltText('Your picture, to mark its eyes on')).toBeVisible()
  // Put the boxes over the eyes (at 35% / 65% across and 40% down): the keyboard moves them, a drag does the same.
  const image = marker.getByAltText('Your picture, to mark its eyes on')
  await expect.poll(async () => (await image.boundingBox())?.width ?? 0).toBeGreaterThan(100)
  // The popover scrolls: bring the boxes into view before reading where they are.
  await left.scrollIntoViewIfNeeded()
  const box = (await image.boundingBox())!
  const leftBox = (await left.boundingBox())!
  await page.mouse.move(leftBox.x + leftBox.width / 2, leftBox.y + leftBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.4, { steps: 6 })
  await page.mouse.up()
  await right.focus()
  const before = (await right.boundingBox())!
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('Shift+ArrowRight')
  const after = (await right.boundingBox())!
  expect(after.x - before.x).toBeGreaterThan(box.width * 0.1)
  // The preview shows the lids, and the lid colour was sampled from the cheek band under the boxes.
  await expect(marker.getByText(/Eyelid colour/)).toContainText(/#[0-9A-F]{6}/)
  await marker.getByRole('button', { name: 'Blink' }).click()
  await expect(marker.locator('.team-eyes-preview .agent-glyph--asleep')).toHaveCount(1)
  await expect(marker.locator('.team-eyes-preview .agent-glyph--asleep')).toHaveCount(0)
  await marker.getByRole('button', { name: 'Save eyes' }).click()
  await expect(marker).toBeHidden()

  const withEyes = await (await page.request.get(`/api/agents/${helper}`)).json()
  expect(withEyes.style.avatar).toBeTruthy()
  expect(withEyes.style.avatarEyes.lid).toMatch(/^#[0-9A-F]{6}$/i)
  expect(withEyes.style.avatarEyes.left.x).toBeGreaterThan(0.2)

  // The picture replaces the bot on the page, its marked eyes have lids, and the badge keeps colour and shape.
  await page.keyboard.press('Escape')
  await expect(trigger.locator('.agent-glyph--picture')).toHaveCount(1)
  await expect(trigger.locator('.agent-glyph__lid')).toHaveCount(2)
  await expect(trigger.locator('.agent-glyph__badge-shape')).toHaveCount(1)
  const url = await trigger.locator('image').getAttribute('href')
  const served = await page.request.get(url!)
  expect(served.status()).toBe(200)
  expect(served.headers()['content-type']).toBe('image/png')

  // Remove the picture: the look comes back.
  await trigger.click()
  await appearance.getByRole('button', { name: 'Remove picture' }).click()
  await expect(trigger.locator('.agent-glyph--bot')).toHaveCount(1)
  await expect(trigger.locator('image')).toHaveCount(0)
  expect((await page.request.get(url!)).status()).toBe(404)
})
