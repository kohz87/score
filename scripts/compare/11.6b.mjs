// Side-by-side check for PLAN 11.6b (not part of `pnpm e2e`): screenshots the binding prototype and the built app at
// the two review sizes, compares the Workbench and the agent's screen, and checks the seeded content without a server.
// Run `pnpm build` first, then `node scripts/compare/11.6b.mjs`.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from '@playwright/test'

const root = resolve(new URL('../..', import.meta.url).pathname)
const output = join(root, 'test-results')
const dist = join(root, 'apps/web/dist')
const baseURL = 'http://score.local'
const prototype = pathToFileURL(join(root, 'docs/design/bold/prototype.html')).href

if (!existsSync(join(dist, 'index.html'))) {
  console.error('Score is not built. Run `pnpm build`, then try again.')
  process.exit(1)
}
mkdirSync(output, { recursive: true })

const agent = (id, role, color, shape, status, activity = null) => ({
  id,
  name: id,
  role,
  style: { color, shape },
  status,
  activity,
  model: { id: 'fake-model', label: 'Demo model' },
  served: true,
})

const builder = agent(
  'builder',
  'Builds features',
  '#19C39A',
  'triangle',
  'waiting',
  'Waiting for your OK',
)
const reviewer = agent('reviewer', 'Reviews changes', '#FFB61E', 'diamond', 'idle')
const designer = agent('designer', 'Designs interfaces', '#FF6B8A', 'square', 'idle')
const lead = agent('lead', 'Leads the team', '#6B4EFF', 'circle-dot', 'idle')
const agents = [lead, builder, reviewer, designer]

const room = {
  id: 'team-room',
  name: 'Team room',
  kind: 'room',
  leadAgentId: 'lead',
  members: ['lead', 'builder', 'reviewer', 'designer'],
  unread: 0,
  activeAgents: ['builder'],
  channels: [],
  role: 'team',
  routing: 'exchanges',
}

const job = {
  id: 'job-feed',
  roomId: room.id,
  title: 'Activity feed',
  state: 'working',
  holderAgentId: 'builder',
  isDefault: false,
  exchangeBudget: 8,
  jobTurnLimit: 40,
  spendCapUsd: null,
  recipe: null,
  unread: 0,
  activeAgents: ['builder'],
  lastMessageAt: '2026-10-24T10:05:00.000Z',
  messageCount: 4,
  summary: null,
  source: null,
  reportBack: null,
  createdAt: '2026-10-24T09:00:00.000Z',
  updatedAt: '2026-10-24T10:05:00.000Z',
}

const screenFrame = {
  seq: 12,
  at: '2026-10-24T10:05:00.000Z',
  agentId: 'builder',
  runId: 'run-feed',
  surface: 'terminal',
  terminal: {
    cwd: '~/app',
    command: 'pnpm test api/events',
    output:
      'ok  pages newest first\nok  keeps same-millisecond events\nwaiting  for your OK to install ws@8',
    status: 'running',
  },
  caption: 'Ran pnpm test api/events',
}

const workbench = {
  asOfSeq: 12,
  files: [
    {
      path: 'api/events.py',
      language: 'python',
      exact: false,
      lines: [
        { n: 1, text: 'PAGE_SIZE = 50', by: 'builder' },
        { n: 2, text: '', by: 'builder' },
        { n: 3, text: 'def page(after):', by: 'builder' },
        { n: 4, text: '    # (created_at, id): both events come through.', by: 'builder' },
        { n: 5, text: '    rows = db.events.where(cursor__gt=after)', by: 'builder' },
        { n: 6, text: '    return rows[:PAGE_SIZE]', by: 'builder' },
        { n: 7, text: '', by: 'builder' },
        { n: 8, text: 'def newest():', by: 'builder' },
        { n: 9, text: '    return page(after=None)', by: 'builder' },
      ],
      cursors: [{ agentId: 'builder', line: 9, at: '2026-10-24T10:04:00.000Z' }],
      comments: [
        {
          id: 'note-send-back',
          by: 'reviewer',
          line: null,
          originalLine: 5,
          text: 'Two events in one millisecond: the second is skipped.',
          outdated: true,
          exchangeId: 'exchange-1',
          kind: 'send_back',
          at: '2026-10-24T09:15:00.000Z',
        },
        {
          id: 'note-approve',
          by: 'reviewer',
          line: 9,
          originalLine: 9,
          text: 'Nice: the page size is one constant.',
          outdated: false,
          exchangeId: 'exchange-2',
          kind: 'approve',
          at: '2026-10-24T09:20:00.000Z',
        },
      ],
      editedBy: ['builder'],
      lastEditAt: '2026-10-24T09:10:00.000Z',
    },
    {
      path: 'api/test_events.py',
      language: 'python',
      exact: true,
      lines: [{ n: 1, text: 'def test_same_millisecond():', by: 'builder' }],
      cursors: [],
      comments: [],
      editedBy: ['builder'],
      lastEditAt: '2026-10-24T09:10:00.000Z',
    },
  ],
  looseComments: [],
  drafts: [],
  screens: [{ live: true, frame: screenFrame }],
}

const approval = {
  id: 'approval-ws',
  origin: 'score-run',
  phase: 'human_pending',
  status: 'pending',
  actionable: true,
  linkedTo: null,
  agentId: 'builder',
  title: 'May I install a package?',
  command: 'npm install ws@8',
  cwd: '~/app',
  description: 'The websocket feed needs it.',
  choices: ['once', 'deny'],
  createdAt: '2026-10-24T09:17:00.000Z',
  expiresAt: null,
  decision: null,
  delivery: 'none',
  blocking: 'Only this command is waiting.',
  refs: [],
}

const frames = [
  {
    seq: 1,
    at: '2026-10-24T09:08:00.000Z',
    agentId: 'builder',
    runId: 'run-feed',
    surface: 'terminal',
    terminal: { cwd: '~/app', command: 'ls', output: 'api  tests', status: 'ok' },
    caption: 'Listed the files',
  },
  {
    seq: 2,
    at: '2026-10-24T09:14:00.000Z',
    agentId: 'builder',
    runId: 'run-feed',
    surface: 'browser',
    browser: { url: 'http://localhost:5173/feed', title: 'Activity feed', imageUrl: null },
    caption: 'Opened the activity feed',
  },
  screenFrame,
]

const watch = {
  asOfSeq: 12,
  agent: builder,
  live: true,
  sessionId: 'session-feed',
  frames,
  markers: [
    { seq: 1, at: '2026-10-24T09:08:00.000Z', kind: 'command' },
    { seq: 2, at: '2026-10-24T09:14:00.000Z', kind: 'browser' },
    { seq: 12, at: '2026-10-24T10:05:00.000Z', kind: 'command' },
  ],
  gaps: [],
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
    let body
    if (url.pathname === '/api/agents') body = { asOfSeq: 12, items: agents }
    else if (url.pathname === '/api/team-room') body = { asOfSeq: 12, room, jobs: [job] }
    else if (url.pathname === '/api/jobs/job-feed/workbench') body = workbench
    else if (url.pathname === '/api/agents/builder/watch') body = watch
    else if (url.pathname === '/api/approvals')
      body = { asOfSeq: 12, items: [approval], nextCursor: null }
    else if (url.pathname === '/api/watch/overview') body = { asOfSeq: 12, items: [] }
    else if (url.pathname === '/api/system')
      body = {
        mode: 'fake',
        hermes: {
          version: null,
          reachable: true,
          apiServer: true,
          capabilities: [],
          servedProfiles: ['builder'],
        },
        bridge: { producers: 0, lastSeenAt: null, isolation: 'unknown' },
        compatibility: { fingerprint: 'fake', tested: true, disabled: [] },
        agentIsolation: 'same_user',
        degraded: [],
      }
    else body = { asOfSeq: 0, items: [], rooms: [], directs: [], projects: [] }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
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

const codeParts = [
  {
    name: 'Panel',
    selectors: { prototype: '.side', app: '.bold-workbench' },
    props: ['width', 'padding', 'borderRadius', 'backgroundColor'],
  },
  {
    name: 'Tabs',
    selectors: { prototype: '.tabs', app: '.bold-bench-tabs' },
    props: ['display', 'gap', 'flexWrap'],
  },
  {
    name: 'Tab',
    selectors: { prototype: '.tabs .chip', app: '.bold-bench-tab' },
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
    name: 'Code surface',
    selectors: { prototype: '.code', app: '.bold-bench-code' },
    props: [
      'fontFamily',
      'fontSize',
      'lineHeight',
      'paddingTop',
      'paddingBottom',
      'borderRadius',
      'backgroundColor',
    ],
  },
  {
    name: 'Line',
    selectors: { prototype: '.code .ln', app: '.bold-bench-line' },
    props: ['display', 'minHeight', 'color'],
  },
  {
    name: 'Line number',
    selectors: { prototype: '.code .no', app: '.bold-bench-no' },
    props: ['width', 'paddingRight', 'color', 'fontSize'],
  },
  {
    name: 'Colour bar',
    selectors: { prototype: '.code .bar', app: '.bold-bench-bar' },
    props: ['width', 'backgroundColor'],
  },
  {
    name: 'Line text',
    selectors: { prototype: '.code .tx', app: '.bold-bench-tx' },
    props: ['paddingLeft', 'paddingRight'],
  },
]

const screenParts = [
  {
    name: 'Panel',
    selectors: { prototype: '.side', app: '.bold-workbench' },
    props: ['width', 'padding', 'borderRadius', 'backgroundColor'],
  },
  {
    name: 'Screen head',
    selectors: { prototype: '.sidebody .row.small', app: '.bold-bench-screen-head' },
    props: ['fontSize', 'color', 'gap'],
  },
  {
    name: 'Screen frame',
    selectors: { prototype: '.sidebody .term', app: '.bold-bench-screen-frame' },
    props: [
      'minHeight',
      'height',
      'borderRadius',
      'padding',
      'fontFamily',
      'fontSize',
      'backgroundColor',
    ],
  },
]

const replayParts = [
  {
    name: 'Page',
    selectors: { prototype: '.page', app: '.bold-screen' },
    props: ['padding', 'gap', 'color'],
  },
  {
    name: 'Steps list',
    selectors: { prototype: '.page ol', app: '.bold-screen-steps' },
    props: ['display', 'flexDirection', 'gap', 'maxWidth', 'padding'],
  },
  {
    name: 'Step',
    selectors: { prototype: '.page .step', app: '.bold-screen-step' },
    props: ['minHeight', 'padding', 'gap', 'borderRadius', 'fontSize', 'color', 'backgroundColor'],
  },
  {
    name: 'Stage',
    selectors: { prototype: '.page .term', app: '.bold-screen-stage' },
    props: ['minHeight', 'borderRadius', 'padding', 'fontFamily', 'fontSize', 'backgroundColor'],
  },
  {
    name: 'Badge',
    selectors: { prototype: '.page .badge', app: '.bold-screen-badge' },
    props: ['padding', 'borderRadius', 'fontSize', 'fontWeight', 'color', 'backgroundColor'],
  },
]

async function measure(page, parts, side) {
  return page.evaluate(
    ({ parts, side }) => {
      const result = {}
      for (const part of parts) {
        const selector = part.selectors[side]
        const element = globalThis.document.querySelector(selector)
        if (!element) {
          result[part.name] = null
          continue
        }
        const style = globalThis.getComputedStyle(element)
        result[part.name] = Object.fromEntries(
          [...new Set([...part.props, 'display'])].map((property) => [property, style[property]]),
        )
      }
      return result
    },
    { parts, side },
  )
}

function differences(left, right, parts) {
  const rows = []
  for (const part of parts) {
    const a = left[part.name]
    const b = right[part.name]
    if (!a || !b) {
      rows.push({ area: part.name, property: 'rendered', prototype: Boolean(a), app: Boolean(b) })
      continue
    }
    for (const property of part.props) {
      if (a[property] !== b[property])
        rows.push({ area: part.name, property, prototype: a[property], app: b[property] })
    }
  }
  return rows
}

async function prototypeBench(page, bench) {
  await page.goto(prototype, { waitUntil: 'domcontentloaded' })
  await page.locator('.top .word').waitFor()
  await page.evaluate((next) => {
    globalThis.document.querySelector(`[data-a="bench"][data-v="${next}"]`)?.click()
  }, bench)
  await page.locator(bench === 'code' ? '.code' : '.term').waitFor()
  await page.evaluate(() => globalThis.document.fonts.ready)
}

async function openPrototypeReplay(page) {
  await prototypeBench(page, 'screen')
  await page.evaluate(() => {
    globalThis.document.querySelector('[data-a="go"][data-v="replay"]')?.click()
  })
  await page.locator('.page .step').first().waitFor()
  await page.evaluate(() => globalThis.document.fonts.ready)
}

async function appWorkbench(page, work) {
  await page.goto(`${baseURL}/b?job=job-feed&work=${work}`)
  await page.locator('[data-ui="bold"] .top .word').waitFor({ timeout: 20_000 })
  if (await page.getByRole('button', { name: 'Open side panel' }).count())
    await page.getByRole('button', { name: 'Open side panel' }).click()
  await page.getByTestId('bold-workbench').waitFor({ timeout: 20_000 })
  await page.waitForFunction(() => globalThis.document.fonts.status === 'loaded')
}

async function appScreen(page) {
  await page.goto(`${baseURL}/b/screen/builder`)
  await page.getByRole('heading', { name: 'builder’s screen' }).waitFor({ timeout: 20_000 })
  await page.locator('.bold-screen-step').first().waitFor({ timeout: 20_000 })
  await page.waitForFunction(() => globalThis.document.fonts.status === 'loaded')
}

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
