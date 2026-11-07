// Side-by-side check for PLAN 11.10a (not part of `pnpm e2e`): boards 03/18/19/20 and the built app at 1440×900 and
// 390×844. The boards are fixed 390×844 canvases, so computed values are compared only at phone width; the desktop
// pass captures the same screens for review. The sandbox forbids listening sockets, so Chromium fulfils every request
// for the app origin from dist. Run `pnpm build` first, then `node scripts/compare/11.10a.mjs`.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { baseURL, dist, output } from './11.10a-config.mjs'
import { differences, measure } from './11.10a-measure.mjs'
import { openApp, openBoard } from './11.10a-navigation.mjs'
import { parts } from './11.10a-parts.mjs'
import { serve } from './11.10a-serve.mjs'

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
    const size = String(viewport.width)
    await page.setViewportSize(viewport)

    await openBoard(page, '18')
    await page.screenshot({ path: join(output, `bold-11.10a-board18-${size}.png`) })
    const phone = viewport.width <= 860
    const boardJobs = phone ? await measure(page, parts.jobs, 'board') : null
    await openApp(page, '/b')
    const appJobs = page.getByRole('region', { name: 'Jobs' })
    if (phone) {
      await appJobs.waitFor()
      // Board 18 omits the default job; the app adds its "Team room" row (the home of the list composer).
      assert.equal(await page.locator('.bold-phone-job').count(), 4)
      assert.equal(
        await page
          .locator('.bold-phone-job')
          .first()
          .locator('.bold-phone-job-title b')
          .textContent(),
        'Team room',
      )
      assert.ok(
        (await page.locator('.bold-phone-presence').getAttribute('aria-label'))?.includes(
          'builder',
        ),
      )
    } else {
      await page.getByRole('tab', { name: /Activity feed/ }).waitFor()
    }
    assert.ok(
      (await page.locator('.bold-request').textContent())?.includes('May I install a package?'),
    )
    await page.screenshot({ path: join(output, `bold-11.10a-app-jobs-${size}.png`) })
    const appJobsValues = phone ? await measure(page, parts.jobs, 'app') : null

    await openBoard(page, '03')
    await page.screenshot({ path: join(output, `bold-11.10a-board03-${size}.png`) })
    const boardChat = phone ? await measure(page, parts.chat, 'board') : null
    await openApp(page, '/b?job=job-activity')
    if (phone) {
      await page.getByRole('button', { name: 'Back to jobs' }).waitFor()
      assert.ok(
        (await page.locator('.bold-phone-chat-id').textContent())?.includes('Activity feed'),
      )
    } else {
      await page
        .getByRole('tab', { name: /Activity feed/, selected: true })
        .waitFor({ timeout: 20_000 })
      await page.getByText('Read layer is ready. The feed renders newest first.').waitFor()
    }
    await page.screenshot({ path: join(output, `bold-11.10a-app-chat-${size}.png`) })
    const appChat = phone ? await measure(page, parts.chat, 'app') : null

    await openBoard(page, '19')
    await page.screenshot({ path: join(output, `bold-11.10a-board19-${size}.png`) })
    const boardOneToOne = phone ? await measure(page, parts.oneToOne, 'board') : null
    await openApp(page, '/b?with=builder')
    await page.locator('.bold-dm-privacy').waitFor()
    assert.ok(
      (await page.locator('.bold-dm-privacy').textContent())?.includes(
        'Only you and builder see this',
      ),
    )
    await page.screenshot({ path: join(output, `bold-11.10a-app-one-to-one-${size}.png`) })
    const appOneToOne = phone ? await measure(page, parts.oneToOne, 'app') : null

    await openBoard(page, '20')
    await page.screenshot({ path: join(output, `bold-11.10a-board20-${size}.png`) })
    const boardTeam = phone ? await measure(page, parts.team, 'board') : null
    await openApp(page, '/b/team')
    await page.getByRole('heading', { name: phone ? 'Team' : 'Your team', level: 1 }).waitFor()
    assert.equal(await page.locator('.bold-agentcard').count(), 4)
    await page.screenshot({ path: join(output, `bold-11.10a-app-team-${size}.png`) })
    const appTeam = phone ? await measure(page, parts.team, 'app') : null

    await openBoard(page, '20')
    const boardTabs = phone ? await measure(page, parts.tabbar, 'board') : null
    await openApp(page, '/b')
    if (phone) {
      await page.locator('.bold-tabbar').waitFor()
      assert.equal(await page.locator('.bold-tabbar button').count(), 4)
      await page.screenshot({ path: join(output, `bold-11.10a-app-tabbar-${size}.png`) })
    }
    const appTabs = phone ? await measure(page, parts.tabbar, 'app') : null

    if (phone)
      results.push({
        size,
        jobs: differences(boardJobs, appJobsValues, parts.jobs),
        chat: differences(boardChat, appChat, parts.chat),
        oneToOne: differences(boardOneToOne, appOneToOne, parts.oneToOne),
        team: differences(boardTeam, appTeam, parts.team),
        tabbar: differences(boardTabs, appTabs, parts.tabbar),
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
      console.log(`    ${row.area} · ${row.property}: board ${row.board} · app ${row.app}`)
  }
}
console.log('The boards are fixed 390×844 canvases; only screenshots were taken at 1440px.')
console.log(`\nScreenshots in ${output}.`)
