// Side-by-side check for PLAN 11.6b (not part of `pnpm e2e`): screenshots the binding prototype and the built app at
// the two review sizes, compares the Workbench and the agent's screen, and checks the seeded content without a server.
// Run `pnpm build` first, then `node scripts/compare/11.6b.mjs`.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { baseURL, dist, output } from './11.6b-config.mjs'
import { differences, measure } from './11.6b-measure.mjs'
import {
  appScreen,
  appWorkbench,
  openPrototypeReplay,
  prototypeBench,
} from './11.6b-navigation.mjs'
import { codeParts, replayParts, screenParts } from './11.6b-parts.mjs'
import { serve } from './11.6b-serve.mjs'

if (!existsSync(join(dist, 'index.html'))) {
  console.error('Score is not built. Run `pnpm build`, then try again.')
  process.exit(1)
}
mkdirSync(output, { recursive: true })

const results = []
let browser
try {
  browser = await chromium.launch()
  const context = await browser.newContext({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await context.route(`${baseURL}/**`, serve)
  await context.route('https://fonts.googleapis.com/**', (route) => route.abort())
  await context.route('https://fonts.gstatic.com/**', (route) => route.abort())
  const page = await context.newPage()

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    const size = `${viewport.width}`
    await page.setViewportSize(viewport)

    await prototypeBench(page, 'code')
    await page.screenshot({ path: join(output, `bold-11.6b-prototype-workbench-code-${size}.png`) })
    const prototypeCode = await measure(page, codeParts, 'prototype')

    await appWorkbench(page, 'workbench')
    const bench = page.getByTestId('bold-workbench')
    await bench.getByRole('region', { name: 'Code in api/events.py' }).waitFor()
    assert.equal(
      await bench.locator('[data-comment="send_back"]').textContent(),
      'reviewerTwo events in one millisecond: the second is skipped.Outdated · was line 5',
    )
    assert.equal(
      await bench.locator('[data-comment="approve"]').textContent(),
      'reviewerNice: the page size is one constant.Approved',
    )
    assert.equal(await bench.locator('[data-cursor="builder"]').count(), 1)
    assert.equal(await bench.locator('input, textarea, [contenteditable="true"]').count(), 0)
    await page.screenshot({ path: join(output, `bold-11.6b-app-workbench-code-${size}.png`) })
    const appCode = await measure(page, codeParts, 'app')

    await prototypeBench(page, 'screen')
    await page.screenshot({
      path: join(output, `bold-11.6b-prototype-workbench-screen-${size}.png`),
    })
    const prototypeScreen = await measure(page, screenParts, 'prototype')

    await appWorkbench(page, 'screen')
    await page.getByRole('region', { name: 'builder’s screen' }).waitFor()
    assert.equal(
      await page
        .getByRole('region', { name: 'builder’s screen' })
        .locator('input, textarea, [contenteditable="true"]')
        .count(),
      0,
    )
    await page.screenshot({ path: join(output, `bold-11.6b-app-workbench-screen-${size}.png`) })
    const appScreenBench = await measure(page, screenParts, 'app')

    await openPrototypeReplay(page)
    await page.screenshot({ path: join(output, `bold-11.6b-prototype-agent-screen-${size}.png`) })
    const prototypeReplayMetrics = await measure(page, replayParts, 'prototype')

    await appScreen(page)
    const log = page.getByRole('region', { name: 'What builder did' })
    assert.ok((await log.getByRole('button').count()) >= 3)
    const bar = page.getByRole('group', { name: 'Approval needed' })
    assert.equal(await bar.getAttribute('data-protected'), 'any')
    await page.screenshot({ path: join(output, `bold-11.6b-app-agent-screen-${size}.png`) })
    const appReplay = await measure(page, replayParts, 'app')

    results.push({
      size,
      workbenchCode: differences(prototypeCode, appCode, codeParts),
      workbenchScreen: differences(prototypeScreen, appScreenBench, screenParts),
      agentScreen: differences(prototypeReplayMetrics, appReplay, replayParts),
    })
  }
} finally {
  await browser?.close()
}

for (const result of results) {
  console.log(`\n${result.size}px`)
  for (const [screen, rows] of Object.entries(result).filter(([name]) => name !== 'size')) {
    console.log(
      `  ${screen}: ${rows.length === 0 ? 'computed values match' : `${rows.length} difference(s)`}`,
    )
    for (const row of rows)
      console.log(`    ${row.area} · ${row.property}: prototype ${row.prototype} · app ${row.app}`)
  }
}
console.log(`\nScreenshots in ${output}.`)
