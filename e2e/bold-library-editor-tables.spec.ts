import { expect, test, type Locator } from '@playwright/test'
import {
  createNote,
  editor,
  noPageOverflow,
  noteBody,
  openLibrary,
  setupLibraryEditor,
  sizes,
  unique,
} from './bold-library-editor-helpers.ts'

setupLibraryEditor()

for (const size of sizes) {
  test.describe(`note editing at ${size.name}`, () => {
    test('a table stays a grid while editing: click a cell, type, Enter; the Markdown stays canonical', async ({
      page,
    }) => {
      await openLibrary(page, size)
      const name = unique()
      const path = await createNote(
        page,
        name,
        `# ${name}\n\n| Item | Qty |\n| --- | ---: |\n| Apples | 3 |\n\n- [ ] buy apples\n\nEnd\n`,
      )
      const table = editor(page, path).locator('.cm-lp-table table')
      await expect(table.getByRole('columnheader', { name: 'Qty' })).toBeVisible()
      await expect(table.getByRole('cell', { name: 'Apples' })).toBeVisible()
      // The task checkbox is a named button that edits the source.
      await editor(page, path).getByRole('checkbox', { name: 'Task: buy apples' }).click()
      await expect(page.getByText('Saved', { exact: true })).toBeVisible()
      // Clicking a cell opens an input in it; the grid never turns into raw pipes.
      await table.getByRole('cell', { name: 'Apples' }).click()
      const field = table.getByRole('textbox', { name: 'Item, row 1' })
      await expect(field).toBeFocused()
      await expect(editor(page, path).locator('.cm-lp-table')).toHaveCount(1)
      await expect(editor(page, path)).not.toContainText('| Apples |')
      // With the caret in the table, its tools show in the toolbar.
      await expect(page.getByRole('toolbar', { name: 'Table' })).toBeVisible()
      await field.fill('**Pears** | ripe')
      await page.keyboard.press('Enter')
      await expect(table.getByRole('cell', { name: 'Pears | ripe' })).toBeVisible()
      await expect(table.locator('td strong')).toHaveText('Pears')
      await expect(page.getByText('Saved', { exact: true })).toBeVisible()
      const saved = await noteBody(page, path)
      expect(saved).toContain('- [x] buy apples')
      expect(saved).toContain('| **Pears** \\| ripe | 3 |')
      expect(saved).toContain('| --- | ---: |')
      // Source mode is where the raw Markdown shows.
      await page.getByRole('button', { name: 'Source' }).click()
      await expect(editor(page, path)).toContainText('| **Pears** \\| ripe | 3 |')
      await expect(editor(page, path).locator('.cm-lp-table')).toHaveCount(0)
      await expect(page.locator('.cm-editor.cm-source')).toBeVisible()
      if (size.width < 500) await noPageOverflow(page)
    })

    test('a column is dragged wider and stays so after a reload; cells dragged across are copied (3.8.3)', async ({
      page,
      context,
    }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'])
      await openLibrary(page, size)
      const name = unique()
      const path = await createNote(
        page,
        name,
        `# ${name}\n\n| Item | Qty |\n| --- | --- |\n| Apples | 3 |\n| Pears | **4** |\n`,
      )
      const table = editor(page, path).locator('.cm-lp-table table')
      const first = table.getByRole('columnheader', { name: 'Item' })
      const before = (await first.boundingBox())!.width
      const handle = first.locator('.cm-lp-col-resize')
      const grip = (await handle.boundingBox())!
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
      await page.mouse.down()
      await page.mouse.move(grip.x + grip.width / 2 + 120, grip.y + grip.height / 2, { steps: 6 })
      await page.mouse.up()
      await expect.poll(async () => (await first.boundingBox())!.width).toBeGreaterThan(before + 80)
      // The note itself is unchanged: widths live on this device.
      expect(await noteBody(page, path)).toContain('| Item | Qty |')
      await page.reload()
      await openLibrary(page, size)
      await page
        .getByRole('navigation', { name: 'Library notes' })
        .getByRole('button', { name: new RegExp(`^${name}`) })
        .click()
      const again = editor(page, path).locator('.cm-lp-table table')
      await expect
        .poll(
          async () =>
            (await again.getByRole('columnheader', { name: 'Item' }).boundingBox())!.width,
        )
        .toBeGreaterThan(before + 80)

      // A touch drag scrolls on a phone (a cell's own text is copied from its field there): the range is a mouse thing.
      if (size.width < 500) return
      // Drag from Apples to 4: four cells; Ctrl+C copies what they show.
      const apples = (await again.getByRole('cell', { name: 'Apples' }).boundingBox())!
      await page.mouse.move(apples.x + 10, apples.y + apples.height / 2)
      await page.mouse.down()
      // Pressing a cell starts its edit, which may scroll the editor: measure the target after.
      const four = (await again.locator('td').nth(3).boundingBox())!
      await page.mouse.move(four.x + 10, four.y + four.height / 2, { steps: 6 })
      await page.mouse.up()
      await expect(again.locator('.cm-lp-cell-selected')).toHaveCount(4)
      await page.keyboard.press('Control+c')
      await expect(editor(page, path).getByRole('status')).toHaveText('Copied 4 cells')
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Apples\t3\nPears\t4')
    })

    test('the corner grip widens the whole table and a row grip makes a row taller; both stay after a reload (3.8.4)', async ({
      page,
    }) => {
      await openLibrary(page, size)
      const name = unique()
      const path = await createNote(
        page,
        name,
        `# ${name}\n\n| Item | Qty |\n| --- | --- |\n| Apples | 3 |\n| Pears | 4 |\n`,
      )
      const table = () => editor(page, path).locator('.cm-lp-table table')
      const drag = async (grip: Locator, dx: number, dy: number) => {
        const box = (await grip.boundingBox())!
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await page.mouse.down()
        await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 6 })
        await page.mouse.up()
      }
      const tableWidth = async () => (await table().boundingBox())!.width
      const rowHeight = async () =>
        (await table().locator('tbody tr').first().boundingBox())!.height
      const width = await tableWidth()
      const height = await rowHeight()
      await drag(table().locator('.cm-lp-table-resize'), 90, 0)
      await expect.poll(tableWidth).toBeGreaterThan(width + 60)
      await drag(table().locator('tbody tr').first().locator('.cm-lp-row-resize'), 0, 40)
      await expect.poll(rowHeight).toBeGreaterThan(height + 25)
      expect(await noteBody(page, path)).toContain('| Item | Qty |')
      await page.reload()
      await openLibrary(page, size)
      await page
        .getByRole('navigation', { name: 'Library notes' })
        .getByRole('button', { name: new RegExp(`^${name}`) })
        .click()
      await expect.poll(tableWidth).toBeGreaterThan(width + 60)
      await expect.poll(rowHeight).toBeGreaterThan(height + 25)
    })

    test('the toolbar formats text, and a table inserted from the size grid survives reopening', async ({
      page,
    }) => {
      await openLibrary(page, size)
      const name = unique()
      const path = await createNote(page, name, 'plain words')
      const area = editor(page, path)
      await area.click()
      await page.keyboard.press('Control+a')
      await page.getByRole('button', { name: 'Bold' }).click()
      await expect(page.getByRole('button', { name: 'Bold' })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      await expect(area.locator('.cm-lp-strong')).toContainText('plain words')
      await page.getByRole('button', { name: 'Heading' }).click()
      await page.getByRole('button', { name: 'Heading 2' }).click()
      await expect(area.locator('.cm-lp-h2')).toBeVisible()
      await page.keyboard.press('Control+End')
      await page.keyboard.press('Enter')
      await page.keyboard.press('Enter')
      await page.getByRole('button', { name: 'Table', exact: true }).click()
      await page.getByRole('button', { name: '4 columns by 3 rows' }).hover()
      await expect(page.getByText('4 × 3')).toBeVisible()
      await page.getByRole('button', { name: '3 columns by 3 rows' }).click()
      // The first header cell is open for typing; Tab goes to the next cell; the table tools act on the cell in focus.
      await expect(page.getByRole('toolbar', { name: 'Table' })).toBeVisible()
      await area.locator('.cm-lp-cell-input').fill('Item')
      await page.keyboard.press('Tab')
      await area.locator('.cm-lp-cell-input').fill('Qty')
      await page.getByRole('button', { name: 'Add row below' }).click()
      await expect(page.getByText('Saved', { exact: true })).toBeVisible()
      const saved = await noteBody(page, path)
      expect(saved).toContain('| Item | Qty | Column 3 |\n| --- | --- | --- |')
      expect(saved.match(/^\|\s{2}\|\s{2}\|\s{2}\|$/gm)).toHaveLength(3)

      // Open it again from scratch: the table is still a grid.
      await openLibrary(page, size)
      await page
        .getByRole('navigation', { name: 'Library notes' })
        .getByRole('button', { name: new RegExp(`^${name}`) })
        .click()
      const table = editor(page, path).locator('.cm-lp-table table')
      await expect(table.getByRole('columnheader', { name: 'Qty' })).toBeVisible()
      await expect(table.locator('tbody tr')).toHaveCount(3)
      if (size.width < 500) await noPageOverflow(page)
    })

    test('the focused editor shows a quiet ring, not the ink of primary actions', async ({
      page,
    }) => {
      await openLibrary(page, size)
      const name = unique()
      const path = await createNote(page, name, `# ${name}\n`)
      await editor(page, path).click()
      const ring = await page.locator('.cm-editor.cm-focused').evaluate((el) => ({
        style: getComputedStyle(el).outlineStyle,
        color: getComputedStyle(el).outlineColor,
      }))
      expect(ring.style).toBe('solid')
      expect(ring.color).not.toBe('rgb(18, 19, 26)')
    })

    test('the toolbar stays in view while a long note scrolls', async ({ page }) => {
      await openLibrary(page, size)
      const name = unique()
      const path = await createNote(
        page,
        name,
        `# ${name}\n\n${Array.from({ length: 80 }, (_, i) => `Paragraph ${i}`).join('\n\n')}\n`,
      )
      await editor(page, path).click()
      await page.keyboard.press('Control+End')
      const toolbar = page.getByRole('toolbar', { name: 'Formatting' })
      await expect(toolbar).toBeInViewport({ ratio: 1 })
      // 3.22.0: the page scrolls on Knowledge; the toolbar sticks near the top of the window, under the top bar.
      const gap = (await toolbar.boundingBox())!.y
      expect(gap).toBeLessThan(160)
    })
  })
}
