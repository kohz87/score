import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'

// The fake adapter gives each agent a small temp-dir workspace. `lead` stays untouched (visual baseline);
// `reviewer` is edited; `designer` has a remote terminal backend.
test.describe.configure({ mode: 'serial' })

async function openWorkspace(page: Page, agent: string) {
  await page.goto(`/team/${agent}`)
  await page.getByRole('tab', { name: 'Workspace' }).click()
  const panel = page.getByRole('tabpanel')
  await expect(panel.getByRole('tree', { name: 'Files' })).toBeVisible()
  return panel
}

// The editor is CodeMirror (a contenteditable), so it is typed into rather than filled.
async function replaceText(page: Page, label: string, text: string) {
  const editor = page.getByLabel(label)
  await editor.click()
  await page.keyboard.press('Control+a')
  await page.keyboard.insertText(text)
}

test.beforeEach(async ({ page }) => {
  await pair(page)
})

test('browse: blocked files are hidden, folders open lazily, hidden entries are shown', async ({
  page,
}) => {
  const panel = await openWorkspace(page, 'reviewer')
  const tree = panel.getByRole('tree', { name: 'Files' })
  await expect(tree.getByRole('treeitem', { name: /README\.md/ })).toBeVisible()
  await expect(tree.getByRole('treeitem', { name: /\.gitignore/ })).toBeVisible()
  await expect(tree.getByRole('treeitem', { name: /\.env/ })).toHaveCount(0)
  await expect(tree.getByRole('treeitem', { name: /main/ })).toHaveCount(0)
  await tree.getByRole('treeitem', { name: /src/ }).click()
  await expect(tree.getByRole('treeitem', { name: /index\.ts/ })).toBeVisible()
})

test('edit and save, then a change made behind the page shows the conflict banner', async ({
  page,
}) => {
  const panel = await openWorkspace(page, 'reviewer')
  await panel.getByRole('treeitem', { name: /README\.md/ }).click()
  const editor = panel.getByLabel('Contents of README.md')
  await expect(editor).toContainText('reviewer workspace')
  await replaceText(page, 'Contents of README.md', '# Edited in the e2e\n')
  await panel.getByRole('button', { name: 'Save' }).click()
  await expect(panel.getByText('Saved.')).toBeVisible()

  // Saved for real: a reload reads it back from disk.
  await page.reload()
  await page.getByRole('tab', { name: 'Workspace' }).click()
  await page.getByRole('treeitem', { name: /README\.md/ }).click()
  await expect(page.getByLabel('Contents of README.md')).toContainText('# Edited in the e2e')

  // Something else writes the file (the agent, an editor); the page still holds the old etag.
  const url = '/api/agents/reviewer/workspace/file?path=README.md'
  const current = await page.request.get(url)
  const etag = (current.headers()['etag'] ?? '').replaceAll('"', '')
  const behind = await page.request.put(url, {
    headers: { 'x-score-client': 'web' },
    data: { content: 'written by someone else\n', etag },
  })
  expect(behind.ok()).toBe(true)
  await replaceText(page, 'Contents of README.md', 'my edit\n')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Changed on disk.')).toBeVisible()
  await page.getByRole('button', { name: 'Compare' }).click()
  await expect(page.getByLabel('On disk')).toHaveValue('written by someone else\n')
  await page.getByRole('button', { name: 'Reload from disk' }).click()
  await expect(page.getByLabel('Contents of README.md')).toContainText('written by someone else')
})

test('create a file and a folder, then delete both (a folder with files needs its name typed)', async ({
  page,
}) => {
  const panel = await openWorkspace(page, 'reviewer')
  await panel.getByRole('button', { name: 'New folder' }).click()
  await panel.getByLabel(/New folder in/).fill('scratch')
  await panel.getByRole('button', { name: 'Create' }).click()
  await expect(panel.getByText('Folder created.')).toBeVisible()
  await expect(panel.getByRole('treeitem', { name: /scratch/ })).toBeVisible()

  await panel.getByRole('button', { name: 'New file' }).click()
  await panel.getByLabel(/New file in scratch/).fill('todo.txt')
  await panel.getByRole('button', { name: 'Create' }).click()
  await expect(panel.getByLabel('Contents of scratch/todo.txt')).toBeVisible()
  await replaceText(page, 'Contents of scratch/todo.txt', 'buy milk\n')
  await panel.getByRole('button', { name: 'Save' }).click()
  await expect(panel.getByText('Saved.')).toBeVisible()

  await panel.getByRole('button', { name: 'Delete' }).click()
  await panel.getByRole('button', { name: 'Confirm delete' }).click()
  await expect(panel.getByText('Deleted.')).toBeVisible()

  await panel.getByRole('treeitem', { name: /scratch/ }).click()
  await panel.getByRole('button', { name: 'New file' }).click()
  await panel.getByLabel(/New file in scratch/).fill('keep.txt')
  await panel.getByRole('button', { name: 'Create' }).click()
  await expect(panel.getByLabel('Contents of scratch/keep.txt')).toBeVisible()
  await panel.getByRole('treeitem', { name: /scratch/ }).click()
  await panel.getByRole('button', { name: 'Delete' }).click()
  await panel.getByRole('button', { name: 'Confirm delete' }).click()
  await panel.getByLabel('Type the folder name to confirm').fill('scratch')
  await panel.getByRole('button', { name: 'Delete everything' }).click()
  await expect(panel.getByText('Deleted.')).toBeVisible()
  await expect(panel.getByRole('treeitem', { name: /scratch/ })).toHaveCount(0)
})

test('a remote terminal backend makes the workspace unavailable, with the reason', async ({
  page,
}) => {
  await page.goto('/team/designer')
  await page.getByRole('tab', { name: 'Workspace' }).click()
  await expect(page.getByRole('tabpanel').getByRole('status')).toContainText(
    'remote terminal (docker)',
  )
})

test('looks right at desktop and phone width', async ({ page }) => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    const panel = await openWorkspace(page, 'lead')
    await panel.getByRole('treeitem', { name: /src/ }).click()
    await panel.getByRole('treeitem', { name: /README\.md/ }).click()
    await expect(panel.getByLabel('Contents of README.md')).toContainText('lead workspace')
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(1)
    await page.evaluate(() => document.fonts.ready)
    await expect(panel).toHaveScreenshot(`workspace-${width}.png`, {
      animations: 'disabled',
      mask: [panel.locator('.ws-root code')],
      maxDiffPixelRatio: 0.02,
    })
  }
})

test('a Markdown file previews rendered and switches back to the editor', async ({ page }) => {
  const panel = await openWorkspace(page, 'reviewer')
  await panel.getByRole('treeitem', { name: /README\.md/ }).click()
  await expect(panel.getByLabel('Contents of README.md')).toBeVisible()
  await panel.getByRole('button', { name: 'Preview' }).click()
  await expect(panel.getByLabel('Preview of README.md').getByRole('heading').first()).toBeVisible()
  await panel.getByRole('button', { name: 'Edit' }).click()
  await expect(panel.getByLabel('Contents of README.md')).toBeVisible()
})
