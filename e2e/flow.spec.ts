import { expect, test } from '@playwright/test'

// The fake scenario's brief starts as the ask plus the lead's plan turn; the build task joins a few seconds later.
test('flow canvas renders the brief, zooms, fits and moves focus across nodes', async ({
  page,
}) => {
  test.setTimeout(60_000)
  // Other specs share this server and start briefs of their own, so open the scenario's brief by title.
  let briefId = ''
  await expect
    .poll(
      async () => {
        const list = (await (await page.request.get('/api/briefs?status=active')).json()) as {
          items: { id: string; title: string }[]
        }
        briefId = list.items.find((item) => item.title.includes('pagination'))?.id ?? ''
        return briefId
      },
      { timeout: 30_000 },
    )
    .not.toBe('')
  await page.goto(`/now/flow/${briefId}`)
  const nodes = page.locator('[data-flow-node]')
  await expect(nodes.first()).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => nodes.count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(2)
  await expect(page.locator('[data-flow-edge]').first()).toBeAttached()
  await expect(page.locator('[data-flow-edge][data-kind="flow"]').first()).toBeAttached()
  await expect(
    page.getByRole('heading', { level: 2 }).filter({ hasText: 'pagination' }),
  ).toBeVisible()

  const level = page.getByRole('status', { name: 'Zoom level' })
  const world = page.getByTestId('flow-world')
  await expect(level).toHaveText('100%')
  const before = await world.boundingBox()
  await page.getByRole('button', { name: 'Zoom in' }).click()
  await expect(level).toHaveText('125%')
  const zoomed = await world.boundingBox()
  expect(zoomed!.width).toBeGreaterThan(before!.width)
  await page.getByRole('button', { name: 'Zoom out' }).click()
  await page.getByRole('button', { name: 'Zoom out' }).click()
  await expect(level).toHaveText('75%')

  // Fit-to-screen scales the whole graph into the canvas without a scrollbar.
  await page.getByRole('button', { name: 'Fit to screen' }).click()
  const viewport = page.locator('.flow-viewport')
  await expect
    .poll(async () =>
      viewport.evaluate(
        (el) => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight,
      ),
    )
    .toBe(true)
  await expect(level).not.toHaveText('75%')

  // Ctrl+wheel zooms too.
  const box = (await viewport.boundingBox())!
  await page.mouse.move(box.x + 100, box.y + 100)
  const fitted = await level.textContent()
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -200)
  await page.keyboard.up('Control')
  await expect(level).not.toHaveText(fitted!)

  // Keyboard: Tab into the canvas, then arrow keys move focus between nodes.
  await viewport.focus()
  await page.keyboard.press('Tab')
  const first = page.locator('[data-flow-node]:focus')
  await expect(first).toBeVisible()
  const firstId = await first.getAttribute('data-flow-node')
  await page.keyboard.press('ArrowRight')
  const second = page.locator('[data-flow-node]:focus')
  await expect(second).toBeVisible()
  expect(await second.getAttribute('data-flow-node')).not.toBe(firstId)
  await page.keyboard.press('ArrowLeft')
  await expect(page.locator(`[data-flow-node="${firstId}"]:focus`)).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.locator(`[data-flow-node="${firstId}"]`)).toHaveAttribute(
    'aria-pressed',
    'true',
  )
})
