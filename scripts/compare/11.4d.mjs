// Side-by-side check for PLAN 11.4d (not part of `pnpm e2e`): screenshots the binding prototype, board 21 and the built
// app at both review sizes, then compares the room dropdown, room/job menus and the read-only Elsewhere panel. The
// sandbox forbids listening sockets, so Chromium fulfils every request for the app origin from the built files.
// Run `pnpm build` first, then `node scripts/compare/11.4d.mjs`.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { baseURL, board21, dist, output } from './11.4d-config.mjs'
import { differences, measure } from './11.4d-measure.mjs'
import {
  appDropdown,
  appElsewhere,
  appJobMenu,
  appRoomMenu,
  openAppRoom,
  openPrototypeRoom,
  prototypeDropdown,
  prototypeElsewhere,
  prototypeJobMenu,
  prototypeRoomMenu,
  waitForFonts,
} from './11.4d-navigation.mjs'
import { elsewhereParts, menuParts } from './11.4d-parts.mjs'
import { serve } from './11.4d-serve.mjs'

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

    await openPrototypeRoom(page)
    await prototypeDropdown(page)
    await page.screenshot({ path: join(output, `bold-11.4d-prototype-dropdown-${size}.png`) })
    const prototypeDropdownValues = await measure(page, menuParts, 'prototype')

    await page.goto(board21, { waitUntil: 'domcontentloaded' })
    await page.locator('[role="listbox"]').waitFor()
    await waitForFonts(page)
    await page.screenshot({ path: join(output, `bold-11.4d-board21-${size}.png`) })

    await openAppRoom(page)
    await appDropdown(page)
    const switchMenu = page.locator('.bold-room-switch')
    await expectText(switchMenu, 'Team room')
    await expectText(switchMenu, 'Always on · 2 jobs')
    await expectText(switchMenu, '#activity-feed')
    await expectText(switchMenu, 'lead · Telegram')
    assert.equal(await page.locator('.bold-room-switch .mi[role="option"]').count(), 3)
    await page.screenshot({ path: join(output, `bold-11.4d-app-dropdown-${size}.png`) })
    const appDropdownValues = await measure(page, menuParts, 'app')

    await openPrototypeRoom(page)
    await prototypeElsewhere(page)
    await page.screenshot({ path: join(output, `bold-11.4d-prototype-elsewhere-${size}.png`) })
    const prototypeElsewhereValues = await measure(page, elsewhereParts, 'prototype')

    await openAppRoom(page)
    await appElsewhere(page)
    const elsewhere = page.locator('.bold-elsewhere')
    await expectText(elsewhere, 'From Telegram · read-only. Reply there, or bring it into a job.')
    await expectText(elsewhere, 'Read-only preview · imported from Telegram')
    await expectText(elsewhere, 'Outline it, then freeze the release branch.')
    await expectText(elsewhere, 'Bring into a job')
    assert.equal(await elsewhere.locator('textarea, input:not([type="hidden"])').count(), 0)
    await page.screenshot({ path: join(output, `bold-11.4d-app-elsewhere-${size}.png`) })
    const appElsewhereValues = await measure(page, elsewhereParts, 'app')

    await openPrototypeRoom(page)
    await prototypeJobMenu(page)
    await page.screenshot({ path: join(output, `bold-11.4d-prototype-job-menu-${size}.png`) })
    const prototypeJobMenuValues = await measure(page, menuParts, 'prototype')

    await appJobMenu(page)
    const jobMenu = page.locator('.bold-job-menu')
    await expectText(jobMenu, 'Share a read-only link')
    await expectText(jobMenu, 'Export the whole room as Markdown')
    assert.equal(await jobMenu.locator('.mi[role="menuitem"]').count(), 2)
    await page.screenshot({ path: join(output, `bold-11.4d-app-job-menu-${size}.png`) })
    const appJobMenuValues = await measure(page, menuParts, 'app')

    await openPrototypeRoom(page)
    await prototypeRoomMenu(page)
    await page.screenshot({ path: join(output, `bold-11.4d-prototype-room-menu-${size}.png`) })
    const prototypeRoomMenuValues = await measure(page, menuParts, 'prototype')

    await appRoomMenu(page)
    const roomMenu = page.locator('.bold-room-menu')
    await expectText(roomMenu, 'Export this room')
    await expectText(roomMenu, 'Share a read-only link')
    assert.equal(await roomMenu.locator('.mi[role="menuitem"]').count(), 3)
    await page.screenshot({ path: join(output, `bold-11.4d-app-room-menu-${size}.png`) })
    const appRoomMenuValues = await measure(page, menuParts, 'app')

    results.push({
      size,
      dropdown: differences(prototypeDropdownValues, appDropdownValues, menuParts),
      jobMenu: differences(prototypeJobMenuValues, appJobMenuValues, menuParts),
      roomMenu: differences(prototypeRoomMenuValues, appRoomMenuValues, menuParts),
      elsewhere: differences(prototypeElsewhereValues, appElsewhereValues, elsewhereParts),
    })
  }
} finally {
  await browser?.close()
}

async function expectText(locator, text) {
  assert.ok((await locator.textContent())?.includes(text), `missing text: ${text}`)
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
