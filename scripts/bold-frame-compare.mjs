// Side-by-side check for PLAN 11.3a (not part of `pnpm e2e`): screenshots the binding prototype and `/b` at the two
// review sizes, then compares the frame's computed values. Run `pnpm build` first, then `node scripts/bold-frame-compare.mjs`.
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

import { loadFixtures } from './bold-frame-fixtures.mjs'
import { measure, openPrototypeSettings } from './bold-frame-measure.mjs'
import { recipeParts, searchAppParts, searchPrototypeParts } from './bold-frame-parts-dialogs.mjs'
import { emptyParts, roomParts } from './bold-frame-parts-frame.mjs'
import { rulesParts, systemParts, usageParts } from './bold-frame-parts-settings.mjs'
import { baseURL, board01, board09, dist, output, prototype } from './bold-frame-paths.mjs'
import { writeReports } from './bold-frame-report.mjs'
import { createServe } from './bold-frame-serve.mjs'

if (!existsSync(join(dist, 'index.html'))) {
  console.error('Score is not built. Run `pnpm build`, then try again.')
  process.exit(1)
}

mkdirSync(output, { recursive: true })
const serve = createServe({ dist, ...loadFixtures() })

let browser
try {
  browser = await chromium.launch()
  const context = await browser.newContext({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await context.route(`${baseURL}/**`, serve)
  await context.route('https://fonts.googleapis.com/**', (route) => route.abort())
  await context.route('https://fonts.gstatic.com/**', (route) => route.abort())
  const page = await context.newPage()

  const results = {}
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    const size = `${viewport.width}`
    await page.setViewportSize(viewport)

    await page.goto(prototype, { waitUntil: 'domcontentloaded' })
    await page.locator('.top .word').waitFor()
    await page.evaluate(() => globalThis.document.fonts.ready)
    await page.screenshot({ path: join(output, `bold-prototype-${size}.png`) })
    const prototypeMetrics = await measure(page)
    const prototypeRoomMetrics = await measure(page, roomParts)

    await page.goto(board01, { waitUntil: 'domcontentloaded' })
    await page.locator('section[aria-label="Team room"]').waitFor()
    await page.evaluate(() => globalThis.document.fonts.ready)
    await page.screenshot({ path: join(output, `bold-board-01-${size}.png`) })

    await page.goto(`${baseURL}/b`)
    await page.locator('[data-ui="bold"] .top .word').waitFor({ timeout: 20_000 })
    await page.locator('[data-ui="bold"] .bold-job-tab').first().waitFor({ timeout: 20_000 })
    await page.locator('[data-ui="bold"] .bold-request').first().waitFor({ timeout: 20_000 })
    if (viewport.width > 860) {
      await page.getByRole('group', { name: /Your team/ }).waitFor({ timeout: 20_000 })
      await page.getByRole('complementary', { name: 'Side panel' }).waitFor({ timeout: 20_000 })
    }
    await page.evaluate(() => globalThis.document.fonts.ready)
    await page.screenshot({ path: join(output, `bold-app-${size}.png`) })
    const appMetrics = await measure(page)
    const appRoomMetrics = await measure(page, roomParts, 'app')

    await page.goto(board09, { waitUntil: 'domcontentloaded' })
    await page.getByText('Your team is ready. What first?').waitFor()
    await page.evaluate(() => globalThis.document.fonts.ready)
    await page.screenshot({ path: join(output, `bold-board-09-${size}.png`) })
    const prototypeEmptyMetrics = await measure(page, emptyParts)

    await page.goto(`${baseURL}/b?room=empty-room`)
    await page.locator('[data-ui="bold"] .bold-empty-room').waitFor({ timeout: 20_000 })
    await page.evaluate(() => globalThis.document.fonts.ready)
    await page.screenshot({ path: join(output, `bold-app-empty-${size}.png`) })
    const appEmptyMetrics = await measure(page, emptyParts, 'app')

    await page.goto(prototype, { waitUntil: 'domcontentloaded' })
    await page.locator('.top .word').waitFor()
    await page.locator('button[data-a="search"]:visible').first().click()
    await page.locator('#sq').waitFor()
    await page.evaluate(() => globalThis.document.fonts.ready)
    await page.screenshot({ path: join(output, `bold-prototype-search-${size}.png`) })
    const prototypeSearchMetrics = await measure(page, searchPrototypeParts)
    await page.locator('#sq').fill('cursor')
    await page.screenshot({ path: join(output, `bold-prototype-search-query-${size}.png`) })

    await page.goto(`${baseURL}/b`)
    await page.locator('[data-ui="bold"] .top .word').waitFor({ timeout: 20_000 })
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await page.locator('.bold-search-dialog').waitFor({ timeout: 20_000 })
    await page.locator('.bold-search-result').first().waitFor({ timeout: 20_000 })
    await page.evaluate(() => globalThis.document.fonts.ready)
    await page.screenshot({ path: join(output, `bold-app-search-${size}.png`) })
    const appSearchMetrics = await measure(page, searchAppParts)
    await page.getByRole('combobox', { name: 'Search or run a command' }).fill('cursor')
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(output, `bold-app-search-query-${size}.png`) })

    await page.goto(prototype, { waitUntil: 'domcontentloaded' })
    await page.locator('.top .word').waitFor()
    await page.locator('[data-a="go"][data-v="settings"]:visible').click()
    await page.locator('[data-a="setSec"][data-v="usage"]').click()
    await page.locator('.setgrid .setnav').waitFor()
    await page.evaluate(() => globalThis.document.fonts.ready)
    await page.screenshot({
      path: join(output, `bold-prototype-usage-${size}.png`),
      fullPage: true,
    })
    const prototypeUsageMetrics = await measure(page, usageParts)

    await page.goto(`${baseURL}/b/settings/usage`)
    await page.locator('[data-ui="bold"] .setgrid .setnav').waitFor({ timeout: 20_000 })
    await page.getByRole('heading', { name: 'Usage' }).waitFor({ timeout: 20_000 })
    await page.evaluate(() => globalThis.document.fonts.ready)
    await page.screenshot({
      path: join(output, `bold-app-usage-${size}.png`),
      fullPage: true,
    })
    const appUsageMetrics = await measure(page, usageParts)

    await openPrototypeSettings(page, 'rules')
    await page.screenshot({
      path: join(output, `bold-prototype-rules-${size}.png`),
      fullPage: true,
    })
    const prototypeRulesMetrics = await measure(page, rulesParts)

    await page.goto(`${baseURL}/b/settings/rules`)
    await page.locator('[data-ui="bold"] .setgrid .setnav').waitFor({ timeout: 20_000 })
    await page.getByRole('region', { name: 'Rules' }).waitFor({ timeout: 20_000 })
    await page.evaluate(() => globalThis.document.fonts.ready)
    await page.screenshot({
      path: join(output, `bold-app-rules-${size}.png`),
      fullPage: true,
    })
    const appRulesMetrics = await measure(page, rulesParts, 'app')

    await openPrototypeSettings(page, 'system')
    await page.screenshot({
      path: join(output, `bold-prototype-system-${size}.png`),
      fullPage: true,
    })
    const prototypeSystemMetrics = await measure(page, systemParts)

    await page.goto(`${baseURL}/b/settings/system`)
    await page.locator('[data-ui="bold"] .setgrid .setnav').waitFor({ timeout: 20_000 })
    await page.getByRole('heading', { name: 'System', exact: true }).waitFor({ timeout: 20_000 })
    await page.getByText('Score v1.14.0').waitFor({ timeout: 20_000 })
    await page.getByRole('heading', { name: 'Logs', exact: true }).waitFor({ timeout: 20_000 })
    await page.evaluate(() => globalThis.document.fonts.ready)
    await page.screenshot({
      path: join(output, `bold-app-system-${size}.png`),
      fullPage: true,
    })
    const appSystemMetrics = await measure(page, systemParts, 'app')

    await page.goto(prototype, { waitUntil: 'domcontentloaded' })
    await page.locator('.top .word').waitFor()
    await page.locator('[data-a="search"]:visible').first().click()
    await page.getByRole('button', { name: 'Edit recipes' }).click()
    await page.locator('.dialog.wide').waitFor()
    await page.evaluate(() => globalThis.document.fonts.ready)
    await page.screenshot({ path: join(output, `bold-prototype-recipes-${size}.png`) })
    const prototypeRecipeMetrics = await measure(page, recipeParts, 'prototype')

    await page.goto(`${baseURL}/b?recipes=1`)
    await page.locator('[data-ui="bold"] .bold-recipes-list').waitFor({ timeout: 20_000 })
    await page.evaluate(() => globalThis.document.fonts.ready)
    await page.screenshot({ path: join(output, `bold-app-recipes-${size}.png`) })
    const appRecipeMetrics = await measure(page, recipeParts, 'app')

    results[size] = {
      prototype: prototypeMetrics,
      app: appMetrics,
      room: { prototype: prototypeRoomMetrics, app: appRoomMetrics },
      empty: { prototype: prototypeEmptyMetrics, app: appEmptyMetrics },
      search: { prototype: prototypeSearchMetrics, app: appSearchMetrics },
      usage: { prototype: prototypeUsageMetrics, app: appUsageMetrics },
      recipes: { prototype: prototypeRecipeMetrics, app: appRecipeMetrics },
      rules: { prototype: prototypeRulesMetrics, app: appRulesMetrics },
      system: { prototype: prototypeSystemMetrics, app: appSystemMetrics },
    }
  }

  writeReports(results, output)
  console.log(`Wrote screenshots and measurements to ${output}`)
} finally {
  await browser?.close()
}
