import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'

// 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

test('the composer attaches an image, rejects a non-image, and the sent message shows the image', async ({
  page,
}) => {
  await pair(page)
  await page.goto('/chat')
  await page
    .getByRole('navigation', { name: 'Conversations' })
    .getByRole('link', { name: /#activity-feed/ })
    .click({ timeout: 15_000 })
  const history = page.getByRole('region', { name: 'Message history' })
  await expect(history.getByRole('article').first()).toBeVisible({ timeout: 15_000 })
  const composer = page.getByRole('combobox', { name: /^Message/ })
  const attach = page.getByRole('button', { name: 'Attach files' })
  await expect(attach).toBeEnabled()

  await page.getByTestId('attach-input').setInputFiles({
    name: 'notes.png',
    mimeType: 'image/png',
    buffer: Buffer.from('<html><script>alert(1)</script></html>'),
  })
  await expect(page.getByRole('alert')).toContainText(
    'notes.png is not a PNG, JPEG, WebP or GIF image',
  )

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
})
