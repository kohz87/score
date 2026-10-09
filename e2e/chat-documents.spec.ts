import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'

// Documents in Chat (PLAN 5.30), against the fake adapter: attach a PDF and a CSV, preview, and see what the agent got.
const PDF = Buffer.from('%PDF-1.7\n% e2e document\n%%EOF\n')

test('a PDF and a CSV attach, preview, and reach the agent; a workspace file attaches by reference', async ({
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

  await page.getByTestId('attach-input').setInputFiles([
    { name: 'report.pdf', mimeType: 'application/pdf', buffer: PDF },
    { name: 'data.csv', mimeType: 'text/csv', buffer: Buffer.from('name,qty\nbolt,4\nnut,9\n') },
  ])
  const chips = page.getByRole('list', { name: 'Attachments' })
  await expect(chips.getByText('report.pdf')).toBeVisible()
  await expect(chips.getByText('data.csv')).toBeVisible()

  // A workspace file joins by reference, with no upload.
  await page.getByRole('button', { name: 'Attach files' }).click()
  await page.getByRole('button', { name: 'From workspace…' }).click()
  const picker = page.getByRole('dialog', { name: 'Attach from workspace' })
  await picker.getByRole('treeitem', { name: /README\.md/ }).click()
  await picker.getByRole('button', { name: 'Attach' }).click()
  await expect(chips.getByText('README.md')).toBeVisible()

  const text = `Please read these ${Date.now()}`
  await composer.fill(text)
  await composer.press('Enter')
  await expect(chips).toHaveCount(0)
  const mine = history.getByRole('article').filter({ hasText: text })

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

  // The workspace reference links into the Workspace tab.
  await expect(mine.getByRole('link', { name: 'Open README.md in the workspace' })).toBeVisible()

  // What the agent received: the PDF saved into its workspace, the CSV inline, the workspace file by path.
  const reply = history.getByText(/I received:/)
  await expect(reply).toBeVisible({ timeout: 20_000 })
  await expect(reply).toContainText(/attachments\/\d{4}-\d{2}-\d{2}\/report\.pdf/)
  await expect(reply).toContainText('data.csv')
  await expect(reply).toContainText('README.md')

  // The demo workspace is shared by every spec in the run: leave it as it was (the Workspace screenshot shows it).
  const removed = await page.request.delete(
    '/api/agents/lead/workspace/entries?path=attachments&recursive=1',
    {
      headers: { 'X-Score-Client': 'web' },
    },
  )
  expect(removed.ok()).toBe(true)
})
