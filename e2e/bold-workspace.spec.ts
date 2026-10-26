import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { composerOf, makeRoom, openBoldRoomById, streamOf } from './bold-chat-helpers.ts'
import { pair } from './pair.ts'

// 3.0.0: the classic workspace spec on the new shell's agent page (More › Workspace › Browse all files). The fake adapter
// gives each agent a small temp-dir workspace. `lead` stays untouched; `reviewer` is edited; `designer` has a remote
// terminal backend.
test.describe.configure({ mode: 'serial' })
test.use({ reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } })

async function openWorkspace(page: Page, agent: string) {
  await page.goto(`/b/team/${agent}`)
  await page.getByRole('button', { name: /^More:/ }).click()
  await page.getByRole('button', { name: 'Browse all files' }).click()
  const panel = page.locator('#agent-files')
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

  // Saved for real: opening it again reads it back from disk.
  const again = await openWorkspace(page, 'reviewer')
  await again.getByRole('treeitem', { name: /README\.md/ }).click()
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
  await again.getByRole('button', { name: 'Save' }).click()
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
  await page.goto('/b/team/designer')
  await page.getByRole('button', { name: /^More:/ }).click()
  await expect(page.locator('#agent-workspace').getByRole('status')).toContainText(
    'remote terminal (docker)',
  )
  await expect(page.getByRole('button', { name: 'Browse all files' })).toHaveCount(0)
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
    await expect(panel).toHaveScreenshot(`bold-workspace-${width}.png`, {
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
  await replaceText(page, 'Contents of README.md', '# Preview heading\n\nsome **bold** text\n')
  await panel.getByRole('button', { name: 'Preview' }).click()
  await expect(
    panel.getByLabel('Preview of README.md').getByRole('heading', { name: 'Preview heading' }),
  ).toBeVisible()
  await panel.getByRole('button', { name: 'Edit' }).click()
  await expect(panel.getByLabel('Contents of README.md')).toBeVisible()
})

test('the header shows the git branch and the changed-file count for a repository (read-only status)', async ({
  page,
}) => {
  const info = await (await page.request.get('/api/agents/reviewer/workspace')).json()
  const root = info.root as string
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-C', root, '-c', 'user.email=e2e@example.com', '-c', 'user.name=E2E', ...args],
      { stdio: 'pipe' },
    )
  git('init', '-q')
  // The fake workspace already has a stub .git/HEAD, which init keeps; name the branch explicitly.
  git('symbolic-ref', 'HEAD', 'refs/heads/e2e-branch')
  git('add', 'README.md')
  git('commit', '-q', '-m', 'first')
  fs.writeFileSync(path.join(root, 'untracked.txt'), 'x')
  const panel = await openWorkspace(page, 'reviewer')
  const badge = panel.getByLabel(/^Git branch e2e-branch, \d+ changed files?$/)
  await expect(badge).toBeVisible()
  await expect(badge).toContainText('e2e-branch')
  // A folder that is no repository shows no badge.
  const lead = await openWorkspace(page, 'lead')
  await expect(lead.getByLabel(/^Git branch/)).toHaveCount(0)
})

test("a workspace:// link in chat opens the file in the agent's Files panel", async ({ page }) => {
  test.setTimeout(90_000)
  const room = await makeRoom(page, 'wsl', ['lead', 'reviewer'])
  await openBoldRoomById(page, room.id)
  const box = composerOf(page)
  await box.fill('open [the readme](workspace://reviewer/README.md) please')
  await box.press('Enter')
  await streamOf(page).getByRole('link', { name: 'the readme' }).click()
  await expect(page).toHaveURL(/\/b\/team\/reviewer\?path=README\.md/)
  await expect(page.getByLabel('Contents of README.md')).toBeVisible({ timeout: 15_000 })
  // A blocked path shows the normal error.
  await page.goto('/team/reviewer/workspace?path=.env')
  await expect(page.locator('#agent-files').getByRole('alert').first()).toBeVisible({
    timeout: 15_000,
  })
})

test('the file list can be resized by keyboard and by dragging, and the width is kept', async ({
  page,
}) => {
  await openWorkspace(page, 'reviewer')
  const bar = page.getByRole('separator', { name: 'Resize the file list' })
  const tree = page.locator('.ws-tree-pane')
  const before = (await tree.boundingBox())!.width
  await bar.focus()
  await page.keyboard.press('ArrowRight')
  await expect(bar).toHaveAttribute('aria-valuenow', '316')
  const box = (await bar.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + 40)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + 40, { steps: 6 })
  await page.mouse.up()
  const after = (await tree.boundingBox())!.width
  expect(after).toBeGreaterThan(before + 80)
  const value = Number(await bar.getAttribute('aria-valuenow'))
  await openWorkspace(page, 'reviewer')
  await expect(page.getByRole('separator', { name: 'Resize the file list' })).toHaveAttribute(
    'aria-valuenow',
    String(value),
  )
})

test("the agent page shows the agent's To do card", async ({ page }) => {
  await page.goto('/b/team/reviewer')
  await page.getByRole('button', { name: /^More:/ }).click()
  const card = page.locator('#agent-todo')
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card.getByText('Pick the accent colours')).toBeVisible()
  await expect(card.getByText('In progress')).toBeVisible()
})
