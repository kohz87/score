// Side-by-side check for PLAN 11.10a (not part of `pnpm e2e`): boards 03/18/19/20 and the built app at 1440×900 and
// 390×844. The boards are fixed 390×844 canvases, so computed values are compared only at phone width; the desktop
// pass captures the same screens for review. The sandbox forbids listening sockets, so Chromium fulfils every request
// for the app origin from dist. Run `pnpm build` first, then `node scripts/compare/11.10a.mjs`.
/* global document, getComputedStyle */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { chromium } from '@playwright/test'

const root = resolve(new URL('../..', import.meta.url).pathname)
const output = join(root, 'test-results')
const dist = join(root, 'apps/web/dist')
const baseURL = 'http://score.local'

if (!existsSync(join(dist, 'index.html'))) {
  console.error('Score is not built. Run `pnpm build`, then try again.')
  process.exit(1)
}
mkdirSync(output, { recursive: true })

const at = (minute) => `2026-10-24T10:${String(minute).padStart(2, '0')}:00.000Z`
const board = (number) => {
  const names = {
    '03': '03-phone-room',
    18: '18-phone-jobs',
    19: '19-phone-one-to-one',
    20: '20-phone-team',
  }
  return `file://${join(root, 'docs/design/bold', `${names[number]}.dc.html`)}`
}

const agent = (id, role, color, shape, status = 'idle', activity = null) => ({
  id,
  name: id,
  role,
  style: { color, shape },
  status,
  activity,
  model: { id: 'fake-model', label: 'Demo model' },
  served: true,
})
const agents = [
  agent('lead', 'Leads the team', '#6B4EFF', 'circle-dot'),
  agent('builder', 'Builds features', '#19C39A', 'triangle', 'waiting', 'waiting for your OK'),
  agent('reviewer', 'Checks the work', '#FFB61E', 'diamond', 'working', 'reading release notes'),
  agent(
    'designer',
    'Designs screens',
    '#FF6B8A',
    'square',
    'working',
    'sketching the announcement',
  ),
]

const teamRoom = {
  id: 'team-room',
  name: 'Team room',
  kind: 'room',
  leadAgentId: 'lead',
  members: agents.map((item) => item.id),
  unread: 0,
  activeAgents: ['builder', 'reviewer', 'designer'],
  channels: [],
  role: 'team',
  routing: 'exchanges',
}

function job(id, title, extra = {}) {
  return {
    id,
    roomId: teamRoom.id,
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
    source: null,
    reportBack: null,
    spendCapUsd: null,
    recipe: null,
    createdAt: at(0),
    updatedAt: at(15),
    ...extra,
  }
}

const jobs = [
  job('job-default', 'Team room', { isDefault: true, holderAgentId: 'lead' }),
  job('job-activity', 'Activity feed', { unread: 2, holderAgentId: 'builder' }),
  job('job-notes', 'Release notes 2.4', {
    state: 'waiting_on_you',
    holderAgentId: 'lead',
    unread: 3,
  }),
  job('job-queue', 'Queue research', {
    state: 'done',
    holderAgentId: 'lead',
    summary: 'one clear pick',
  }),
]

const approval = {
  id: 'approval-package',
  origin: 'score-run',
  phase: 'human_pending',
  status: 'pending',
  actionable: true,
  linkedTo: null,
  agentId: 'builder',
  title: 'May I install a package?',
  command: 'npm install ws@8',
  cwd: '~/app',
  description: 'The websocket feed needs ws.',
  choices: ['once', 'deny'],
  createdAt: at(7),
  expiresAt: null,
  decision: null,
  delivery: 'none',
  blocking: null,
  refs: [],
}

function text(id, jobId, author, value, minute) {
  return {
    id,
    roomId: teamRoom.id,
    jobId,
    author,
    to: [],
    parts: [{ kind: 'text', text: value }],
    createdAt: at(minute),
    streaming: false,
    refs: [],
  }
}

const messages = {
  'job-default': [],
  'job-activity': [
    text('activity-request', 'job-activity', { kind: 'you' }, 'Build the activity feed.', 3),
    text(
      'activity-builder',
      'job-activity',
      { kind: 'agent', agentId: 'builder' },
      'Read layer is ready. The feed renders newest first.',
      4,
    ),
    text(
      'activity-review',
      'job-activity',
      { kind: 'agent', agentId: 'reviewer' },
      'Approved, after one fix.',
      5,
    ),
    text(
      'activity-done',
      'job-activity',
      { kind: 'agent', agentId: 'lead' },
      'Done. Here it is.',
      6,
    ),
  ],
  'job-notes': [text('notes-request', 'job-notes', { kind: 'you' }, 'Draft the release notes.', 8)],
  'job-queue': [
    text(
      'queue-answer',
      'job-queue',
      { kind: 'agent', agentId: 'lead' },
      'One clear pick, with sources and licence notes.',
      10,
    ),
  ],
}

const directRoom = {
  ...teamRoom,
  id: 'direct-builder',
  name: 'builder',
  kind: 'direct',
  role: 'direct',
  routing: 'exchanges',
  leadAgentId: 'builder',
  members: ['builder'],
  activeAgents: [],
}
const directChat = job('job-direct-websockets', 'Websockets or server-sent events', {
  roomId: directRoom.id,
  holderAgentId: 'builder',
  summary: 'Why websockets and not server-sent events?',
  messageCount: 2,
})
const directMessages = [
  text(
    'direct-you',
    directChat.id,
    { kind: 'you' },
    'Why websockets and not server-sent events?',
    3,
  ),
  {
    ...text(
      'direct-builder',
      directChat.id,
      { kind: 'agent', agentId: 'builder' },
      'Server-sent events only go one way. We’ll want to pause and resume the feed from the browser later, and a socket does both over one connection.',
      4,
    ),
    roomId: directRoom.id,
  },
]

const outside = {
  id: 'ext-telegram-1',
  agentId: 'lead',
  source: 'telegram',
  sourceLabel: 'Telegram',
  title: 'Plan the launch checklist',
  startedAt: '2026-10-23T08:00:00.000Z',
  messageCount: 4,
  busy: false,
  roomId: null,
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

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function serve(route) {
  const url = new URL(route.request().url())
  const path = url.pathname
  if (path.startsWith('/api/')) {
    if (path === '/api/stream') return route.fulfill({ status: 204 })
    if (path === '/api/agents') return json(route, { asOfSeq: 12, items: agents })
    if (path === '/api/team-room') return json(route, { asOfSeq: 12, room: teamRoom, jobs })
    if (path === '/api/rooms')
      return json(route, { asOfSeq: 12, rooms: [], directs: [], projects: [] })
    if (path === '/api/outside-sessions') return json(route, { items: [outside], unavailable: [] })
    if (path === '/api/rooms/team-room/jobs') return json(route, { asOfSeq: 12, items: jobs })
    if (path === '/api/rooms/team-room/messages') {
      const jobId = url.searchParams.get('jobId') ?? 'job-default'
      return json(route, { asOfSeq: 12, items: messages[jobId] ?? [], nextCursor: null, jobId })
    }
    if (path === '/api/rooms/team-room/pins') return json(route, { items: [] })
    if (path === '/api/rooms/team-room/versions') return json(route, { asOfSeq: 12, items: [] })
    if (path === '/api/approvals')
      return json(route, { asOfSeq: 12, items: [approval], nextCursor: null })
    if (path === '/api/commands') return json(route, { items: [] })
    if (path === '/api/agents/builder/direct')
      return json(route, { asOfSeq: 12, room: directRoom, chats: [directChat] })
    if (/^\/api\/jobs\/[^/]+\/(results|workbench|exchanges)$/.test(path))
      return json(route, {
        asOfSeq: 12,
        items: [],
        screens: [],
        files: [],
        looseComments: [],
        drafts: [],
      })
    if (path === `/api/rooms/${directRoom.id}/messages`)
      return json(route, {
        asOfSeq: 12,
        items: directMessages,
        nextCursor: null,
        jobId: directChat.id,
      })
    return json(route, { asOfSeq: 0, items: [], rooms: [], directs: [], projects: [] })
  }
  const requested = path === '/' ? '/index.html' : decodeURIComponent(path)
  let file = resolve(dist, `.${requested}`)
  if (!file.startsWith(dist + sep) || !existsSync(file) || !statSync(file).isFile())
    file = join(dist, 'index.html')
  return route.fulfill({
    status: 200,
    contentType: contentTypes[extname(file)] ?? 'application/octet-stream',
    body: readFileSync(file),
  })
}

const parts = {
  jobs: [
    {
      name: 'Job card',
      selectors: { board: 'a[href="03-phone-room.dc.html"]', app: '.bold-phone-job' },
      props: ['minHeight', 'padding', 'borderRadius', 'gap', 'backgroundColor'],
    },
    {
      name: 'Jobs heading',
      selectors: {
        board: 'span[style*="font-size: 12px"][style*="font-weight: 700"]',
        app: '.bold-phone-jobs-head h2',
      },
      props: ['fontSize', 'fontWeight', 'color', 'padding'],
    },
    {
      name: 'Pinned request',
      selectors: {
        board: 'div[style*="border-radius: 22px"][style*="padding: 14px 16px"]',
        app: '.bold-pins .bold-request',
      },
      props: ['padding', 'borderRadius', 'gap', 'backgroundColor'],
    },
    {
      name: 'Pinned Allow',
      selectors: {
        board: 'button[style*="background: #12131a"]',
        app: '.bold-pins .bold-approval-actions .btn:not(.ghost)',
      },
      props: ['minHeight', 'borderRadius', 'fontSize', 'fontWeight', 'backgroundColor'],
    },
  ],
  chat: [
    {
      name: 'Back',
      selectors: {
        board: 'button[aria-label="Back to chats"]',
        app: '[aria-label="Back to jobs"]',
      },
      props: ['width', 'height', 'borderRadius', 'backgroundColor'],
    },
    {
      name: 'Chat title',
      selectors: { board: 'header b', app: '.bold-phone-chat-id b' },
      props: ['fontSize', 'fontFamily', 'fontWeight'],
    },
    {
      name: 'Chat state',
      selectors: {
        board: 'header span[style*="font-size: 12px"]',
        app: '.bold-phone-chat-id > span',
      },
      props: ['fontSize', 'color'],
    },
    {
      name: 'Composer send',
      selectors: {
        board:
          'div[style*="border-radius: 999px"][style*="padding: 4px 4px 4px 6px"] button[aria-label="Send"]',
        app: '.bold-room-composer .chat-send',
      },
      props: ['width', 'height', 'borderRadius', 'backgroundColor'],
    },
  ],
  oneToOne: [
    {
      name: 'Privacy',
      selectors: { board: 'header span[style*="font-size: 12px"]', app: '.bold-dm-privacy' },
      props: ['fontSize', 'color'],
    },
    {
      name: 'Earlier chats',
      selectors: {
        board: 'button[aria-label="Earlier chats"]',
        app: 'button[aria-label="Earlier chats"]',
      },
      props: ['width', 'height', 'borderRadius', 'backgroundColor'],
    },
    {
      name: 'Private send',
      selectors: { board: 'button[aria-label="Send privately"]', app: 'button[aria-label="Send"]' },
      props: ['width', 'height', 'borderRadius', 'backgroundColor'],
    },
  ],
  team: [
    {
      name: 'Team card',
      selectors: { board: 'div[style*="padding: 6px 14px"] > a', app: '.bold-agentcard' },
      props: ['padding', 'borderRadius', 'gap'],
    },
    {
      name: 'Add',
      selectors: { board: 'header button', app: '.bold-team .pagehead .btn' },
      props: ['minHeight', 'padding', 'borderRadius', 'fontSize', 'fontWeight'],
    },
    {
      name: 'Message',
      selectors: {
        board:
          'div[style*="padding: 6px 14px"] > a span[style*="border-radius: 999px"][style*="padding: 8px 14px"]',
        app: '.bold-agentcard-actions .btn.primary',
      },
      props: ['minHeight', 'padding', 'borderRadius', 'fontSize', 'fontWeight'],
    },
  ],
  tabbar: [
    {
      name: 'Tab bar',
      selectors: { board: 'nav[aria-label="Main"]', app: '.bold-tabbar' },
      props: ['padding', 'borderTopColor', 'backgroundColor', 'justifyContent'],
    },
    {
      name: 'Tab',
      selectors: {
        board: 'nav[aria-label="Main"] > *:first-child',
        app: '.bold-tabbar button:first-child',
      },
      props: ['minWidth', 'minHeight', 'fontSize', 'fontWeight', 'color'],
    },
  ],
}

async function measure(page, list, side) {
  return page.evaluate(
    ({ list, side }) => {
      const result = {}
      for (const part of list) {
        const element = document.querySelector(part.selectors[side])
        if (!element) {
          result[part.name] = null
          continue
        }
        const style = getComputedStyle(element)
        result[part.name] = Object.fromEntries(
          [...new Set([...part.props, 'display'])].map((property) => [property, style[property]]),
        )
      }
      return result
    },
    { list, side },
  )
}

function differences(boardValues, appValues, list) {
  const rows = []
  for (const part of list) {
    const left = boardValues[part.name]
    const right = appValues[part.name]
    if (!left && !right) continue
    if (!left || !right) {
      rows.push({
        area: part.name,
        property: 'rendered',
        board: Boolean(left),
        app: Boolean(right),
      })
      continue
    }
    for (const property of part.props) {
      if (left[property] !== right[property])
        rows.push({ area: part.name, property, board: left[property], app: right[property] })
    }
  }
  return rows
}

async function waitForFonts(page) {
  await page.waitForFunction(() => document.fonts.status === 'loaded')
}

async function openBoard(page, number) {
  await page.goto(board(number), { waitUntil: 'domcontentloaded' })
  await page.locator('body').waitFor()
  await waitForFonts(page)
}

async function openApp(page, path) {
  await page.goto(`${baseURL}${path}`)
  await page.locator('[data-ui="bold"] .top .word').waitFor({ timeout: 20_000 })
  await waitForFonts(page)
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
      assert.equal(await page.locator('.bold-phone-job').count(), 3)
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
