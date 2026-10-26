import { expect, test } from '@playwright/test'
import {
  composerOf,
  makeRoom,
  messageWith,
  openBoldRoomById,
  streamOf,
} from './bold-chat-helpers.ts'
import { textPdf } from './knowledge-fixtures.ts'
import { pair } from './pair.ts'

// 3.0.0: the classic chat-attach, chat-documents and knowledge-files "chat attachment" specs on the new shell's team
// room, against the real fake server.
test.use({ reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } })

test.beforeEach(async ({ page }) => {
  await pair(page)
})

// 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)
const PDF = Buffer.from('%PDF-1.7\n% e2e document\n%%EOF\n')
const unique = () => `e2e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

test('the composer attaches an image, rejects a non-image, and the sent message shows the image', async ({
  page,
}) => {
  const room = await makeRoom(page, 'att')
  await openBoldRoomById(page, room.id)
  const composer = composerOf(page)
  await expect(page.getByRole('button', { name: 'Attach, voice and commands' })).toBeEnabled()

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
  // The composer clears once the upload and the send have gone through, which takes a while on a busy server.
  await expect(composer).toHaveValue('', { timeout: 20_000 })
  await expect(chips).toHaveCount(0)
  const image = messageWith(page, text).getByRole('img', { name: 'Attached image' })
  await expect(image).toBeVisible()
  await expect
    .poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth))
    .toBe(1)
  // The attachment reaches the addressed agent (the fake adapter reports how many images it received).
  await expect(streamOf(page).getByText('I can see 1 image.')).toBeVisible({ timeout: 20_000 })
})

test('a PDF and a CSV attach, preview, and reach the agent; a workspace file attaches by reference', async ({
  page,
}) => {
  // Led by builder: attachments are saved into the lead's workspace.
  const room = await makeRoom(page, 'docs', ['builder'], 'builder')
  await openBoldRoomById(page, room.id)
  const composer = composerOf(page)

  await page.getByTestId('attach-input').setInputFiles([
    { name: 'report.pdf', mimeType: 'application/pdf', buffer: PDF },
    { name: 'data.csv', mimeType: 'text/csv', buffer: Buffer.from('name,qty\nbolt,4\nnut,9\n') },
  ])
  const chips = page.getByRole('list', { name: 'Attachments' })
  await expect(chips.getByText('report.pdf')).toBeVisible()
  await expect(chips.getByText('data.csv')).toBeVisible()

  // A workspace file joins by reference, with no upload.
  await page.getByRole('button', { name: 'Attach, voice and commands' }).click()
  await page.getByRole('button', { name: 'From workspace…' }).click()
  const picker = page.getByRole('dialog', { name: 'Attach from workspace' })
  await picker.getByRole('treeitem', { name: /README\.md/ }).click()
  await picker.getByRole('button', { name: 'Attach' }).click()
  await expect(chips.getByText('README.md')).toBeVisible()

  const text = `Please read these ${Date.now()}`
  await composer.fill(text)
  await composer.press('Enter')
  await expect(chips).toHaveCount(0)
  const mine = messageWith(page, text)

  // The PDF is a download, never rendered from Score's origin.
  const pdf = mine.getByRole('link', { name: 'Download report.pdf' })
  const response = await page.request.get((await pdf.getAttribute('href'))!)
  expect(response.headers()['content-type']).toBe('application/octet-stream')
  expect(response.headers()['content-disposition']).toMatch(/^attachment/)
  expect(response.headers()['x-content-type-options']).toBe('nosniff')
  expect(response.headers()['content-security-policy']).toContain('sandbox')

  // The CSV previews as a table.
  await mine.getByRole('button', { name: 'Preview data.csv' }).click()
  const dialog = page.getByRole('dialog', { name: 'data.csv' })
  await expect(dialog.getByRole('cell', { name: 'bolt' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Close' }).click()

  // The workspace reference links to the file.
  await expect(mine.getByRole('link', { name: 'Open README.md in the workspace' })).toBeVisible()

  // What the agent received: the PDF saved into its workspace, the CSV inline, the workspace file by path.
  const reply = streamOf(page).getByText(/I received:/)
  await expect(reply).toBeVisible({ timeout: 20_000 })
  await expect(reply).toContainText(/attachments\/\d{4}-\d{2}-\d{2}\/report\.pdf/)
  await expect(reply).toContainText('data.csv')
  await expect(reply).toContainText('README.md')

  // The demo workspace is shared by every spec in the run: leave it as it was.
  const removed = await page.request.delete(
    '/api/agents/builder/workspace/entries?path=attachments&recursive=1',
    { headers: { 'X-Score-Client': 'web' } },
  )
  expect(removed.ok()).toBe(true)
})

test('a chat attachment can also be saved to Knowledge', async ({ page }) => {
  const file = `chat-${unique()}.pdf`
  const room = await makeRoom(page, 'kn', ['builder'], 'builder')
  await openBoldRoomById(page, room.id)
  await page
    .getByTestId('attach-input')
    .setInputFiles({ name: file, mimeType: 'application/pdf', buffer: textPdf('From the chat') })
  const chips = page.getByRole('list', { name: 'Attachments' })
  await expect(chips.getByText(file)).toBeVisible()
  const option = chips.getByRole('checkbox', { name: `Also save ${file} to Knowledge` })
  await expect(option).not.toBeChecked()
  await option.check()
  await expect(chips.getByRole('combobox', { name: `Knowledge folder for ${file}` })).toHaveValue(
    'inbox',
  )
  await composerOf(page).fill(`Keep this ${Date.now()}`)
  await composerOf(page).press('Enter')
  await expect(page.getByText(new RegExp(`Added inbox/${file}`))).toBeVisible({ timeout: 30_000 })

  // The old /knowledge/<path> link lands in the Library with the document open.
  await page.goto(`/b?note=${encodeURIComponent(`inbox/${file}`)}`)
  await expect(page.locator('.kn-doc-text')).toContainText('From the chat', { timeout: 15_000 })
})
