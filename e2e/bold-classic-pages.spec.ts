import { expect, test, type Locator, type Page } from '@playwright/test'
import { fixtureNow } from './now-fixture.ts'
import { pair } from './pair.ts'
import { custom, drawn, dropped, wear } from './themes-consent-helpers.ts'
import { mockThemes, type Look, type MockTheme } from './themes-fixtures.ts'
import { okValidation, workflowFixtures } from './workflow-fixtures.ts'
import { visualFixtures, visualHello } from './visual-fixtures.ts'
import { watchApprovalFixture, watchFixture, watchOverviewFixture } from './watch-fixture.ts'

// 2.0.2 (decision 123): the kept classic pages open inside the new shell. Frozen fixtures, no live adapter.

test.use({ timezoneId: 'UTC', locale: 'en-GB' })

const fixtures: Record<string, unknown> = {
  ...visualFixtures,
  ...workflowFixtures,
  '/api/agents/builder/watch?limit=500': watchFixture,
  '/api/agents/builder/watch?limit=1': watchFixture,
  '/api/approvals?status=pending&agent=builder': {
    asOfSeq: 1,
    items: [watchApprovalFixture],
    nextCursor: null,
  },
  '/api/watch/overview': watchOverviewFixture,
  '/api/approvals?status=all': { asOfSeq: 1, items: [watchApprovalFixture], nextCursor: null },
}

const posts: string[] = []

test.beforeEach(async ({ page }, info) => {
  posts.length = 0
  // The Customizer test uses the real fake adapter: it reads and saves themes.
  if (info.title.includes('Customizer')) return
  await page.clock.setFixedTime(new Date(fixtureNow))
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/stream') {
      await route.fulfill({
        contentType: 'text/event-stream',
        body: `event: stream.hello\ndata: ${JSON.stringify(visualHello)}\n\n`,
      })
      return
    }
    if (url.pathname === '/api/workflows/validate') {
      await route.fulfill({ json: okValidation })
      return
    }
    if (route.request().method() !== 'GET') {
      posts.push(url.pathname)
      await route.fulfill({ json: {} })
      return
    }
    url.searchParams.delete('tz')
    const fixture = fixtures[`${url.pathname}${url.search}`]
    if (fixture === undefined) {
      await route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'none' } } })
      return
    }
    await route.fulfill({ json: fixture })
  })
})

const sizes = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
] as const

const frame = (page: Page) => page.locator('[data-ui="bold"] .top .word')
const inFrame = async (page: Page) => {
  await expect(frame(page)).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.app-shell')).toHaveCount(0)
}
const noSideScroll = async (page: Page) =>
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(1)

for (const size of sizes) {
  test.describe(size.name, () => {
    test.use({ viewport: { width: size.width, height: size.height } })

    test(`Recipes shows a recipe's run status and opens the run at ${size.name}`, async ({
      page,
    }) => {
      await page.goto('/b?recipes=1')
      const dialog = page.getByRole('dialog', { name: 'Recipe editor' })
      await expect(dialog).toBeVisible({ timeout: 20_000 })
      // Nothing in the new shell links to the classic list any more.
      await expect(page.getByRole('link', { name: 'Workflow runs and versions' })).toHaveCount(0)
      const status = dialog.getByLabel('Runs of this recipe')
      await expect(status).toContainText('1 run going')
      await status.getByRole('link', { name: 'Running' }).click()
      await expect(page).toHaveURL(/\/b\/runs\/brief-wfrun-1$/)
      await inFrame(page)
      await page.goBack()
      await expect(page).toHaveURL(/\/b\?recipes=1$/)
      await expect(page.getByRole('dialog', { name: 'Recipe editor' })).toBeVisible()
    })

    test(`the workflow list still renders under /b by its address at ${size.name}`, async ({
      page,
    }) => {
      await page.goto('/b/workflows')
      await inFrame(page)
      await expect(page.locator('.bold-classic-page .wf-card').first()).toBeVisible()
      await noSideScroll(page)
      await expect(page).toHaveScreenshot(`bold-workflows-${size.name}.png`, {
        animations: 'disabled',
        maxDiffPixelRatio: 0.01,
      })
      // A link to another classic page stays in /b.
      await page.locator('.bold-classic-page .wf-card a').first().click()
      await expect(page).toHaveURL(/\/b\/workflows\/wf-[a-z-]+$/)
      await inFrame(page)
    })

    test(`the workflow editor and a run page open under /b at ${size.name}`, async ({ page }) => {
      await page.goto('/b/workflows/wf-draft')
      await inFrame(page)
      await expect(page.locator('[data-node="build"]')).toBeVisible()
      await noSideScroll(page)
      await expect(page.getByRole('link', { name: 'All workflows' })).toHaveAttribute(
        'href',
        /\/b\/workflows$/,
      )
      await page.goto('/b/runs/brief-wfrun-1')
      await inFrame(page)
      await expect(page.locator('[data-node="approve"]')).toBeVisible()
      await noSideScroll(page)
      await expect(page).toHaveScreenshot(`bold-run-${size.name}.png`, {
        animations: 'disabled',
        maxDiffPixelRatio: 0.01,
      })
    })

    test(`Watch opens under /b at ${size.name}`, async ({ page }) => {
      await page.goto('/b/watch/builder')
      await inFrame(page)
      await expect(page.getByRole('heading', { name: 'Watching builder', level: 1 })).toBeVisible()
      // The approval is a decision surface: still visible and protected inside the frame.
      const approval = page.getByRole('group', { name: 'Approval needed' })
      await expect(approval).toContainText('npm install ws@8')
      await noSideScroll(page)
      await expect(page).toHaveScreenshot(`bold-watch-${size.name}.png`, {
        animations: 'disabled',
        maxDiffPixelRatio: 0.01,
      })
    })
  })
}

for (const size of sizes) {
  test.describe(size.name, () => {
    test.use({ viewport: { width: size.width, height: size.height } })

    test(`the Customizer opens under /b from Look at ${size.name}`, async ({ page }) => {
      await pair(page)
      await page.goto('/b/settings/look')
      const open = page.getByRole('link', { name: 'Open the Customizer' })
      await expect(open).toBeVisible({ timeout: 20_000 })
      await open.click()
      await expect(page).toHaveURL(/\/b\/settings\/look\/customize\/[^/]+$/)
      await inFrame(page)
      await expect(page.getByRole('heading', { name: 'Customize' })).toBeVisible()
      await noSideScroll(page)
      // Its Back link returns to Look inside /b.
      await page.locator('.cz-back').click()
      await expect(page).toHaveURL(/\/b\/settings\/look$/)
    })
  })
}

test('old classic paths on the new shell redirect to /b and keep the query', async ({ page }) => {
  await page.goto('/workflows')
  await expect(page).toHaveURL(/\/b\/workflows$/)
  await page.goto('/runs/brief-wfrun-1?x=1')
  await expect(page).toHaveURL(/\/b\/runs\/brief-wfrun-1\?x=1$/)
  await page.goto('/watch/builder?from=3')
  await expect(page).toHaveURL(/\/b\/watch\/builder\?from=3$/)
  await page.goto('/settings/look/customize/score')
  await expect(page).toHaveURL(/\/b\/settings\/look\/customize\/score$/)
})

test('on the classic view the classic paths still render the classic shell', async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('score.ui', 'classic'))
  await page.goto('/workflows')
  await expect(page).toHaveURL(/\/workflows$/)
  await expect(page.locator('.app-shell')).toBeVisible()
  await expect(page.locator('[data-ui="bold"]')).toHaveCount(0)
  await page.goto('/runs/brief-wfrun-1')
  await expect(page).toHaveURL(/\/runs\/brief-wfrun-1$/)
  await expect(page.locator('.app-shell')).toBeVisible()
})

// Decisions inside the frame (2.0.2 review): the classic cards and bars still work, and still answer to the server.
for (const size of sizes) {
  test.describe(`decisions ${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } })

    test(`the watch bar decides an approval inside /b at ${size.name}`, async ({ page }) => {
      await page.goto('/b/watch/builder')
      await inFrame(page)
      await page
        .getByRole('group', { name: 'Approval needed' })
        .getByRole('button', { name: 'Approve' })
        .click()
      await expect.poll(() => posts).toContain(`/api/approvals/${watchApprovalFixture.id}/decision`)
    })

    test(`a run's needs-you card decides a gate inside /b at ${size.name}`, async ({ page }) => {
      await page.goto('/b/runs/brief-wfrun-1')
      await inFrame(page)
      const card = page.locator('.bold-classic-page [data-protected]').filter({
        hasText: 'Approve the draft',
      })
      await card
        .getByRole('checkbox')
        .check({ timeout: 1000 })
        .catch(() => undefined)
      await card.getByRole('button', { name: 'Approve' }).click()
      await expect
        .poll(() => posts.some((path) => /\/gates\/[^/]+\/decision$/.test(path)))
        .toBe(true)
    })
  })
}

test('a framed page in the light look', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('score.theme', 'light'))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/b/workflows')
  await inFrame(page)
  await expect(page.locator('[data-ui="bold"]')).toHaveAttribute('data-look', 'light')
  await expect(page.locator('.bold-classic-page')).toHaveAttribute('data-theme', 'light')
  await expect(page).toHaveScreenshot('bold-workflows-light-look.png', {
    animations: 'disabled',
    maxDiffPixelRatio: 0.01,
  })
})

// A theme whose ink/card pair fails AA in both modes: the engine puts protected surfaces back on Score's own colours
// (data-contrast-fallback) and keeps the theme on. The framed classic pages carry the same data-protected surfaces.
const failing: MockTheme = {
  id: 'failing',
  name: 'Failing contrast',
  source: 'custom',
  manifest: {
    colors: {
      light: { ground: '#ffffff', card: '#ffffff', ink: '#eeeeee' },
      dark: { ground: '#000000', card: '#000000', ink: '#222222' },
    },
  },
}

/** WCAG AA of an element's text on the fill a person sees behind it (first opaque ancestor). */
async function expectAA(part: Locator) {
  await expect(part).toBeVisible()
  const ratio = await part.evaluate((element) => {
    const parse = (value: string) => (value.match(/[\d.]+/g) ?? []).map(Number)
    const channel = (v: number) => {
      const c = v / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    }
    const lum = ([r = 0, g = 0, b = 0]: number[]) =>
      0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
    // Composite the translucent fills from the element outwards until an opaque one.
    const layers: number[][] = []
    for (let node: Element | null = element; node; node = node.parentElement) {
      const layer = parse(getComputedStyle(node).backgroundColor)
      const alpha = layer[3] ?? 1
      if (alpha > 0) layers.push(layer)
      if (alpha > 0.99) break
    }
    let fill = [255, 255, 255]
    for (const [r = 0, g = 0, b = 0, a = 1] of layers.reverse())
      fill = [r, g, b].map((v, k) => v * a + fill[k]! * (1 - a))
    const text = parse(getComputedStyle(element).color)
    const [hi, lo] = [lum(text), lum(fill)].sort((a, b) => b - a)
    return (hi! + 0.05) / (lo! + 0.05)
  })
  expect(ratio).toBeGreaterThanOrEqual(4.5)
}

async function expectGuardKeptTheme(page: Page) {
  await expect(page.locator('html')).toHaveAttribute('data-contrast-fallback', '')
  await custom(page)
  await expect(page.locator('.look-banner')).toHaveCount(0)
}

for (const mode of ['light', 'dark'] as const) {
  test(`a failing theme keeps the framed run and Watch decisions protected and readable (${mode})`, async ({
    page,
  }) => {
    await page.addInitScript((value) => localStorage.setItem('score.theme', value), mode)
    const look: Look = { active: 'failing', mode }
    await mockThemes(page, [failing], look)
    await page.setViewportSize({ width: 1440, height: 900 })

    await page.goto('/b/runs/brief-wfrun-1')
    await inFrame(page)
    await expectGuardKeptTheme(page)
    const card = page.locator('.bold-classic-page [data-protected]').filter({
      hasText: 'Approve the draft',
    })
    await expect(card.first()).toHaveAttribute('data-protected', /.+/)
    await expectAA(card.first())
    await expectAA(card.first().getByRole('button', { name: 'Approve' }))

    await page.goto('/b/watch/builder')
    await inFrame(page)
    await expectGuardKeptTheme(page)
    const bar = page.getByRole('group', { name: 'Approval needed' })
    await expect(bar).toHaveAttribute('data-protected', /.+/)
    await expectAA(bar.locator('.watch-approval__text'))
    await expectAA(bar.getByRole('button', { name: 'Approve' }))
    await expectAA(bar.getByRole('button', { name: 'Deny' }))
  })
}

for (const mode of ['light', 'dark'] as const) {
  test(`a failing theme keeps bold Settings › Rules readable (${mode})`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('score.theme', value), mode)
    await mockThemes(page, [failing], { active: 'failing', mode })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/b/settings/rules')
    const card = page.locator('.bold-settings-page .rules-card[data-protected]')
    await expect(card).toBeVisible()
    await expectGuardKeptTheme(page)
    await expectAA(card.getByRole('heading').first())
    await expectAA(card.locator('label, li').first())
  })
}

// The Customizer's way back inside the bold frame, against the real fake adapter (its title says Customizer, so the
// fixture mocks above stay out of it).
test.describe('the Customizer way back inside /b', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('a theme that fades the back link away is not allowed to (Customizer)', async ({ page }) => {
    test.setTimeout(90_000)
    await wear(
      page,
      '.chat-thread { box-shadow: 0 1px 2px rgb(0 0 0 / 12%); }\n.cz-back { opacity: 0; color: transparent; }',
    )
    await page.goto('/settings/look/customize')
    await expect(page).toHaveURL(/\/b\/settings\/look\/customize/)
    await expect(page.getByRole('heading', { name: 'Customize' })).toBeVisible()
    await custom(page)
    await drawn(page.locator('.cz-back'))
  })

  test('Ctrl+K opens Search with Reset look and it drops the theme (Customizer)', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await wear(page)
    await page.goto('/settings/look/customize')
    await expect(page.getByRole('heading', { name: 'Customize' })).toBeVisible()
    await custom(page)
    await page.keyboard.press('Control+k')
    const dialog = page.getByRole('dialog', { name: 'Search and commands' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('combobox', { name: 'Search or run a command' }).fill('reset look')
    await dialog.getByRole('option', { name: 'Reset look on this device' }).click()
    await dropped(page)
  })

  test('the safe-look banner shows inside the frame (Customizer)', async ({ page }) => {
    test.setTimeout(90_000)
    await wear(page)
    await page.goto('/b/settings/look/customize?look=safe')
    await expect(page.getByRole('heading', { name: 'Customize' })).toBeVisible()
    await expect(page.locator('.look-banner')).toContainText('Safe look')
    await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
  })

  test('leaving with unsaved changes asks first (Customizer)', async ({ page }) => {
    await pair(page)
    await page.goto('/b/settings/look/customize')
    await expect(page.getByRole('heading', { name: 'Customize' })).toBeVisible()
    await page.getByRole('tab', { name: 'Shape', exact: true }).click()
    await page
      .getByRole('radiogroup', { name: 'Shadows' })
      .getByRole('radio', { name: 'Flat' })
      .click()
    await page.locator('.cz-back').click()
    const dialog = page.getByRole('dialog', { name: 'Leave without saving?' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Keep editing' }).click()
    await expect(page).toHaveURL(/customize/)
    await page.locator('.cz-back').click()
    await page.getByRole('button', { name: 'Leave and lose changes' }).click()
    await expect(page).toHaveURL(/\/b\/settings\/look$/)
  })
})

test('the old path keeps its #hash through the redirect', async ({ page }) => {
  await page.goto('/runs/brief-wfrun-1#step')
  await expect(page).toHaveURL(/\/b\/runs\/brief-wfrun-1#step$/)
})
