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

async function isOnTop(target: Locator): Promise<boolean> {
  return target.evaluate((element) => {
    const box = element.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) return false
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    return !!top && (element === top || element.contains(top))
  })
}

/** How each shape of a glyph is painted, as a string: geometry, paint and visibility. */
async function glyphPaint(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.agent-glyph')).flatMap((glyph) =>
      Array.from(glyph.querySelectorAll('path, circle, rect, polygon')).map((shape) => {
        const s = getComputedStyle(shape)
        const box = (shape as SVGGraphicsElement).getBBox()
        return [
          shape.tagName,
          s.opacity,
          s.visibility,
          s.display,
          s.transform,
          s.fill,
          s.stroke,
          s.strokeWidth,
          s.getPropertyValue('d'),
          s.clipPath,
          s.mask,
          s.filter,
          Math.round(box.width),
          Math.round(box.height),
        ].join('|')
      }),
    ),
  )
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

  test('#5: the guard compares what glyph shapes paint, not just their wrapper', async ({
    page,
  }) => {
    await wear(page, '.now-card { box-shadow: 0 1px 2px rgb(0 0 0 / 12%); }')
    await startApproval(page)
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
    // As if a rule had slipped through the sanitiser: every path takes another shape (the wrapper stays exactly as it was).
    await page.evaluate(() => {
      document.adoptedStyleSheets.at(-1)!.insertRule('svg path { d: path("M1 1 L2 2"); }')
      document.body.append(document.createElement('i'))
    })
    await expect(page.locator('.look-banner')).toContainText('Score switched your theme off', {
      timeout: 15_000,
    })
    await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
  })

  test('#5: a theme can’t erase or reshape agent glyph shapes', async ({ page }) => {
    await wear(
      page,
      ':root svg path, :root svg circle, :root svg rect { opacity: 0; fill: transparent; stroke: transparent; }' +
        'svg path { d: path("M0 0 L1 1"); transform: scale(0); }' +
        'svg { visibility: hidden; filter: blur(4px); clip-path: inset(100%); }',
    )
    const { url } = await startApproval(page)
    await settle(page)
    const worn = await glyphPaint(page)
    expect(worn.length).toBeGreaterThan(0)
    // The same page without the theme.
    await page.goto(`${url}?look=safe`)
    await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
    await expect(page.locator('.agent-glyph').first()).toBeVisible()
    const plain = await glyphPaint(page)
    // (The room may have gained a message between the two loads: compare what the glyphs look like, not how many.)
    expect([...new Set(worn)].sort()).toEqual([...new Set(plain)].sort())
    expect(await isOnTop(page.locator('.agent-glyph').first())).toBe(true)
  })
})

test.describe('every decision surface is protected, not only the chat card', () => {
  test('#2: the task drawer’s approval text and its Approve button stay shown', async ({
    page,
  }) => {
    test.setTimeout(240_000)
    await wear(
      page,
      '.task-drawer-approval { display: none; }' +
        'section[aria-label="Task actions"] div, section[aria-label="Task actions"] button { display: none; }' +
        'section[aria-label="Task actions"] p, section[aria-label="Task actions"] b, section[aria-label="Task actions"] code { color: transparent; }',
    )
    let taskId: string | undefined
    await expect
      .poll(
        async () => {
          const response = await page.request.get('/api/approvals?status=pending')
          const { items } = (await response.json()) as {
            items: { id: string; actionable: boolean; refs: { kind: string; taskId?: string }[] }[]
          }
          taskId = items
            .find((item) => item.id.startsWith('approval-docs') && item.actionable)
            ?.refs.find((ref) => ref.kind === 'task')?.taskId
          return taskId
        },
        { timeout: 200_000, intervals: [1_000, 2_000, 5_000] },
      )
      .toBeTruthy()
    await page.goto(`/tasks/${taskId}`)
    const drawer = page.getByRole('complementary', { name: 'Task details' })
    const actions = drawer.getByRole('region', { name: 'Task actions' })
    await expect(actions).toBeAttached({ timeout: 20_000 })
    await settle(page)
    const request = actions.locator('.task-drawer-approval')
    const buttons = actions.locator('.task-drawer-buttons')
    await expect(request).toContainText('asks:')
    await expect(actions.getByRole('button', { name: /^Approve/ })).toBeVisible()
    expect(await unreadable(request)).toEqual([])
    expect(await unreadable(buttons)).toEqual([])
  })

  test('#2: the add-coding-agent form keeps its permission controls, warning and password field', async ({
    page,
  }) => {
    await wear(
      page,
      '.team-coding-permission, .coding-reach, .coding-acknowledge { display: none; }' +
        '[role=dialog] fieldset, [role=dialog] legend, [role=dialog] [role=alert], [role=dialog] [role=note] { display: none; }' +
        '[role=dialog] input[type=password], [role=dialog] input[type=radio] { opacity: 0; }' +
        '[role=dialog] label { visibility: hidden; color: transparent; }',
    )
    await page.goto('/team')
    await page.getByRole('button', { name: 'Add agent' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('radio', { name: /Coding agent/ }).check()
    await dialog.getByRole('radio', { name: /Full access/ }).check()
    await settle(page)
    const permission = dialog.getByRole('group', { name: 'Permission' })
    await expect(permission).toBeVisible()
    await expect(permission.getByRole('radio', { name: /Workspace write/ })).toBeVisible()
    await expect(permission.getByRole('alert')).toContainText(
      'Full access turns the CLI’s own sandbox off',
    )
    await expect(dialog.getByLabel('Security password')).toBeVisible()
    expect(await unreadable(permission)).toEqual([])
    expect(await unreadable(dialog.locator('label', { hasText: 'Security password' }))).toEqual([])
    await expect(dialog.getByRole('note').first()).toBeVisible()
  })
})
