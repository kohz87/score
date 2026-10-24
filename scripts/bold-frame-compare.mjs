// Side-by-side check for the bold shell (not part of `pnpm e2e`): screenshots the binding prototype and the app at the
// two review sizes, then compares computed values. It covers the frame (11.3a) and Add an agent (11.8c). Run
// `pnpm build` first, then `node scripts/bold-frame-compare.mjs`.
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
    const fixture = fixtures[`${url.pathname}${url.search}`] ?? fixtures[url.pathname]
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

// PLAN 11.8c. The prototype spells every input with its own id, while the app uses the shared `.field` class.
const addParts = [
  {
    name: 'Add dialog',
    selector: '.dialog[aria-label="Add an agent"]',
    appSelector: '.bold-add-dialog',
    props: [
      'fontSize',
      'width',
      'maxWidth',
      'height',
      'padding',
      'borderRadius',
      'gap',
      'backgroundColor',
      'boxShadow',
    ],
  },
  {
    name: 'Add heading',
    selector: '.dialog[aria-label="Add an agent"] h2',
    appSelector: '.bold-add-head h2',
    props: ['fontSize', 'fontWeight', 'letterSpacing', 'lineHeight', 'color'],
  },
  {
    name: 'Start segment',
    selector: '.dialog[aria-label="Add an agent"] .seg',
    appSelector: '.bold-add-from',
    props: ['display', 'gap', 'padding', 'borderRadius', 'backgroundColor'],
  },
  {
    name: 'Start choice',
    selector: '.dialog[aria-label="Add an agent"] .seg button',
    appSelector: '.bold-add-from button',
    props: [
      'fontSize',
      'minHeight',
      'padding',
      'borderRadius',
      'fontWeight',
      'color',
      'backgroundColor',
    ],
  },
  {
    name: 'Appearance',
    selector: '.dialog[aria-label="Add an agent"] .row.wrap > div:first-child',
    appSelector: '.bold-add-appearance',
    props: ['width', 'gap', 'alignItems'],
  },
  {
    name: 'Preview mark',
    selector: '.dialog[aria-label="Add an agent"] .row.wrap > div:first-child > svg',
    appSelector: '.bold-add-preview .agent-glyph',
    props: ['width', 'height'],
  },
  {
    name: 'Shape choice',
    selector: '.dialog[aria-label="Add an agent"] button[data-a="addShape"]',
    appSelector: '.bold-add-shapes button',
    props: ['width', 'height', 'borderRadius', 'backgroundColor'],
  },
  {
    name: 'Colour choice',
    selector: '.dialog[aria-label="Add an agent"] button[data-a="addColor"]',
    appSelector: '.bold-add-colours button',
    props: ['width', 'height', 'borderRadius', 'opacity'],
  },
  {
    name: 'Fields column',
    selector: '.dialog[aria-label="Add an agent"] .row.wrap > div:last-child',
    appSelector: '.bold-add-fields',
    props: ['width', 'minWidth', 'gap'],
  },
  {
    name: 'Name field',
    selector: '.dialog[aria-label="Add an agent"] #anname',
    appSelector: '.bold-add-name',
    props: ['fontSize', 'minHeight', 'padding', 'borderRadius', 'backgroundColor'],
  },
  {
    name: 'Description field',
    selector: '.dialog[aria-label="Add an agent"] #anrole',
    appSelector: '.bold-add-fields textarea',
    props: ['minHeight', 'padding', 'borderRadius', 'backgroundColor'],
  },
  {
    name: 'Works on field',
    selector: '.dialog[aria-label="Add an agent"] #anwhere',
    appSelector: '.bold-add-works select',
    props: ['minHeight', 'padding', 'borderRadius', 'backgroundColor'],
  },
  {
    name: 'Footer',
    selector: '.dialog[aria-label="Add an agent"] > .row:last-child',
    appSelector: '.bold-add-footer',
    props: ['height', 'gap', 'paddingTop', 'borderTopColor', 'justifyContent', 'alignItems'],
  },
  {
    name: 'Close',
    selector: '.dialog[aria-label="Add an agent"] .icon-btn',
    appSelector: '.bold-add-head .icon-btn',
    props: ['width', 'height', 'borderRadius', 'backgroundColor'],
  },
]

async function measure(page, measured = parts, app = false) {
  return page.evaluate(
    ({ parts, app }) => {
      const result = {}
      for (const part of parts) {
        const selector = app ? (part.appSelector ?? part.selector) : part.selector
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
    { parts: measured, app },
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
    await page.locator('button[data-a="go"][data-v="team"]:visible').first().click()
    await page.locator('button[data-a="addAgent"]:visible').click()
    await page.getByRole('dialog', { name: 'Add an agent' }).waitFor()
    await page.evaluate(() => globalThis.document.fonts.ready)
    await page.screenshot({ path: join(output, `bold-prototype-add-${size}.png`) })
    const addPrototypeMetrics = await measure(page, addParts)

    await page.goto(`${baseURL}/b/team?add=agent`)
    await page.locator('[data-ui="bold"] .bold-add-dialog').waitFor({ timeout: 20_000 })
    await page.evaluate(() => globalThis.document.fonts.ready)
    await page.screenshot({ path: join(output, `bold-app-add-${size}.png`) })
    const addAppMetrics = await measure(page, addParts, true)

    results[size] = {
      prototype: prototypeMetrics,
      app: appMetrics,
      add: { prototype: addPrototypeMetrics, app: addAppMetrics },
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
    lines.push(
      '### Add an agent',
      '',
      '| Part | Prototype | App | Difference |',
      '|---|---|---|---|',
    )
    for (const part of addParts)
      lines.push(
        `| ${part.name} | ${cell(results[size].add.prototype, part)} | ${cell(results[size].add.app, part)} | ${difference(results[size].add.prototype, results[size].add.app, part)} |`,
      )
    lines.push('')
  }
  writeFileSync(join(output, 'bold-frame-metrics.md'), `${lines.join('\n')}\n`)
  console.log(`Wrote screenshots and measurements to ${output}`)
} finally {
  await browser?.close()
}
