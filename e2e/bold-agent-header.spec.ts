import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'

// Owner, 2026-10-26: on the agent page "Team" sat higher than the "/" beside it, and "Look at its screen" higher than
// "Remove agent…". Text links keep a 32px touch box; their text must line up with their neighbours' text.

/** The vertical middle of an element's own text (not its box). */
async function textMiddle(page: Page, selector: string, text: string): Promise<number> {
  return page.evaluate(
    ([sel, wanted]) => {
      const el = [...document.querySelectorAll(sel)].find((node) =>
        node.textContent?.includes(wanted),
      )
      if (!el) throw new Error(`no ${sel} with ${wanted}`)
      const range = document.createRange()
      range.selectNodeContents(el)
      const r = range.getBoundingClientRect()
      return r.top + r.height / 2
    },
    [selector, text] as const,
  )
}

for (const size of [
  { name: 'desktop', width: 1298, height: 800 },
  { name: 'phone', width: 390, height: 844 },
]) {
  test(`the agent page header's text lines up at ${size.name}`, async ({ page }) => {
    await pair(page)
    await page.setViewportSize({ width: size.width, height: size.height })
    await page.goto('/b/team/builder')
    await expect(page.getByRole('heading', { name: 'builder', level: 1 })).toBeVisible()
    const head = '.bold-agent .pagehead'
    const team = await textMiddle(page, `${head} > a.link`, 'Team')
    const slash = await textMiddle(page, `${head} > span.muted`, '/')
    expect(Math.abs(team - slash)).toBeLessThanOrEqual(2)
    if (size.name === 'desktop') {
      const remove = await textMiddle(page, '.bold-agent-remove', 'Remove agent')
      const watch = await textMiddle(page, '.bold-agent-watch', 'Look at its screen')
      const message = await textMiddle(page, '.bold-agent-actions .btn', 'Message')
      expect(Math.abs(remove - watch)).toBeLessThanOrEqual(1)
      expect(Math.abs(watch - message)).toBeLessThanOrEqual(2)
    }
  })
}
