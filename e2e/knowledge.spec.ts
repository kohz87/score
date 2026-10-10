import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'

// Needs the Knowledge server (task 6.2): fake mode serves a temp vault. Each test uses its own unique note names,
// so the specs can run in parallel and in any order.
test.beforeEach(async ({ page }) => {
  await pair(page)
})

const unique = () => `e2e-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const editor = (page: Page, path: string) => page.getByLabel(`Contents of ${path}`)

async function createNote(page: Page, name: string, text: string) {
  await page.goto('/knowledge')
  // The button, not Ctrl+N: the shortcut is registered only once the lazily loaded page has mounted.
  await page.getByRole('button', { name: 'New note' }).click({ timeout: 15_000 })
  const dialog = page.getByRole('dialog', { name: 'New note' })
  await dialog.getByLabel('Path in the vault').fill(name)
  await dialog.getByRole('button', { name: 'Create note' }).click()
  const path = `${name}.md`
  await expect(page).toHaveURL(
    new RegExp(`/knowledge/${encodeURIComponent(path).replace(/\./g, '\\.')}$`),
  )
  // Notes open rendered; the choice of Edit is remembered for the rest of the test.
  await page.getByRole('button', { name: 'Edit' }).click()
  await editor(page, path).click()
  await page.keyboard.press('Control+a')
  await page.keyboard.insertText(text)
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  return path
}

test('create a note, link another note, and see the backlink', async ({ page }) => {
  const target = unique()
  const source = unique()
  await createNote(page, target, `# ${target}\n\nThe target.\n`)
  const sourcePath = await createNote(
    page,
    source,
    `# ${source}\n\nSee [[${target}]] and [[${target}-ghost]].\n`,
  )

  // Preview: the existing link navigates, the missing one offers Create.
  await page.getByRole('button', { name: 'Preview' }).click()
  const preview = page.getByLabel('Preview')
  await expect(preview.getByRole('button', { name: /Create/ })).toBeVisible()
  await preview.getByRole('link', { name: target, exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/knowledge/${target}\\.md$`))

  // The backlinks panel on the target lists the source.
  const side = page.getByRole('complementary', { name: 'Note details' })
  await expect(side.getByRole('link', { name: source })).toBeVisible()
  await side.getByRole('link', { name: source }).click()
  await expect(page).toHaveURL(new RegExp(`/knowledge/${sourcePath.replace('.', '\\.')}$`))
})

test('Ctrl+K searches the vault and opens a hit', async ({ page }) => {
  const name = unique()
  const word = `zebrafinch${name.replace(/\W/g, '')}`
  const path = await createNote(page, name, `# ${name}\n\n${word} sings.\n`)
  await page.goto('/knowledge')
  // The shortcut is registered once the lazily loaded page has mounted: wait for its search box.
  await expect(page.getByRole('searchbox', { name: 'Search notes' })).toBeVisible()
  await page.keyboard.press('Control+k')
  await expect(page.getByRole('searchbox', { name: 'Search notes' })).toBeFocused()
  await page.keyboard.type(word)
  const results = page.getByRole('region', { name: 'Search results' })
  await results.getByRole('link', { name }).click()
  await expect(editor(page, path)).toBeVisible()
})

test('history: restore an earlier version', async ({ page }) => {
  const name = unique()
  const other = unique()
  const path = await createNote(page, name, `# ${name}\n\nfirst version\n`)
  // A commit for another note in between keeps the next edit from amending the first commit.
  await createNote(page, other, `# ${other}\n`)
  await page.goto(`/knowledge/${path}`)
  await editor(page, path).click()
  await page.keyboard.press('Control+a')
  await page.keyboard.insertText(`# ${name}\n\nsecond version\n`)
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  // How many commits the note has depends on whether Score amended its last commit (only when no other commit, from a
  // parallel spec sharing the vault, landed in between), so the test never counts them: it waits until the newest
  // commit holds the second version, and the one right below it holds the first.
  type Item = { commit: string }
  let items: Item[] = []
  await expect
    .poll(async () => {
      items = (
        (await (await page.request.get(`/api/knowledge/notes/${path}/history`)).json()) as {
          items: Item[]
        }
      ).items
      if (items.length < 2) return false
      const newest = await page.request.get(
        `/api/knowledge/notes/${path}/versions/${items[0]!.commit}`,
      )
      return ((await newest.json()) as { body: string }).body.includes('second version')
    })
    .toBe(true)
  const history = page.getByRole('heading', { name: 'History' }).locator('..')
  await expect(history.getByRole('listitem')).toHaveCount(items.length)
  await history.getByRole('listitem').nth(1).getByRole('button').click()
  await expect(history.getByText('first version')).toBeVisible()
  await history.getByRole('button', { name: 'Restore this version' }).click()
  await expect(editor(page, path)).toContainText('first version')
})

test('a change behind the editor shows the conflict banner; Reload takes theirs', async ({
  page,
}) => {
  const name = unique()
  const path = await createNote(page, name, `# ${name}\n\nmine\n`)
  const url = `/api/knowledge/notes/${path}`
  const current = (await (await page.request.get(url)).json()) as { etag: string }
  const put = await page.request.put(url, {
    headers: { 'X-Score-Client': 'web' },
    data: { body: `# ${name}\n\ntheirs\n`, etag: current.etag },
  })
  expect(put.ok()).toBe(true)
  await editor(page, path).click()
  await page.keyboard.press('End')
  await page.keyboard.insertText(' more')
  const banner = page.getByTestId('conflict')
  await expect(banner).toBeVisible({ timeout: 10_000 })
  await banner.getByRole('button', { name: 'Reload' }).click()
  await expect(editor(page, path)).toContainText('theirs')
})

test('a table renders in Preview and in the live editor; clicking it edits the source and saves', async ({
  page,
}) => {
  const name = unique()
  const path = await createNote(
    page,
    name,
    `# ${name}\n\n| Item | Qty |\n| --- | ---: |\n| Apples | 3 |\n\n- [ ] buy apples\n\nEnd\n`,
  )
  await page.getByRole('button', { name: 'Preview' }).click()
  const preview = page.getByLabel('Preview')
  await expect(preview.getByRole('columnheader', { name: 'Qty' })).toBeVisible()
  await expect(preview.getByRole('cell', { name: 'Apples' })).toBeVisible()

  await page.getByRole('button', { name: 'Edit' }).click()
  const table = editor(page, path).locator('.cm-lp-table table')
  await expect(table.getByRole('cell', { name: 'Apples' })).toBeVisible()
  // The task checkbox is a named button that edits the source.
  await editor(page, path).getByRole('checkbox', { name: 'Task: buy apples' }).click()
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  // Clicking the table swaps it for its source.
  await table.getByRole('cell', { name: 'Apples' }).click()
  await expect(editor(page, path).locator('.cm-lp-table')).toHaveCount(0)
  await expect(editor(page, path)).toContainText('| Apples | 3 |')
  await page.keyboard.press('End')
  await page.keyboard.insertText(' ')
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  const saved = (await (await page.request.get(`/api/knowledge/notes/${path}`)).json()) as {
    body: string
  }
  expect(saved.body).toContain('- [x] buy apples')
  expect(saved.body).toContain('| Apples | 3 |')
})

test('Split shows editor and rendered note side by side on a wide screen', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const name = unique()
  const path = await createNote(page, name, `# ${name}\n\nhello\n`)
  await page.getByRole('button', { name: 'Split' }).click()
  await expect(editor(page, path)).toBeVisible()
  await expect(page.getByLabel('Preview')).toContainText('hello')
  await editor(page, path).click()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText('typed words')
  await expect(page.getByLabel('Preview')).toContainText('typed words')
})
