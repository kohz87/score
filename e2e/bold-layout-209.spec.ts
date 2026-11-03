import { expect, test, type Page } from '@playwright/test'
import { openMenuRoom } from './bold-room-menu-fixtures.ts'
import { pair } from './pair.ts'

test.use({ reducedMotion: 'reduce' })

const titles = [
  'You are doing one step (review: Review the whole release plan and report back)',
  'Remove scratch directory /tmp/score-gate-check and everything inside it #2',
  'Say hi',
  'Lead Score orchestration run orc-0c611759 with a very long title that cannot fit',
]
const items = titles.map((title, index) => ({
  id: `ext-${index}`,
  agentId: 'lead',
  source: 'api',
  sourceLabel: 'API',
  title,
  startedAt: '2026-10-23T08:00:00.000Z',
  messageCount: index + 2,
  busy: false,
  roomId: null,
}))

const sizes = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
] as const

for (const viewport of sizes) {
  const at = `${viewport.width}×${viewport.height}`
  test(`Elsewhere rows grow with their content and keep one preview line at ${at}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    await openMenuRoom(page, {
      handle: ({ method, path }) =>
        method === 'GET' && path === '/api/outside-sessions'
          ? { status: 200, body: { items, unavailable: [] } }
          : undefined,
    })
    // 3.21.0: a phone has the room switcher on the job list; 3.22.0: on a desktop it is in the room menu.
    if (viewport.width < 861) {
      await page.goto('/b?jobs=1')
      await page.locator('button.roomtitle').click()
    } else {
      await page.getByRole('button', { name: 'Room menu' }).click()
      await page.getByRole('menuitem', { name: /Older, imported and elsewhere chats/ }).click()
    }
    const picker = page.getByRole('listbox', { name: 'Rooms and chats elsewhere' })
    const rows = picker.getByRole('option', { name: /lead · API/ })
    await expect(rows).toHaveCount(items.length)
    const boxes = await rows.evaluateAll((nodes) =>
      nodes.map((node) => {
        const box = node.getBoundingClientRect()
        const preview = node.querySelector('.bold-menu-preview')!.getBoundingClientRect()
        const line = parseFloat(
          getComputedStyle(node.querySelector('.bold-menu-preview')!).lineHeight,
        )
        return { top: box.top, bottom: box.bottom, previewHeight: preview.height, line }
      }),
    )
    for (const [index, box] of boxes.entries()) {
      expect(box.previewHeight).toBeLessThanOrEqual(box.line + 1)
      if (index > 0) expect(box.top).toBeGreaterThanOrEqual(boxes[index - 1]!.bottom - 0.5)
    }
    // The count stays readable even when the title is cut.
    await expect(rows.first()).toContainText('2 messages')
    await expect(rows.first().locator('.bold-menu-preview-count')).toBeVisible()
  })
}

async function openNote(page: Page, size: { width: number; height: number }) {
  await pair(page)
  await page.setViewportSize(size)
  // 3.22.0: the Library side-panel mode is gone; the same note view is the Knowledge page.
  await page.goto('/b/knowledge')
  await expect(page.locator('[data-ui="bold"]')).toBeVisible()
  await expect(page.getByTestId('bold-library')).toBeVisible()
  await page
    .getByRole('navigation', { name: 'Library notes' })
    .getByRole('button', { name: /^Glossary/ })
    .click()
  await expect(page.getByRole('complementary', { name: 'Note details' })).toBeVisible()
}

const noteSizes = [
  { width: 2400, height: 1000 },
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
] as const

for (const viewport of noteSizes) {
  const at = `${viewport.width}×${viewport.height}`
  test(`the Library note uses the width it has at ${at}`, async ({ page }) => {
    await openNote(page, viewport)
    const side = page.getByRole('complementary', { name: 'Note details' })
    const rail = await side.boundingBox()
    const editor = await page.locator('.kn-note-main').boundingBox()
    const panel = await page.getByTestId('bold-library').boundingBox()
    expect(rail && editor && panel).toBeTruthy()
    if (viewport.width === 2400) {
      expect(panel!.width).toBeGreaterThanOrEqual(1180)
      expect(rail!.x).toBeGreaterThanOrEqual(editor!.x + editor!.width)
    } else {
      // 3.22.0: on the Knowledge page (not the narrow side panel) the details sit beside the note where there is room
      // and below it where there is not; they never overlap it.
      const beside = rail!.x >= editor!.x + editor!.width - 1
      const below = rail!.y >= editor!.y + editor!.height - 1
      expect(beside || below).toBe(true)
    }
    if (viewport.width === 1440) {
      const cards = await side.locator('.kn-panel').evaluateAll((nodes) =>
        nodes.map((node) => {
          const box = node.getBoundingClientRect()
          return { x: Math.round(box.x), y: Math.round(box.y) }
        }),
      )
      expect(cards).toHaveLength(4)
      // 3.21.0: the chat list (even folded) takes width from the side panel. Where the note's side column still has
      // room for two 380px cards the four sit two per row as before; narrower, they stack. None leaves the panel.
      for (const card of cards) expect(card.x).toBeGreaterThanOrEqual(Math.floor(panel!.x))
      if (side && (await side.boundingBox())!.width >= 800) {
        expect(cards[1]!.y).toBe(cards[0]!.y)
        expect(cards[1]!.x).toBeGreaterThan(cards[0]!.x)
        expect(cards[2]!.y).toBeGreaterThan(cards[0]!.y)
        expect(cards[3]!.y).toBe(cards[2]!.y)
      } else expect(cards[1]!.y).toBeGreaterThan(cards[0]!.y)
    }
    if (viewport.width === 1440 || viewport.width === 1280) {
      const inside = await page.locator('.kn-toolbar').evaluate((toolbar) => {
        const box = toolbar.getBoundingClientRect()
        return [...toolbar.querySelectorAll('button')].every((button) => {
          const b = button.getBoundingClientRect()
          return b.left >= box.left - 1 && b.right <= box.right + 1
        })
      })
      expect(inside).toBe(true)
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)
  })
}
