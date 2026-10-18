import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'
import { makeRoom, openRoom } from './rooms.ts'

// 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

test('the composer attaches an image, rejects a non-image, and the sent message shows the image', async ({
  page,
}) => {
  await pair(page)
  // Its own room: the shared #activity-feed is capped at one page and other specs post in it, which could push the
  // agent's reply out of the page this spec is watching.
  const room = await makeRoom(page, 'att')
  await openRoom(page, room.label)
  const history = page.getByRole('region', { name: 'Message history' })
  const composer = page.getByRole('combobox', { name: /^Message/ })
  const attach = page.getByRole('button', { name: 'Attach files' })
  await expect(attach).toBeEnabled()

  await page.getByTestId('attach-input').setInputFiles({
    name: 'notes.png',
    mimeType: 'image/png',
    buffer: Buffer.from('<html><script>alert(1)</script></html>'),
  })
  await expect(page.getByRole('alert')).toContainText('notes.png isn’t a type that can be attached')

  await page
    .getByTestId('attach-input')
    .setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: PNG })
  const chips = page.getByRole('list', { name: 'Attachments' })
  await expect(chips.getByText('dot.png')).toBeVisible()
  const text = `See the attached picture ${Date.now()}`
  await composer.fill(text)
  await composer.press('Enter')
  await expect(composer).toHaveValue('')
  await expect(chips).toHaveCount(0)
  const mine = history.getByRole('article').filter({ hasText: text })
  const image = mine.getByRole('img', { name: 'Attached image' })
  await expect(image).toBeVisible()
  await expect
    .poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth))
    .toBe(1)
  // The attachment reaches the addressed agent (the fake adapter reports how many images it received).
  await expect(history.getByText('I can see 1 image.')).toBeVisible({ timeout: 20_000 })
})
