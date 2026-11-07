import { expect, test } from '@playwright/test'
import {
  createNote,
  editor,
  openLibrary,
  setupLibraryEditor,
  unique,
} from './bold-library-editor-helpers.ts'

setupLibraryEditor()

test('a wide editor gives text and tables its whole width, and a size set on one screen keeps its proportion on another (3.8.5, 3.8.6)', async ({
  page,
}) => {
  await openLibrary(page, { name: 'desktop', width: 2400, height: 1100 })
  await expect(page.getByTestId('bold-library')).toHaveAttribute('data-width', 'wide')
  const name = unique()
  const words = 'word '.repeat(40)
  const path = await createNote(
    page,
    name,
    `# ${name}\n\n${words}\n\n| # | Card | Notes |\n| --- | --- | --- |\n| 1 | Forced | ${words} |\n`,
  )
  const wrap = editor(page, path).locator('.cm-lp-table')
  const line = editor(page, path).locator('.cm-line').filter({ hasText: 'word word' }).first()
  // 3.8.6: text and tables both use the whole editor; nothing stops at a narrower column.
  const content = (await editor(page, path).boundingBox())!
  expect((await line.boundingBox())!.width).toBeGreaterThan(content.width - 40)
  expect((await wrap.boundingBox())!.width).toBeGreaterThan(content.width - 40)
  // "Card" is never split letter by letter.
  const card = wrap.getByRole('columnheader', { name: 'Card' })
  expect((await card.boundingBox())!.height).toBeLessThan(60)
  // Narrow the table to about 60% of its space with the corner grip, then look at it on a narrower screen.
  const grip = (await wrap.locator('.cm-lp-table-resize').boundingBox())!
  const before = (await wrap.boundingBox())!.width
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  await page.mouse.move(grip.x + grip.width / 2 - before * 0.4, grip.y + grip.height / 2, {
    steps: 8,
  })
  await page.mouse.up()
  const share = async () => {
    const table = (await wrap.locator('table').boundingBox())!.width
    const space = await wrap.evaluate((element) => element.clientWidth)
    return table / space
  }
  const wide = await share()
  expect(wide).toBeLessThan(0.75)
  // 3.24.1: Knowledge follows the window now (no fixed cap), so the other screen is one where the note still has room
  // for the table at that share (at 1600px the note column is about 600px and the columns' minimum widths win).
  await page.setViewportSize({ width: 2000, height: 1000 })
  await expect.poll(async () => Math.abs((await share()) - wide)).toBeLessThan(0.03)
})
