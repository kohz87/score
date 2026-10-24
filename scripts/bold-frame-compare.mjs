// Side-by-side check for PLAN 11.3a (not part of `pnpm e2e`): screenshots the binding prototype and `/b` at the two
// review sizes, then compares the frame's computed values. Run `pnpm build` first, then `node scripts/bold-frame-compare.mjs`.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from '@playwright/test'

const root = resolve(new URL('..', import.meta.url).pathname)
const output = join(root, 'test-results')
const dist = join(root, 'apps/web/dist')
// The sandbox may forbid listening sockets. Chromium routes every request for this origin from the built files instead:
// /b is still the built app's route, with no server and no port.
const baseURL = 'http://score.local'
const prototype = pathToFileURL(join(root, 'docs/design/bold/prototype.html')).href

if (!existsSync(join(dist, 'index.html'))) {
  console.error('Score is not built. Run `pnpm build`, then try again.')
  process.exit(1)
}

mkdirSync(output, { recursive: true })
const fixtures = JSON.parse(readFileSync(join(root, 'e2e/fixtures/visual.json'), 'utf8'))
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

async function serve(route) {
  const url = new URL(route.request().url())
  if (url.pathname.startsWith('/api/')) {
    if (url.pathname === '/api/stream') return route.fulfill({ status: 204 })
    // Reports requests carry the viewer's time zone; the visual fixture is keyed by range only.
    const reportFixture =
      url.pathname === '/api/reports'
        ? fixtures[`/api/reports?range=${url.searchParams.get('range') ?? '7d'}`]
        : undefined
    const fixture =
      fixtures[`${url.pathname}${url.search}`] ??
      reportFixture ??
      (url.pathname === '/api/reports' ? fixtures['/api/reports?range=7d'] : undefined) ??
      fixtures[url.pathname]
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        fixture ?? {
          asOfSeq: 0,
          items: [],
          rooms: [],
          directs: [],
          projects: [],
          columns: { planned: [], working: [], in_review: [], needs_you: [], done: [] },
        },
      ),
    })
  }
  const requested = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)
  let file = resolve(dist, `.${requested}`)
  if (!file.startsWith(dist + sep) || !existsSync(file) || !statSync(file).isFile())
    file = join(dist, 'index.html')
  return route.fulfill({
    status: 200,
    contentType: contentTypes[extname(file)] ?? 'application/octet-stream',
    body: readFileSync(file),
  })
}

const parts = [
  {
    name: 'Top bar',
    selector: '.top',
    props: ['fontSize', 'height', 'gap', 'padding', 'backgroundColor'],
  },
  { name: 'Wordmark', selector: '.word', props: ['fontSize', 'height', 'letterSpacing', 'color'] },
  { name: 'Nav', selector: '.nav', props: ['height', 'gap', 'backgroundColor'] },
  {
    name: 'Nav item',
    selector: '.nav button',
    props: ['fontSize', 'height', 'borderRadius', 'padding', 'color', 'backgroundColor'],
  },
  {
    name: 'Dock',
    selector: '.dock',
    props: ['fontSize', 'height', 'borderRadius', 'gap', 'padding', 'color', 'backgroundColor'],
  },
  {
    name: 'Dock ring',
    selector: '.ring',
    props: ['width', 'height', 'borderRadius', 'backgroundColor'],
  },
  {
    name: 'Search',
    selector: '.searchbtn',
    props: ['fontSize', 'height', 'borderRadius', 'gap', 'padding', 'color', 'backgroundColor'],
  },
  {
    name: 'Key hint',
    selector: '.kbd',
    props: ['fontSize', 'height', 'borderRadius', 'padding', 'color', 'backgroundColor'],
  },
  {
    name: 'Gear',
    selector: '.icon-btn.gear',
    props: ['width', 'height', 'borderRadius', 'color', 'backgroundColor'],
  },
  {
    name: 'Avatar',
    selector: '.avatar',
    props: ['fontSize', 'width', 'height', 'borderRadius', 'color', 'backgroundColor'],
  },
  {
    name: 'Room title',
    selector: '.roomtitle',
    props: ['fontSize', 'height', 'gap', 'letterSpacing', 'color'],
  },
  {
    name: 'Side panel',
    selector: '.side',
    props: ['width', 'height', 'borderRadius', 'color', 'backgroundColor', 'boxShadow'],
  },
  {
    name: 'Side head',
    selector: '.sidehead',
    props: ['height', 'gap', 'padding', 'borderBottomColor'],
  },
  {
    name: 'Tab bar',
    selector: '.tabbar',
    props: ['height', 'gap', 'padding', 'color', 'backgroundColor', 'borderTopColor'],
  },
  {
    name: 'Tab item',
    selector: '.tabbar button',
    props: ['fontSize', 'height', 'minWidth', 'gap', 'color'],
  },
]

// PLAN 11.9c: the Settings frame and Usage blocks. Both pages use the prototype's class names.
const usageParts = [
  {
    name: 'Settings grid',
    selector: '.setgrid',
    props: ['display', 'gap', 'alignItems', 'width'],
  },
  {
    name: 'Settings nav',
    selector: '.setnav',
    props: ['width', 'maxWidth', 'gap', 'flexDirection', 'flexWrap'],
  },
  {
    name: 'Selected section',
    selector: '.setnav button.on',
    props: ['padding', 'borderRadius', 'color', 'backgroundColor'],
  },
  {
    name: 'Settings main',
    selector: '.setmain',
    props: ['minWidth', 'gap', 'flexGrow', 'flexBasis'],
  },
  {
    name: 'Range selector',
    selector: '.seg',
    props: ['display', 'gap', 'padding', 'borderRadius', 'backgroundColor'],
  },
  {
    name: 'Range item',
    selector: '.seg button.on',
    props: [
      'minHeight',
      'padding',
      'borderRadius',
      'fontSize',
      'fontWeight',
      'color',
      'backgroundColor',
    ],
  },
  {
    name: 'Numbers',
    selector: '.grid4',
    props: ['display', 'gap', 'gridTemplateColumns'],
  },
  {
    name: 'Number card',
    selector: '.grid4 .card',
    props: ['padding', 'borderRadius', 'gap', 'backgroundColor'],
  },
  {
    name: 'Charts',
    selector: '.grid2',
    props: ['display', 'gap', 'gridTemplateColumns'],
  },
  {
    name: 'Chart card',
    selector: '.grid2 .card',
    props: ['padding', 'borderRadius', 'gap', 'backgroundColor'],
  },
]

// PLAN 11.9b: Rules and System use the prototype's frame but real editors, so their element names differ.
const rulesParts = [
  {
    name: 'Section title',
    selector: '.setmain > h2',
    appSelector: '.rules-card > div:first-child h2',
    props: ['fontSize', 'lineHeight', 'letterSpacing', 'color'],
  },
  {
    name: 'Mode card',
    selector: '.setmain > .card',
    appSelector: '.rules-style',
    props: ['padding', 'borderRadius', 'gap', 'backgroundColor'],
  },
  {
    name: 'Mode label',
    selector: '.setmain > .card .lab',
    appSelector: '.rules-style legend',
    props: ['fontSize', 'color'],
  },
  {
    name: 'Mode choices',
    selector: '.setmain > .card .seg',
    appSelector: '.rules-style .rules-option',
    props: ['display', 'gap', 'padding', 'borderRadius', 'backgroundColor'],
  },
  {
    name: 'Mode choice',
    selector: '.seg button.on',
    appSelector: '.rules-option:has(input:checked)',
    props: ['fontSize', 'fontWeight', 'color', 'backgroundColor'],
  },
  {
    name: 'Lists',
    selector: '.setmain > .grid3',
    appSelector: '.rules-columns',
    props: ['display', 'gap', 'gridTemplateColumns'],
  },
  {
    name: 'List card',
    selector: '.grid3 > .card',
    appSelector: '.rules-column',
    props: ['padding', 'borderRadius', 'gap', 'backgroundColor'],
  },
  {
    name: 'List heading',
    selector: '.grid3 > .card h3',
    appSelector: '.rules-column .rules-heading',
    props: ['fontSize', 'fontWeight', 'color'],
  },
  {
    name: 'Explanatory note',
    selector: '.setmain > .row .small.muted',
    appSelector: '.rules-card > .rules-note',
    props: ['fontSize', 'color'],
  },
]

const systemParts = [
  {
    name: 'Section title',
    selector: '.setmain > h2',
    appSelector: '.bold-system > h2',
    props: ['fontSize', 'lineHeight', 'letterSpacing', 'color'],
  },
  {
    name: 'Cards',
    selector: '.setmain > .grid2',
    appSelector: '.system-grid',
    props: ['display', 'gap', 'gridTemplateColumns'],
  },
  {
    name: 'Card',
    selector: '.grid2 > .card:not(.span2)',
    appSelector: '.system-grid > .settings-card',
    props: ['padding', 'borderRadius', 'gap', 'backgroundColor'],
  },
  {
    name: 'Card heading',
    selector: '.grid2 > .card h3',
    appSelector: '.system-grid > .settings-card h2',
    props: ['fontSize', 'fontWeight', 'color'],
  },
  {
    name: 'Wide card',
    selector: '.grid2 > .card.span2',
    appSelector: '.system-logs .settings-card',
    props: ['padding', 'borderRadius', 'gap', 'backgroundColor'],
  },
  {
    name: 'Log surface',
    selector: '.grid2 > .card.span2 .term',
    appSelector: '.system-logs .logs-scroll',
    props: ['padding', 'borderRadius', 'fontFamily', 'fontSize', 'color', 'backgroundColor'],
  },
  {
    name: 'Pause row',
    selector: '.grid2 > .card.span2.row',
    appSelector: '.system-pause',
    props: ['padding', 'borderRadius', 'gap', 'backgroundColor'],
  },
  {
    name: 'Pause button',
    selector: '.grid2 > .card.span2.row .btn',
    appSelector: '.system-pause .btn',
    props: ['minHeight', 'padding', 'borderRadius', 'fontWeight', 'color', 'backgroundColor'],
  },
]

// PLAN 11.9a: the prototype's Connections grid and the app's real provider/channel rows.
const connectionsParts = [
  {
    name: 'Section title',
    selector: '.setmain > h2',
    appSelector: '.bold-connections > h2',
    props: ['fontSize', 'lineHeight', 'letterSpacing', 'color'],
  },
  {
    name: 'Cards',
    selector: '.setmain > .grid2',
    appSelector: '.bold-connections > .grid2',
    props: ['display', 'gap', 'gridTemplateColumns'],
  },
  {
    name: 'Card',
    selector: '.grid2 > .card',
    appSelector: '.bold-connections .grid2 > .card',
    props: ['padding', 'borderRadius', 'gap', 'backgroundColor'],
  },
  {
    name: 'Card heading',
    selector: '.grid2 > .card h3',
    appSelector: '.bold-connections .card h3',
    props: ['fontSize', 'fontWeight', 'color'],
  },
  {
    name: 'Status dot',
    selector: '.grid2 > .card .dot',
    appSelector: '.bold-connect-row .dot',
    props: ['width', 'height', 'borderRadius', 'backgroundColor'],
  },
  {
    name: 'Row action',
    selector: '.grid2 > .card .btn.sm',
    appSelector: '.bold-connect-row .btn.sm',
    props: [
      'minHeight',
      'padding',
      'borderRadius',
      'fontSize',
      'fontWeight',
      'color',
      'backgroundColor',
    ],
  },
  {
    name: 'Check again',
    selector: '.grid2 > .card .link',
    appSelector: '.bold-connections .card .link',
    props: ['fontSize', 'color', 'textDecorationLine'],
  },
]

// Tools uses the app's real server rows; the prototype has sample rows with the same visual hierarchy.
const toolsParts = [
  {
    name: 'Section title',
    selector: '.setmain > h2',
    appSelector: '.bold-tools > h2',
    props: ['fontSize', 'lineHeight', 'letterSpacing', 'color'],
  },
  {
    name: 'Tool card',
    selector: '.setmain > .card',
    appSelector: '.bold-tool-servers',
    props: ['padding', 'borderRadius', 'gap', 'backgroundColor'],
  },
  {
    name: 'Card heading',
    selector: '.setmain > .card h3',
    appSelector: '.bold-tool-servers h3',
    props: ['fontSize', 'fontWeight', 'color'],
  },
  {
    name: 'Tool row',
    selector: '.setmain > .card .listrow',
    appSelector: '.bold-tool-server',
    props: ['display', 'minHeight', 'padding', 'gap', 'borderTopColor'],
  },
  {
    name: 'Tool name',
    selector: '.listrow .grow b',
    appSelector: '.bold-tool-name b',
    props: ['fontSize', 'fontWeight', 'color'],
  },
  {
    name: 'Tool status dot',
    selector: '.listrow .dot',
    appSelector: '.bold-tool-server .dot',
    props: ['width', 'height', 'borderRadius', 'backgroundColor'],
  },
  {
    name: 'Add field',
    selector: '.setmain > .card .field',
    appSelector: '.bold-tool-add .field',
    props: ['minHeight', 'padding', 'borderRadius', 'color', 'backgroundColor'],
  },
  {
    name: 'Add button',
    selector: '.setmain > .card > .row > .btn',
    appSelector: '.bold-tool-add > .btn',
    props: [
      'minHeight',
      'padding',
      'borderRadius',
      'fontSize',
      'fontWeight',
      'color',
      'backgroundColor',
    ],
  },
]

// Look has more real controls than the prototype (match-device, shared look, send key, currency); these are the shared surfaces.
const lookParts = [
  {
    name: 'Section title',
    selector: '.setmain > h2',
    appSelector: '.bold-look > h2',
    props: ['fontSize', 'lineHeight', 'letterSpacing', 'color'],
  },
  {
    name: 'Mode cards',
    selector: '.setmain > .grid3',
    appSelector: '.bold-look-modes',
    props: ['display', 'gap', 'gridTemplateColumns'],
  },
  {
    name: 'Mode card',
    selector: '.grid3 > .agentcard',
    appSelector: '.bold-look-mode',
    props: ['padding', 'borderRadius', 'gap', 'backgroundColor'],
  },
  {
    name: 'Mode preview',
    selector: '.agentcard > span:first-child',
    appSelector: '.bold-look-mode-preview',
    props: ['height', 'padding', 'borderRadius', 'backgroundColor'],
  },
  {
    name: 'Mode label',
    selector: '.agentcard > b',
    appSelector: '.bold-look-mode b',
    props: ['fontSize', 'fontWeight', 'color'],
  },
  {
    name: 'Option card',
    selector: '.grid3 > .card',
    appSelector: '.bold-look-fieldset',
    props: ['padding', 'borderRadius', 'gap', 'backgroundColor'],
  },
  {
    name: 'Segmented control',
    selector: '.grid3 > .card .seg',
    appSelector: '.bold-look-fieldset .seg',
    props: ['display', 'gap', 'padding', 'borderRadius', 'backgroundColor'],
  },
  {
    name: 'Selected option',
    selector: '.grid3 > .card .seg button.on',
    appSelector: '.bold-look-fieldset .seg button.on',
    props: [
      'minHeight',
      'padding',
      'borderRadius',
      'fontSize',
      'fontWeight',
      'color',
      'backgroundColor',
    ],
  },
  {
    name: 'Range',
    selector: '#scale',
    appSelector: '.bold-look-scale input',
    props: ['accentColor', 'height'],
  },
  {
    name: 'Themes card',
    selector: '.setmain > .card:not(.grid3)',
    appSelector: '.bold-look-themes',
    props: ['padding', 'borderRadius', 'gap', 'backgroundColor'],
  },
  {
    name: 'Theme chip',
    selector: '.setmain > .card .chip',
    appSelector: '.bold-look-theme',
    props: [
      'minHeight',
      'padding',
      'borderRadius',
      'fontSize',
      'fontWeight',
      'color',
      'backgroundColor',
    ],
  },
]

async function measure(page, selectedParts = parts, side = 'prototype') {
  return page.evaluate(
    ({ selectedParts, side }) => {
      const result = {}
      for (const part of selectedParts) {
        const selector = side === 'app' ? (part.appSelector ?? part.selector) : part.selector
        const element = globalThis.document.querySelector(selector)
        if (!element) {
          result[part.name] = null
          continue
        }
        const style = globalThis.getComputedStyle(element)
        result[part.name] = Object.fromEntries(
          [...part.props, 'display'].map((property) => [property, style[property]]),
        )
      }
      return result
    },
    { selectedParts, side },
  )
}

function cell(metrics, part) {
  const value = metrics[part.name]
  if (!value) return 'not rendered'
  if (value.display === 'none') return 'hidden'
  return part.props.map((property) => `${property} ${value[property]}`).join(' · ')
}

function difference(prototypeMetrics, appMetrics, part) {
  const left = prototypeMetrics[part.name]
  const right = appMetrics[part.name]
  if (!left || !right)
    return left?.display === 'none' || right?.display === 'none'
      ? 'hidden in both'
      : 'missing on one side'
  const differing = part.props.filter((property) => left[property] !== right[property])
  return differing.length === 0 ? 'same' : differing.join(', ')
}

async function openPrototypeSettings(page, section) {
  await page.goto(prototype, { waitUntil: 'domcontentloaded' })
  await page.locator('.top .word').waitFor()
  await page.locator('[data-a="go"][data-v="settings"]:visible').click()
  await page.locator(`[data-a="setSec"][data-v="${section}"]`).click()
  await page.locator('.setgrid .setnav').waitFor()
  await page.evaluate(() => globalThis.document.fonts.ready)
}

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

    await page.goto(`${baseURL}/b`)
    await page.locator('[data-ui="bold"] .top .word').waitFor({ timeout: 20_000 })
    if (viewport.width > 860) {
      await page.getByRole('group', { name: /Your team/ }).waitFor({ timeout: 20_000 })
      await page.getByRole('complementary', { name: 'Side panel' }).waitFor({ timeout: 20_000 })
    }
    await page.evaluate(() => globalThis.document.fonts.ready)
    await page.screenshot({ path: join(output, `bold-app-${size}.png`) })
    const appMetrics = await measure(page)

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

    await openPrototypeSettings(page, 'connections')
    await page.screenshot({
      path: join(output, `bold-prototype-connections-${size}.png`),
      fullPage: true,
    })
    const prototypeConnectionsMetrics = await measure(page, connectionsParts)

    await page.goto(`${baseURL}/b/settings/connections`)
    await page.locator('[data-ui="bold"] .setgrid .setnav').waitFor({ timeout: 20_000 })
    await page
      .getByRole('heading', { name: 'Connections', exact: true })
      .waitFor({ timeout: 20_000 })
    await page.getByRole('heading', { name: 'Model providers' }).waitFor({ timeout: 20_000 })
    await page.evaluate(() => globalThis.document.fonts.ready)
    await page.screenshot({
      path: join(output, `bold-app-connections-${size}.png`),
      fullPage: true,
    })
    const appConnectionsMetrics = await measure(page, connectionsParts, 'app')

    await openPrototypeSettings(page, 'tools')
    await page.screenshot({
      path: join(output, `bold-prototype-tools-${size}.png`),
      fullPage: true,
    })
    const prototypeToolsMetrics = await measure(page, toolsParts)

    await page.goto(`${baseURL}/b/settings/tools`)
    await page.locator('[data-ui="bold"] .setgrid .setnav').waitFor({ timeout: 20_000 })
    await page.getByRole('heading', { name: 'Tools and triggers' }).waitFor({ timeout: 20_000 })
    await page.getByText('files', { exact: true }).waitFor({ timeout: 20_000 })
    await page.evaluate(() => globalThis.document.fonts.ready)
    await page.screenshot({
      path: join(output, `bold-app-tools-${size}.png`),
      fullPage: true,
    })
    const appToolsMetrics = await measure(page, toolsParts, 'app')

    await openPrototypeSettings(page, 'look')
    await page.screenshot({
      path: join(output, `bold-prototype-look-${size}.png`),
      fullPage: true,
    })
    const prototypeLookMetrics = await measure(page, lookParts)

    // The compare harness has no paired session, but the device look is local: match the prototype's Calm choice.
    await page.evaluate(() => globalThis.localStorage.setItem('score.liveliness', 'calm'))
    await page.goto(`${baseURL}/b/settings/look`)
    await page.locator('[data-ui="bold"] .setgrid .setnav').waitFor({ timeout: 20_000 })
    await page.getByRole('heading', { name: 'Look', exact: true }).waitFor({ timeout: 20_000 })
    await page.getByRole('radiogroup', { name: 'Mode on this device' }).waitFor({ timeout: 20_000 })
    await page.evaluate(() => globalThis.document.fonts.ready)
    await page.screenshot({
      path: join(output, `bold-app-look-${size}.png`),
      fullPage: true,
    })
    const appLookMetrics = await measure(page, lookParts, 'app')

    results[size] = {
      prototype: prototypeMetrics,
      app: appMetrics,
      usage: { prototype: prototypeUsageMetrics, app: appUsageMetrics },
      rules: { prototype: prototypeRulesMetrics, app: appRulesMetrics },
      system: { prototype: prototypeSystemMetrics, app: appSystemMetrics },
      connections: { prototype: prototypeConnectionsMetrics, app: appConnectionsMetrics },
      tools: { prototype: prototypeToolsMetrics, app: appToolsMetrics },
      look: { prototype: prototypeLookMetrics, app: appLookMetrics },
    }
  }

  writeFileSync(join(output, 'bold-frame-metrics.json'), `${JSON.stringify(results, null, 2)}\n`)

  const lines = ['# Bold frame: prototype vs app', '']
  for (const size of Object.keys(results)) {
    lines.push(`## ${size}px`, '', '| Part | Prototype | App | Difference |', '|---|---|---|---|')
    for (const part of parts)
      lines.push(
        `| ${part.name} | ${cell(results[size].prototype, part)} | ${cell(results[size].app, part)} | ${difference(results[size].prototype, results[size].app, part)} |`,
      )
    lines.push('')
  }
  writeFileSync(join(output, 'bold-frame-metrics.md'), `${lines.join('\n')}\n`)

  const usageLines = ['# Bold usage: prototype vs app', '']
  for (const size of Object.keys(results)) {
    usageLines.push(
      `## ${size}px`,
      '',
      '| Part | Prototype | App | Difference |',
      '|---|---|---|---|',
    )
    for (const part of usageParts)
      usageLines.push(
        `| ${part.name} | ${cell(results[size].usage.prototype, part)} | ${cell(results[size].usage.app, part)} | ${difference(results[size].usage.prototype, results[size].usage.app, part)} |`,
      )
    usageLines.push('')
  }
  writeFileSync(join(output, 'bold-usage-metrics.md'), `${usageLines.join('\n')}\n`)

  for (const [name, title, sectionParts] of [
    ['rules', 'Bold rules', rulesParts],
    ['system', 'Bold system', systemParts],
    ['connections', 'Bold connections', connectionsParts],
    ['tools', 'Bold tools and triggers', toolsParts],
    ['look', 'Bold look', lookParts],
  ]) {
    const sectionLines = [`# ${title}: prototype vs app`, '']
    for (const size of Object.keys(results)) {
      sectionLines.push(
        `## ${size}px`,
        '',
        '| Part | Prototype | App | Difference |',
        '|---|---|---|---|',
      )
      for (const part of sectionParts)
        sectionLines.push(
          `| ${part.name} | ${cell(results[size][name].prototype, part)} | ${cell(results[size][name].app, part)} | ${difference(results[size][name].prototype, results[size][name].app, part)} |`,
        )
      sectionLines.push('')
    }
    writeFileSync(join(output, `bold-${name}-metrics.md`), `${sectionLines.join('\n')}\n`)
  }
  console.log(`Wrote screenshots and measurements to ${output}`)
} finally {
  await browser?.close()
}
