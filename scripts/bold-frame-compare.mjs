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
const recipeDefinition = {
  name: 'Build, then review',
  description: 'Build it, review it, then ask before merging.',
  inputs: [{ name: 'goal', label: 'Goal', required: true, maxChars: 500 }],
  nodes: [
    {
      id: 'step1',
      kind: 'agent',
      label: 'Build it',
      agentId: 'builder',
      instruction: 'Build {{inputs.goal}}. Small, tested changes.',
      retries: 1,
      onFailure: 'route',
    },
    {
      id: 'step2',
      kind: 'agent',
      label: 'Review it',
      agentId: 'reviewer',
      instruction: 'Review the change from {{nodes.step1.output}}. End with a verdict.',
      retries: 0,
      onFailure: 'fail_run',
    },
    {
      id: 'branch1',
      kind: 'branch',
      label: 'Passed?',
      subject: 'step2',
      rules: [{ id: 'rule1', when: { kind: 'verdict', is: 'passed' } }],
    },
    {
      id: 'gate1',
      kind: 'gate',
      label: 'Your OK before merging',
      question: 'Merge it?',
      onReject: 'stop_run',
    },
    { id: 'end1', kind: 'end', label: 'Done' },
  ],
  edges: [
    { id: 'e1', from: 'step1', port: 'ok', to: 'step2' },
    { id: 'e2', from: 'step1', port: 'failed', to: 'step2' },
    { id: 'e3', from: 'step2', port: 'ok', to: 'branch1' },
    { id: 'e4', from: 'branch1', port: 'rule1', to: 'gate1' },
    { id: 'e5', from: 'branch1', port: 'default', to: 'end1' },
    { id: 'e6', from: 'gate1', port: 'ok', to: 'end1' },
  ],
}
const recipeVersion = {
  version: 3,
  hash: 'a'.repeat(64),
  createdAt: '2026-10-08T20:00:00.000Z',
  used: false,
  bytes: JSON.stringify(recipeDefinition).length,
  nodes: recipeDefinition.nodes.length,
  maxSteps: 3,
  workflowId: 'wf-recipe',
  definition: recipeDefinition,
}
const recipeSummary = {
  id: 'wf-recipe',
  name: recipeDefinition.name,
  description: recipeDefinition.description,
  latestVersion: 3,
  versionCount: 3,
  used: false,
  agentIds: ['builder', 'reviewer'],
  createdAt: '2026-10-08T20:00:00.000Z',
  updatedAt: '2026-10-08T20:30:00.000Z',
  activeRuns: 0,
}
const recipeFixtures = {
  '/api/workflows': {
    items: [recipeSummary],
    inventory: {
      definitions: 1,
      versions: 3,
      bytes: recipeVersion.bytes * 3,
      maxDefinitions: 200,
      maxVersionsPerDefinition: 20,
    },
  },
  '/api/workflows/wf-recipe': {
    ...recipeSummary,
    versions: [1, 2, 3].map((version) => ({ ...recipeVersion, version })),
    latest: recipeVersion,
  },
  '/api/workflows/wf-recipe/versions/3': recipeVersion,
  '/api/workflows/validate': {
    ok: true,
    stats: { nodes: 5, edges: 6, maxSteps: 3, bytes: 900 },
    issues: [],
  },
}
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
      recipeFixtures[url.pathname] ??
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

// PLAN 11.10d: the recipe dialog. The app's class names are prefixed, so each row names both selectors.
const recipeParts = [
  {
    name: 'Recipe dialog',
    selectors: { prototype: '.dialog.wide', app: '.bold-dialog.wide' },
    props: ['width', 'maxWidth', 'padding', 'gap', 'borderRadius', 'backgroundColor', 'boxShadow'],
  },
  {
    name: 'Recipe switcher',
    selectors: { prototype: '.seg', app: '.bold-seg' },
    props: ['display', 'gap', 'padding', 'borderRadius', 'backgroundColor'],
  },
  {
    name: 'Selected recipe',
    selectors: { prototype: '.seg button.on', app: '.bold-seg button.on' },
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
    name: 'Problems badge',
    selectors: { prototype: '.badge', app: '.bold-badge' },
    props: ['padding', 'borderRadius', 'fontSize', 'fontWeight', 'color', 'backgroundColor'],
  },
  {
    name: 'Step',
    selectors: { prototype: '.step', app: '.bold-step' },
    props: ['minHeight', 'padding', 'gap', 'borderRadius', 'color', 'backgroundColor'],
  },
  {
    name: 'Selected step',
    selectors: { prototype: '.step.sel', app: '.bold-step.sel' },
    props: ['boxShadow', 'backgroundColor'],
  },
  {
    name: 'Inspector',
    selectors: { prototype: '.inner', app: '.bold-recipes-inspector' },
    props: ['padding', 'gap', 'borderRadius', 'backgroundColor'],
  },
  {
    name: 'Field',
    selectors: { prototype: '.field', app: '.bold-recipes-inspector .orch-field select' },
    props: ['minHeight', 'padding', 'borderRadius', 'color', 'backgroundColor'],
  },
  {
    name: 'Save',
    selectors: { prototype: '.btn.sm.primary', app: '.bold-recipes-actions .btn.primary' },
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
        const element = globalThis.document.querySelector(part.selectors?.[side] ?? part.selector)
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
      usage: { prototype: prototypeUsageMetrics, app: appUsageMetrics },
      recipes: { prototype: prototypeRecipeMetrics, app: appRecipeMetrics },
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

  const recipeLines = ['# Bold recipes: prototype vs app', '']
  for (const size of Object.keys(results)) {
    recipeLines.push(
      `## ${size}px`,
      '',
      '| Part | Prototype | App | Difference |',
      '|---|---|---|---|',
    )
    for (const part of recipeParts)
      recipeLines.push(
        `| ${part.name} | ${cell(results[size].recipes.prototype, part)} | ${cell(results[size].recipes.app, part)} | ${difference(results[size].recipes.prototype, results[size].recipes.app, part)} |`,
      )
    recipeLines.push('')
  }
  writeFileSync(join(output, 'bold-recipes-metrics.md'), `${recipeLines.join('\n')}\n`)
  console.log(`Wrote screenshots and measurements to ${output}`)
} finally {
  await browser?.close()
}
