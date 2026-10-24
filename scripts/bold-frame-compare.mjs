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

const searchRoom = {
  id: 'team-room',
  name: 'Team room',
  kind: 'room',
  leadAgentId: 'lead',
  members: ['lead', 'builder', 'reviewer', 'designer'],
  unread: 0,
  activeAgents: [],
  channels: [],
  role: 'team',
  routing: 'exchanges',
}

const searchJob = (id, roomId, title, extra = {}) => ({
  id,
  roomId,
  title,
  state: 'working',
  holderAgentId: 'builder',
  isDefault: false,
  exchangeBudget: 8,
  jobTurnLimit: 40,
  unread: 0,
  activeAgents: [],
  lastMessageAt: null,
  messageCount: 0,
  summary: null,
  createdAt: '2026-10-24T10:00:00.000Z',
  updatedAt: '2026-10-24T10:00:00.000Z',
  ...extra,
})

// PLAN 11.10f: representative search rows, so the comparison exercises every prototype group without a server.
const searchFixtures = {
  '/api/team-room': {
    asOfSeq: 1,
    room: searchRoom,
    jobs: [
      searchJob('job-activity', 'team-room', 'Activity feed', { unread: 2 }),
      searchJob('job-release', 'team-room', 'Release notes 2.4', { state: 'done' }),
      searchJob('job-queue', 'team-room', 'Queue research', { state: 'closed' }),
    ],
  },
  '/api/agents/builder/direct': {
    asOfSeq: 1,
    room: null,
    chats: [
      searchJob('chat-cursor', 'direct-builder', 'The cursor bug', {
        summary: 'Why the cursor jumps',
      }),
      searchJob('chat-socket', 'direct-builder', 'Websockets or server-sent events', {
        summary: 'One connection for the feed',
      }),
    ],
  },
  ...Object.fromEntries(
    ['lead', 'reviewer', 'designer'].map((id) => [
      `/api/agents/${id}/direct`,
      { asOfSeq: 1, room: null, chats: [] },
    ]),
  ),
  '/api/knowledge/tree': {
    folders: ['Decisions', 'Projects'],
    documents: [],
    notes: [
      {
        path: 'Decisions/Event-cursors.md',
        title: 'Event cursors',
        mtime: '2026-10-24T09:00:00.000Z',
        lastAuthor: { agentId: 'reviewer' },
      },
      {
        path: 'Projects/Roadmap.md',
        title: 'Roadmap',
        mtime: '2026-10-23T09:00:00.000Z',
        lastAuthor: { agentId: 'lead' },
      },
      {
        path: 'Decisions/Websockets.md',
        title: 'Websockets vs SSE',
        mtime: '2026-10-22T09:00:00.000Z',
        lastAuthor: { agentId: 'builder' },
      },
    ],
  },
  '/api/knowledge/search': {
    items: [
      {
        path: 'Decisions/Event-cursors.md',
        title: 'Event cursors',
        kind: 'note',
        type: null,
        snippet: 'Page task events by (created_at, id), never by a [[cursor]] alone.',
      },
    ],
  },
  '/api/search/messages': {
    items: [
      {
        messageId: 'message-cursor',
        roomId: 'team-room',
        roomName: 'Team room',
        jobId: 'job-activity',
        author: { kind: 'agent', agentId: 'reviewer' },
        createdAt: '2026-10-24T10:00:00.000Z',
        snippet: 'Make the [[cursor]] (created_at, id) and add a test.',
      },
    ],
  },
  '/api/commands': {
    items: [
      { name: 'assign', usage: '/assign @agent <title>', description: 'Create a task.' },
      { name: 'model', usage: '/model <model> <message>', description: 'Use a model.' },
    ],
  },
  // PLAN 11.10c: the Start a job dialog reads these before it can show an honest checklist.
  '/api/workflows': {
    items: [],
    inventory: {
      definitions: 0,
      versions: 0,
      bytes: 0,
      maxDefinitions: 200,
      maxVersionsPerDefinition: 20,
    },
  },
  '/api/orchestrations/preflight': {
    ok: true,
    checks: [
      { id: 'listener', status: 'ok', message: 'Hermes is reachable' },
      { id: 'lead_ready', status: 'ok', message: 'lead is free' },
      { id: 'allowed_agents', status: 'ok', message: 'builder, reviewer and designer are free' },
    ],
    workers: [],
    gatePolicyNotes: {
      'every-step': 'Every step waits for you.',
      'lead-asks': 'The lead asks when it is unsure.',
      none: 'The run does not stop for approval.',
    },
    acknowledgementText:
      "Score controls the work it starts (exchanges and steps) and can stop those runs; agents may still use other tools and start background work Score can't see or stop.",
    defaults: {
      maxSteps: 12,
      maxLeadTurns: 20,
      maxConcurrentSteps: 2,
      leadTurnEstimateUsd: 0.25,
      stepEstimateUsd: 0.5,
      codingSteps: 10,
    },
    reserveBytes: 0,
  },
}

async function serve(route) {
  const url = new URL(route.request().url())
  if (url.pathname.startsWith('/api/')) {
    if (url.pathname === '/api/stream') return route.fulfill({ status: 204 })
    const searchFixture = searchFixtures[url.pathname]
    if (searchFixture)
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(searchFixture),
      })
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

// PLAN 11.10f: the prototype's vSearch/searchList and the app's BoldSearch use different class names, so each side
// gets its own selector while the part names and measured properties stay aligned.
const searchPrototypeParts = [
  {
    name: 'Scrim',
    selector: '.scrim',
    props: ['position', 'inset', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'],
  },
  {
    name: 'Dialog',
    selector: '.scrim .dialog',
    props: ['width', 'maxWidth', 'borderRadius', 'padding', 'gap', 'overflow', 'backgroundColor'],
  },
  {
    name: 'Head',
    selector: '.scrim .dialog > .row',
    props: ['padding', 'gap', 'borderBottomColor'],
  },
  { name: 'Input', selector: '#sq', props: ['fontSize', 'color', 'backgroundColor'] },
  {
    name: 'List',
    selector: '#sres',
    props: ['padding', 'gap', 'maxHeight', 'overflowY', 'backgroundColor'],
  },
  {
    name: 'Section',
    selector: '#sres .sec',
    props: ['padding', 'fontSize', 'fontWeight', 'color'],
  },
  {
    name: 'Result',
    selector: '#sres .mi',
    props: ['minHeight', 'padding', 'borderRadius', 'gap', 'backgroundColor'],
  },
]

const searchAppParts = [
  {
    name: 'Scrim',
    selector: '.bold-search-scrim',
    props: ['position', 'inset', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'],
  },
  {
    name: 'Dialog',
    selector: '.bold-search-dialog',
    props: ['width', 'maxWidth', 'borderRadius', 'padding', 'gap', 'overflow', 'backgroundColor'],
  },
  {
    name: 'Head',
    selector: '.bold-search-head',
    props: ['padding', 'gap', 'borderBottomColor'],
  },
  {
    name: 'Input',
    selector: '.bold-search-head input',
    props: ['fontSize', 'color', 'backgroundColor'],
  },
  {
    name: 'List',
    selector: '.bold-search-list',
    props: ['padding', 'gap', 'maxHeight', 'overflowY', 'backgroundColor'],
  },
  {
    name: 'Section',
    selector: '.bold-search-section',
    props: ['padding', 'fontSize', 'fontWeight', 'color'],
  },
  {
    name: 'Result',
    selector: '.bold-search-result',
    props: ['minHeight', 'padding', 'borderRadius', 'gap', 'backgroundColor'],
  },
]

// PLAN 11.10c: the prototype's mStart modal and the app's BoldStartJob. The part names line up even though the
// selectors do not.
const startPrototypeParts = [
  {
    name: 'Scrim',
    selector: '.scrim',
    props: ['position', 'inset', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'],
  },
  {
    name: 'Dialog',
    selector: '.scrim .dialog',
    props: ['width', 'maxWidth', 'borderRadius', 'padding', 'gap', 'overflow', 'backgroundColor'],
  },
  {
    name: 'Title',
    selector: '.scrim .dialog h2',
    props: ['fontSize', 'fontWeight', 'letterSpacing', 'color'],
  },
  {
    name: 'Label',
    selector: '.scrim .dialog .lab',
    props: ['display', 'marginBottom', 'fontSize', 'fontWeight', 'color'],
  },
  {
    name: 'What field',
    selector: '#sjwhat',
    props: ['minHeight', 'padding', 'borderRadius', 'fontSize', 'color', 'backgroundColor'],
  },
  {
    name: 'Recipe chip',
    selector: '.scrim .dialog .chip',
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
    name: 'When grid',
    selector: '.scrim .dialog .grid3',
    props: ['display', 'gap', 'gridTemplateColumns'],
  },
  {
    name: 'When section',
    selector: '.scrim .dialog .grid3 .inner',
    props: ['padding', 'borderRadius', 'gap', 'backgroundColor'],
  },
  {
    name: 'Checklist',
    selector: '.scrim .dialog > .inner',
    props: ['padding', 'borderRadius', 'gap', 'flexDirection', 'backgroundColor'],
  },
  {
    name: 'Actions',
    selector: '.scrim .dialog > .row.wrap',
    props: ['display', 'paddingTop', 'gap', 'borderTopWidth', 'borderTopColor'],
  },
]

const startAppParts = [
  {
    name: 'Scrim',
    selector: '.bold-start-scrim',
    props: ['position', 'inset', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'],
  },
  {
    name: 'Dialog',
    selector: '.bold-start-dialog',
    props: ['width', 'maxWidth', 'borderRadius', 'padding', 'gap', 'overflow', 'backgroundColor'],
  },
  {
    name: 'Title',
    selector: '.start-title',
    props: ['fontSize', 'fontWeight', 'letterSpacing', 'color'],
  },
  {
    name: 'Label',
    selector: '.bold-start-dialog .lab',
    props: ['display', 'marginBottom', 'fontSize', 'fontWeight', 'color'],
  },
  {
    name: 'What field',
    selector: '.start-what',
    props: ['minHeight', 'padding', 'borderRadius', 'fontSize', 'color', 'backgroundColor'],
  },
  {
    name: 'Recipe chip',
    selector: '.bold-start-dialog .chip',
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
    name: 'When grid',
    selector: '.bold-start-dialog .grid3',
    props: ['display', 'gap', 'gridTemplateColumns'],
  },
  {
    name: 'When section',
    selector: '.bold-start-dialog .grid3 .inner',
    props: ['padding', 'borderRadius', 'gap', 'backgroundColor'],
  },
  {
    name: 'Checklist',
    selector: '.start-checks',
    props: ['padding', 'borderRadius', 'gap', 'flexDirection', 'backgroundColor'],
  },
  {
    name: 'Actions',
    selector: '.start-actions',
    props: ['display', 'paddingTop', 'gap', 'borderTopWidth', 'borderTopColor'],
  },
]

async function measure(page, selectedParts = parts) {
  return page.evaluate((selectedParts) => {
    const result = {}
    for (const part of selectedParts) {
      const element = globalThis.document.querySelector(part.selector)
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
  }, selectedParts)
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

    await page.goto(prototype, { waitUntil: 'domcontentloaded' })
    await page.locator('.top .word').waitFor()
    await page.locator('[data-a="startJob"]:visible').first().click()
    const prototypeStart = page.locator('.scrim .dialog[aria-label="Start a job"]')
    await prototypeStart.waitFor()
    await page.evaluate(() => globalThis.document.fonts.ready)
    await page.screenshot({ path: join(output, `bold-prototype-start-${size}.png`) })
    const prototypeStartMetrics = await measure(page, startPrototypeParts)

    await page.goto(`${baseURL}/b?start=job`)
    await page.locator('.bold-start-dialog').waitFor({ timeout: 20_000 })
    await page.evaluate(() => globalThis.document.fonts.ready)
    await page.screenshot({ path: join(output, `bold-app-start-${size}.png`) })
    const appStartMetrics = await measure(page, startAppParts)

    results[size] = {
      prototype: prototypeMetrics,
      app: appMetrics,
      search: { prototype: prototypeSearchMetrics, app: appSearchMetrics },
      usage: { prototype: prototypeUsageMetrics, app: appUsageMetrics },
      start: { prototype: prototypeStartMetrics, app: appStartMetrics },
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

  const searchLines = ['# Bold search: prototype vs app', '']
  for (const size of Object.keys(results)) {
    searchLines.push(
      `## ${size}px`,
      '',
      '| Part | Prototype | App | Difference |',
      '|---|---|---|---|',
    )
    for (const part of searchPrototypeParts)
      searchLines.push(
        `| ${part.name} | ${cell(results[size].search.prototype, part)} | ${cell(results[size].search.app, part)} | ${difference(results[size].search.prototype, results[size].search.app, part)} |`,
      )
    searchLines.push('')
  }
  writeFileSync(join(output, 'bold-search-metrics.md'), `${searchLines.join('\n')}\n`)

  const startLines = ['# Bold start a job: prototype vs app', '']
  for (const size of Object.keys(results)) {
    startLines.push(
      `## ${size}px`,
      '',
      '| Part | Prototype | App | Difference |',
      '|---|---|---|---|',
    )
    for (const part of startPrototypeParts)
      startLines.push(
        `| ${part.name} | ${cell(results[size].start.prototype, part)} | ${cell(results[size].start.app, part)} | ${difference(results[size].start.prototype, results[size].start.app, part)} |`,
      )
    startLines.push('')
  }
  writeFileSync(join(output, 'bold-start-metrics.md'), `${startLines.join('\n')}\n`)
  console.log(`Wrote screenshots and measurements to ${output}`)
} finally {
  await browser?.close()
}
