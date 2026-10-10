import { crc32 } from 'node:zlib'
import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'

// Knowledge files (PLAN 6.6) against the fake adapter's temp vault: upload a PDF and a note into a folder, find the
// PDF by its text, unzip a zip, and save a chat attachment into Knowledge. Names are unique per test.
test.beforeEach(async ({ page }) => {
  await pair(page)
})

const unique = () => `e2e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** A one-page PDF with real structure so the server's reader can extract `text`. */
function textPdf(text: string): Buffer {
  const stream = `BT /F1 18 Tf 72 700 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, index) => {
    offsets.push(out.length)
    out += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out)
}

/** A stored (uncompressed) zip with real sizes and CRCs. */
function storedZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name)
    const data = Buffer.from(content)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes, data)
    centrals.push(central, nameBytes)
    offset += local.length + nameBytes.length + data.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(centrals.length / 2, 8)
  end.writeUInt16LE(centrals.length / 2, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

test('upload a PDF and a note into a new folder; search finds the PDF text; the page shows it', async ({
  page,
}) => {
  const folder = `docs-${unique()}`
  const word = `heliotrope${unique()}`
  await page.goto('/knowledge?files=')
  await page.getByRole('button', { name: 'New folder' }).click({ timeout: 15_000 })
  const dialog = page.getByRole('dialog', { name: 'New folder' })
  await dialog.getByLabel('Folder path').fill(folder)
  await dialog.getByRole('button', { name: 'Create folder' }).click()
  await expect(page.getByRole('heading', { name: 'Files' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Folder' }).getByText(folder)).toBeVisible()

  await page.getByTestId('kn-upload-input').setInputFiles([
    { name: 'budget.pdf', mimeType: 'application/pdf', buffer: textPdf(`Budget ${word} review`) },
    { name: 'readme.md', mimeType: 'text/markdown', buffer: Buffer.from('# Readme\n\nhello\n') },
  ])
  await expect(page.getByText(`Added 2 files`)).toBeVisible({ timeout: 30_000 })
  const table = page.getByRole('region', { name: 'Files in this folder' })
  await expect(table.getByRole('link', { name: 'budget.pdf', exact: true })).toBeVisible()
  await expect(table.getByRole('link', { name: 'readme', exact: true })).toBeVisible()

  // Search finds the PDF by its text, with a type badge.
  await page.getByPlaceholder(/Search notes/).fill(word)
  const hit = page.getByRole('region', { name: 'Search results' }).getByRole('link').first()
  await expect(hit).toContainText('PDF', { timeout: 15_000 })
  await hit.click()
  await expect(page).toHaveURL(new RegExp(`/knowledge/${folder}/budget\\.pdf$`))
  await expect(page.locator('.kn-doc-text')).toContainText(word)

  // The file downloads as an attachment, never rendered from Score's origin.
  const response = await page.request.get(`/api/knowledge/files/${folder}/budget.pdf?download=1`)
  expect(response.headers()['content-disposition']).toMatch(/^attachment/)
  expect(response.headers()['content-security-policy']).toContain('sandbox')

  // Uploading the same name asks; Keep both adds a suffix.
  await page.goto(`/knowledge?files=${folder}`)
  await page.getByTestId('kn-upload-input').setInputFiles({
    name: 'budget.pdf',
    mimeType: 'application/pdf',
    buffer: textPdf('Budget again'),
  })
  const clash = page.getByRole('dialog', { name: /already exists/ })
  await expect(clash).toBeVisible()
  await clash.getByRole('button', { name: 'Keep both' }).click()
  await expect(page.getByRole('link', { name: 'budget (2).pdf', exact: true })).toBeVisible({
    timeout: 30_000,
  })
})

test('a zip asks: unzip into a folder', async ({ page }) => {
  const name = unique()
  await page.goto('/knowledge?files=')
  await page.getByRole('button', { name: 'Upload files' }).waitFor({ timeout: 15_000 })
  await page.getByTestId('kn-upload-input').setInputFiles({
    name: `${name}.zip`,
    mimeType: 'application/zip',
    buffer: storedZip({
      'one.md': `# One ${name}`,
      'sub/data.csv': 'a,b\n1,2\n',
      'tool.exe': 'MZ',
      '../escape.md': 'nope',
    }),
  })
  const dialog = page.getByRole('dialog', { name: new RegExp(`Zip file: ${name}\\.zip`) })
  await expect(dialog).toBeVisible({ timeout: 15_000 })
  await expect(dialog.getByText('2 files will be added; 2 will be skipped.')).toBeVisible()
  await dialog.getByRole('button', { name: 'Unzip' }).click()
  await expect(page.getByText(new RegExp(`Unzipped 2 files into ${name}`))).toBeVisible({
    timeout: 30_000,
  })
  await page.goto(`/knowledge?files=${name}`)
  const table = page.getByRole('region', { name: 'Files in this folder' })
  await expect(table.getByRole('link', { name: 'one', exact: true })).toBeVisible()
  await table.getByRole('button', { name: /sub/ }).click()
  await expect(page.getByRole('link', { name: 'data.csv', exact: true })).toBeVisible()
  // Nothing escaped the folder.
  const escaped = await page.request.get('/api/knowledge/notes/escape.md')
  expect(escaped.status()).toBe(404)
})

test('a chat attachment can also be saved to Knowledge', async ({ page }) => {
  const file = `chat-${unique()}.pdf`
  await page.goto('/chat')
  await page
    .getByRole('navigation', { name: 'Conversations' })
    .getByRole('link', { name: /#activity-feed/ })
    .click({ timeout: 15_000 })
  const history = page.getByRole('region', { name: 'Message history' })
  await expect(history.getByRole('article').first()).toBeVisible({ timeout: 15_000 })
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
  const composer = page.getByRole('combobox', { name: /^Message/ })
  await composer.fill(`Keep this ${Date.now()}`)
  await composer.press('Enter')
  await expect(page.getByText(new RegExp(`Added inbox/${file}`))).toBeVisible({ timeout: 30_000 })

  await page.goto(`/knowledge/inbox/${file}`)
  await expect(page.locator('.kn-doc-text')).toContainText('From the chat', { timeout: 15_000 })
})
