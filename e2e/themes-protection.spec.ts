import { expect, test, type Locator, type Page } from '@playwright/test'
import { mockThemes, type Look, type MockTheme } from './themes-fixtures.ts'
import { pair } from './pair.ts'
import { makeRoom, say } from './rooms.ts'

// Phase 9 gate fixes (decision 101, G1): a theme can't reach inside a protected subtree, and what it can still do from
// outside (fade an ancestor, animate, hover) never leaves a decision unreadable: each attempt below ends with the
// decision visible and readable, either because the theme never got there or because Score fell back to its own look.
// The theme's server routes are mocked per contract § 16.

function gate(css: string, manifest: Record<string, unknown> = {}): MockTheme {
  return { id: 'gate', name: 'Gate', source: 'imported', manifest, css }
}

async function wear(page: Page, css: string, manifest: Record<string, unknown> = {}) {
  const look: Look = { active: 'gate', mode: 'light' }
  await mockThemes(page, [gate(css, manifest)], look)
  await pair(page)
}

async function startApproval(page: Page): Promise<{ card: Locator; url: string }> {
  const room = await makeRoom(page, 'gate')
  await say(page, room.id, `Please ask for approval before installing ${Date.now()}`)
  await page.goto(`/chat/${room.id}`)
  const card = page.getByRole('group', { name: /^Approval: / }).last()
  await expect(card.getByRole('button', { name: 'Approve' })).toBeAttached({ timeout: 20_000 })
  return { card, url: `/chat/${room.id}` }
}

/** Lets the guard's debounce and any delayed animation run. */
async function settle(page: Page, ms = 1600) {
  await page.waitForTimeout(ms)
}

/**
 * What a person looking at `root` could not read or reach: every element that carries text or is a control must be
 * displayed, visible, opaque, painted in a colour that contrasts with what is behind it, and on top where it is.
 * Colours go through a canvas so any CSS colour syntax is measured.
 */
async function unreadable(root: Locator): Promise<string[]> {
  return root.evaluate((surface) => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    const rgba = (value: string): [number, number, number, number] => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = '#000'
      context.fillStyle = value
      context.fillRect(0, 0, 1, 1)
      const d = context.getImageData(0, 0, 1, 1).data
      return [d[0]!, d[1]!, d[2]!, d[3]! / 255]
    }
    const luminance = ([r, g, b]: number[]) => {
      const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
      return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!)
    }
    const problems: string[] = []
    const all = [surface, ...Array.from(surface.querySelectorAll('*'))].filter(
      (el) => !el.closest('svg') || el === surface,
    )
    for (const el of all) {
      const own = Array.from(el.childNodes).some(
        (n) => n.nodeType === 3 && (n.textContent ?? '').trim() !== '',
      )
      const control = el.matches('button, a[href], input, select, textarea')
      if (!own && !control) continue
      const name = `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className).split(' ')[0]}`
      let opacity = 1
      for (let n: Element | null = el; n; n = n.parentElement) {
        const s = getComputedStyle(n)
        opacity *= Number(s.opacity)
        if (s.display === 'none') problems.push(`${name}: display none (${n.tagName})`)
        if (s.visibility !== 'visible') problems.push(`${name}: ${s.visibility}`)
        if (s.filter !== 'none') problems.push(`${name}: filter`)
        if (s.clipPath !== 'none') problems.push(`${name}: clip`)
      }
      if (opacity < 0.7 && !(el as HTMLButtonElement).disabled)
        problems.push(`${name}: opacity ${opacity}`)
      const box = el.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) problems.push(`${name}: no box`)
      const style = getComputedStyle(el)
      const text = rgba(style.color)
      const fill = rgba(style.webkitTextFillColor)
      if (own && (text[3] < 1 || fill[3] < 1)) problems.push(`${name}: transparent text`)
      // Painted behind: the first opaque background up the chain.
      let back: [number, number, number, number] = [255, 255, 255, 1]
      for (let n: Element | null = el; n; n = n.parentElement) {
        const c = rgba(getComputedStyle(n).backgroundColor)
        if (c[3] > 0) {
          back = c
          if (c[3] >= 1) break
        }
      }
      const a = luminance(text)
      const b = luminance(back)
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
      if (own && ratio < 4.5) problems.push(`${name}: contrast ${ratio.toFixed(2)}`)
    }
    return problems
  })
}

test.describe('theme CSS stays out of protected subtrees', () => {
  test('#3: approval title and description can’t be made invisible by position or tag', async ({
    page,
  }) => {
    await wear(
      page,
      'div[aria-label^="Approval:"] > div:first-child > span { color: transparent; }' +
        'div[aria-label^="Approval:"] span { -webkit-text-fill-color: transparent; opacity: 0; }' +
        'div[aria-label^="Approval:"] code { display: none; }',
    )
    const { card } = await startApproval(page)
    await settle(page)
    expect(await unreadable(card)).toEqual([])
    await expect(card.getByRole('button', { name: 'Approve' })).toBeVisible()
    // Contained rather than switched off: the rest of the theme stays on.
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
  })

  test('#3: the guard looks at every element with text, not a list of tags', async ({ page }) => {
    await wear(page, '.now-card { box-shadow: 0 1px 2px rgb(0 0 0 / 12%); }')
    const { card } = await startApproval(page)
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
    // As if a rule had slipped through the sanitiser: the approval's own words go invisible, in the theme's sheet.
    await page.evaluate(() => {
      document.adoptedStyleSheets
        .at(-1)!
        .insertRule('div[aria-label^="Approval:"] > div:first-child > span { color: transparent; }')
      document.body.append(document.createElement('i'))
    })
    await expect(page.locator('.look-banner')).toContainText('Score switched your theme off', {
      timeout: 15_000,
    })
    await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
    await settle(page, 1000) // Score’s own entrance motion
    expect(await unreadable(card)).toEqual([])
  })
})
