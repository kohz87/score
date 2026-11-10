import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'

// Owner, 2026-11-10: the Board · Repeating · Recipes views sit at the same place on every Tasks page, so switching between
// them doesn't move them (one TasksHeader).
for (const size of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
]) {
  test(`the Tasks views stay put across Board, Repeating and Recipes at ${size.name}`, async ({
    page,
  }) => {
    await pair(page)
    await page.setViewportSize({ width: size.width, height: size.height })
    const boxes: { x: number; y: number }[] = []
    for (const path of ['/b/tasks', '/b/tasks/repeating', '/b/tasks/recipes']) {
      await page.goto(path)
      const views = page.getByRole('navigation', { name: 'Tasks views' })
      await expect(views.getByRole('link', { name: 'Board' })).toBeVisible()
      await page.evaluate(() => document.fonts.ready)
      const box = await views.getByRole('link', { name: 'Board' }).boundingBox()
      expect(box).not.toBeNull()
      boxes.push({ x: Math.round(box!.x), y: Math.round(box!.y) })
    }
    for (const box of boxes.slice(1)) {
      expect(
        Math.abs(box.x - boxes[0]!.x),
        `x on every page: ${JSON.stringify(boxes)}`,
      ).toBeLessThanOrEqual(1)
      expect(
        Math.abs(box.y - boxes[0]!.y),
        `y on every page: ${JSON.stringify(boxes)}`,
      ).toBeLessThanOrEqual(1)
    }
  })
}
