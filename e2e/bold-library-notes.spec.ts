import { expect, test } from '@playwright/test'
import {
  createNote,
  editor,
  noteButton,
  openLibrary,
  setupLibrary,
  sizes,
  unique,
} from './bold-library-helpers.ts'

setupLibrary()

for (const size of sizes) {
  test.describe(size.name, () => {
    test('create notes, follow a link, and see the backlink', async ({ page }) => {
      await openLibrary(page, size)
      const target = unique()
      const source = unique()
      const targetPath = await createNote(page, target, `# ${target}\n\nThe target.\n`)
      const sourcePath = await createNote(
        page,
        source,
        `# ${source}\n\nSee [[${target}]] and [[${target}-ghost]].\n`,
      )

      await expect(editor(page, sourcePath)).toContainText(`${target}-ghost`)
      await expect(
        page
          .getByRole('complementary', { name: 'Note details' })
          .getByRole('button', { name: `Create ${target}-ghost` }),
      ).toBeVisible()
      await editor(page, sourcePath)
        .locator(`.cm-lp-wikilink[data-wikilink="${target}"]`)
        .click({ modifiers: ['Control'] })
      await expect(editor(page, targetPath)).toBeVisible()
      const side = page.getByRole('complementary', { name: 'Note details' })
      await expect(side.getByRole('button', { name: source })).toBeVisible()
      await side.getByRole('button', { name: source }).click()
      await expect(editor(page, sourcePath)).toBeVisible()
    })

    test('history restores an earlier version', async ({ page }) => {
      await openLibrary(page, size)
      const name = unique()
      const other = unique()
      const path = await createNote(page, name, `# ${name}\n\nfirst version\n`)
      await createNote(page, other, `# ${other}\n`)
      await unfold(page)
      await noteButton(page, name).click()
      await editor(page, path).click()
      await page.keyboard.press('Control+a')
      await page.keyboard.insertText(`# ${name}\n\nsecond version\n`)
      await expect(page.getByText('Saved', { exact: true })).toBeVisible()

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

    test('a change behind the editor shows the conflict banner and Reload takes theirs', async ({
      page,
    }) => {
      await openLibrary(page, size)
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

    test('moving a note updates links to it', async ({ page }) => {
      await openLibrary(page, size)
      const target = unique()
      const moved = unique()
      const source = unique()
      const targetPath = await createNote(page, target, `# ${target}\n\nMove me.\n`)
      const sourcePath = await createNote(page, source, `# ${source}\n\nSee [[${target}]].\n`)

      await unfold(page)
      await noteButton(page, target).click()
      await expect(editor(page, targetPath)).toBeVisible()
      await page.getByRole('button', { name: 'Rename or move' }).click()
      const dialog = page.getByRole('dialog', {
        name: new RegExp(`Rename or move ${target}`),
      })
      await dialog.getByLabel('New path').fill(moved)
      await dialog.getByRole('button', { name: 'Move', exact: true }).click()
      await expect(editor(page, `${moved}.md`)).toBeVisible({ timeout: 15_000 })
      await expect(
        page.getByText(new RegExp(`Moved to ${moved}\\.md\\. Updated links in 1 note`)),
      ).toBeVisible()

      const updated = (await (
        await page.request.get(`/api/knowledge/notes/${sourcePath}`)
      ).json()) as {
        body: string
      }
      expect(updated.body).toContain(`[[${moved}]]`)
      expect((await page.request.get(`/api/knowledge/notes/${targetPath}`)).status()).toBe(404)
      await unfold(page)
      await noteButton(page, source).click()
      await expect(
        editor(page, sourcePath).locator(`.cm-lp-wikilink[data-wikilink="${moved}"]`),
      ).toContainText(moved)
    })

    test('deleting the open note shows Pick a note instead of opening another', async ({
      page,
    }) => {
      await openLibrary(page, size)
      const first = unique()
      const second = unique()
      const firstPath = await createNote(page, first, `# ${first}\n\nFirst.\n`)
      await createNote(page, second, `# ${second}\n\nSecond.\n`)

      await unfold(page)
      await noteButton(page, first).click()
      await expect(editor(page, firstPath)).toBeVisible()
      await page.getByRole('button', { name: 'Delete', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: `Delete ${first}?` })
      await dialog.getByRole('button', { name: 'Delete note' }).click()
      // A phone's Knowledge page goes back to the list (its blank state); wider screens say "Pick a note".
      if (size.width < 861) {
        await expect(page.getByRole('navigation', { name: 'Library notes' })).toBeVisible({
          timeout: 15_000,
        })
      } else {
        await expect(page.getByText('Pick a note', { exact: true })).toBeVisible({
          timeout: 15_000,
        })
      }
      await unfold(page)
      await expect(noteButton(page, first)).toHaveCount(0)
      await unfold(page)
      await expect(noteButton(page, second)).toBeVisible()
      expect((await page.request.get(`/api/knowledge/notes/${firstPath}`)).status()).toBe(404)
    })
  })
}
