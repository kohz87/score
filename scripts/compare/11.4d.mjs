// Side-by-side check for PLAN 11.4d (not part of `pnpm e2e`): screenshots the binding prototype, board 21 and the built
// app at both review sizes, then compares the room dropdown, room/job menus and the read-only Elsewhere panel. The
// sandbox forbids listening sockets, so Chromium fulfils every request for the app origin from the built files.
// Run `pnpm build` first, then `node scripts/compare/11.4d.mjs`.
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
const board21 = pathToFileURL(join(root, 'docs/design/bold/21-room-dropdown.dc.html')).href

if (!existsSync(join(dist, 'index.html'))) {
  console.error('Score is not built. Run `pnpm build`, then try again.')
  process.exit(1)
}
mkdirSync(output, { recursive: true })

const at = (minute) => `2026-10-24T10:${String(minute).padStart(2, '0')}:00.000Z`

const agent = (id, role, color, shape, status = 'idle') => ({
  id,
  name: id,
  role,
  style: { color, shape },
  status,
  activity: null,
  model: { id: 'fake-model', label: 'Demo model' },
  served: true,
})
const agents = [
  agent('lead', 'Leads the team', '#6B4EFF', 'circle-dot'),
  agent('builder', 'Builds features', '#19C39A', 'triangle', 'waiting'),
  agent('reviewer', 'Checks the work', '#FFB61E', 'diamond'),
  agent('designer', 'Designs screens', '#FF6B8A', 'square'),
]

const teamRoom = {
  id: 'team-room',
  name: 'Team room',
  kind: 'room',
  leadAgentId: 'lead',
  members: agents.map((item) => item.id),
  unread: 0,
  activeAgents: ['builder'],
  channels: [],
  role: 'team',
  routing: 'exchanges',
}

function job(id, roomId, title, extra = {}) {
  return {
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
    source: null,
    reportBack: null,
    spendCapUsd: null,
    recipe: null,
    createdAt: at(0),
    updatedAt: at(15),
    ...extra,
  }
}

const teamJobs = [
  job('job-default', teamRoom.id, 'Team room', { isDefault: true, holderAgentId: 'lead' }),
  job('job-activity', teamRoom.id, 'Activity feed', { unread: 2 }),
  job('job-notes', teamRoom.id, 'Release notes 2.4', {
    state: 'waiting_on_you',
    holderAgentId: 'lead',
    unread: 3,
  }),
]

const olderRoom = {
  id: 'room-old',
  name: '#activity-feed',
  kind: 'room',
  leadAgentId: null,
  members: agents.map((item) => item.id),
  unread: 0,
  activeAgents: [],
  channels: [],
  role: 'room',
  routing: 'mentions',
}
const oldJob = job('job-old', olderRoom.id, olderRoom.name, {
  isDefault: true,
  holderAgentId: null,
})

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

const message = {
  id: 'message-old',
  roomId: olderRoom.id,
  jobId: oldJob.id,
  author: { kind: 'agent', agentId: 'lead' },
  to: [],
  parts: [{ kind: 'text', text: 'The feed is live. Ask builder for the cursor work.' }],
  createdAt: at(3),
  streaming: false,
  refs: [],
}

const importedMessages = [
  {
    id: 'import:1',
    roomId: 'room-imported',
    jobId: 'job-imported',
    author: { kind: 'you' },
    to: [],
    parts: [{ kind: 'text', text: 'Plan the launch checklist.' }],
    createdAt: '2026-10-23T08:00:00.000Z',
    streaming: false,
    refs: [],
  },
  {
    id: 'import:2',
    roomId: 'room-imported',
    jobId: 'job-imported',
    author: { kind: 'agent', agentId: 'lead' },
    to: [],
    parts: [{ kind: 'text', text: 'Outline it, then freeze the release branch.' }],
    createdAt: '2026-10-23T08:01:00.000Z',
    streaming: false,
    refs: [],
  },
]

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
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

async function serve(route) {
  const url = new URL(route.request().url())
  const path = url.pathname
  if (path.startsWith('/api/')) {
    if (path === '/api/stream') return route.fulfill({ status: 204 })
    if (path === '/api/agents') return json(route, { asOfSeq: 12, items: agents })
    if (path === '/api/team-room')
      return json(route, { asOfSeq: 12, room: teamRoom, jobs: teamJobs })
    if (path === '/api/rooms')
      return json(route, { asOfSeq: 12, rooms: [olderRoom], directs: [], projects: [] })
    if (path === '/api/outside-sessions') return json(route, { items: [outside], unavailable: [] })
    if (path === '/api/rooms/team-room/jobs') return json(route, { asOfSeq: 12, items: teamJobs })
    if (path === '/api/rooms/room-old')
      return json(route, { asOfSeq: 12, room: olderRoom, filesInPlay: [], learned: [] })
    if (path === '/api/rooms/room-old/jobs') return json(route, { asOfSeq: 12, items: [oldJob] })
    if (path === '/api/rooms/room-old/messages')
      return json(route, { asOfSeq: 12, items: [message], nextCursor: null, jobId: oldJob.id })
    if (path === '/api/outside-sessions/import')
      return json(route, { roomId: 'room-imported', imported: 2 })
    if (path === '/api/rooms/room-imported/messages')
      return json(route, {
        asOfSeq: 12,
        items: importedMessages,
        nextCursor: null,
        jobId: 'job-imported',
      })
    if (path.endsWith('/messages'))
      return json(route, {
        asOfSeq: 12,
        items: [],
        nextCursor: null,
        jobId: url.searchParams.get('jobId'),
      })
    if (path.endsWith('/pins')) return json(route, { items: [] })
    if (path.endsWith('/versions')) return json(route, { asOfSeq: 12, items: [] })
    if (path === '/api/approvals') return json(route, { asOfSeq: 12, items: [], nextCursor: null })
    if (path === '/api/commands') return json(route, { items: [] })
    if (/^\/api\/jobs\/[^/]+\/(results|workbench|exchanges)$/.test(path))
      return json(route, {
        asOfSeq: 12,
        items: [],
        screens: [],
        files: [],
        looseComments: [],
        drafts: [],
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

const menuParts = [
  {
    name: 'Menu',
    selectors: {
      prototype: '.menu[role="listbox"], .menu',
      app: '.bold-room-switch, .bold-room-menu, .bold-job-menu',
    },
    props: ['width', 'padding', 'borderRadius', 'gap', 'backgroundColor', 'boxShadow'],
  },
  {
    name: 'Menu row',
    selectors: {
      prototype: '.menu .mi',
      app: '.bold-room-switch .mi, .bold-room-menu .mi, .bold-job-menu .mi',
    },
    props: ['minHeight', 'padding', 'borderRadius', 'gap', 'fontSize', 'color', 'backgroundColor'],
  },
  {
    name: 'Section label',
    selectors: { prototype: '.menu .sec', app: '.bold-room-switch .sec' },
    props: ['fontSize', 'fontWeight', 'color', 'padding'],
  },
]

const elsewhereParts = [
  {
    name: 'Read-only note',
    selectors: { prototype: '.sidebody > .note', app: '.bold-elsewhere-note' },
    props: ['padding', 'borderRadius', 'fontSize', 'fontWeight', 'color', 'backgroundColor'],
  },
  {
    name: 'Bring button',
    selectors: { prototype: '.sidebody .btn.primary', app: '.bold-elsewhere-actions .btn.primary' },
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
    name: 'Side body',
    selectors: { prototype: '.sidebody', app: '.bold-elsewhere' },
    props: ['padding', 'gap', 'display', 'backgroundColor'],
  },
]

async function measure(page, parts, side) {
  return page.evaluate(
    ({ parts, side }) => {
      const result = {}
      for (const part of parts) {
        const element = globalThis.document.querySelector(part.selectors[side])
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
    const prototypeValue = left[part.name]
    const appValue = right[part.name]
    if (!prototypeValue && !appValue) continue
    if (!prototypeValue || !appValue) {
      rows.push({
        area: part.name,
        property: 'rendered',
        prototype: Boolean(prototypeValue),
        app: Boolean(appValue),
      })
      continue
    }
    for (const property of part.props) {
      if (prototypeValue[property] !== appValue[property])
        rows.push({
          area: part.name,
          property,
          prototype: prototypeValue[property],
          app: appValue[property],
        })
    }
  }
  return rows
}

async function waitForFonts(page) {
  await page.waitForFunction(() => globalThis.document.fonts.status === 'loaded')
}

async function openPrototypeRoom(page) {
  await page.goto(prototype, { waitUntil: 'domcontentloaded' })
  await page.locator('.top .word').waitFor()
  await waitForFonts(page)
}

async function openAppRoom(page, path = '/b') {
  await page.goto(`${baseURL}${path}`)
  await page.locator('[data-ui="bold"] .top .word').waitFor({ timeout: 20_000 })
  await waitForFonts(page)
}

async function prototypeDropdown(page) {
  await page.evaluate(() => globalThis.document.querySelector('[data-a="roomDrop"]')?.click())
  await page.locator('.menu[role="listbox"]').waitFor()
}

async function appDropdown(page) {
  await page.locator('.roomtitle').click()
  await page.locator('.bold-room-switch').waitFor()
}

async function prototypeElsewhere(page) {
  await page.evaluate(() => {
    globalThis.document.querySelector('[data-a="roomDrop"]')?.click()
    globalThis.document.querySelector('[data-a="else"][data-v="e1"]')?.click()
  })
  await page.locator('.sidebody .btn.primary').waitFor()
}

async function appElsewhere(page) {
  await appDropdown(page)
  await page.getByRole('option', { name: /Plan the launch checklist/ }).click()
  await page.locator('.bold-elsewhere').waitFor()
  await page.getByRole('button', { name: 'Preview this chat' }).click()
  await page.getByRole('button', { name: 'Bring into a job' }).waitFor()
}

async function prototypeJobMenu(page) {
  await page.evaluate(() =>
    globalThis.document.querySelector('[data-a="job"][data-v="feed"]')?.click(),
  )
  await page.evaluate(() => globalThis.document.querySelector('[data-a="jobMenu"]')?.click())
  await page.locator('button[data-a="jobMenu"] + .menu').waitFor()
}

async function appJobMenu(page) {
  await openAppRoom(page, '/b?job=job-activity')
  await page.getByRole('button', { name: 'Job menu' }).click()
  await page.locator('.bold-job-menu').waitFor()
}

async function prototypeRoomMenu(page) {
  await page.evaluate(() => globalThis.document.querySelector('[data-a="roomMenu"]')?.click())
  await page.locator('button[data-a="roomMenu"] + .menu').waitFor()
}

async function appRoomMenu(page) {
  await openAppRoom(page, '/b?room=room-old')
  await page.getByRole('button', { name: 'Room menu' }).click()
  await page.locator('.bold-room-menu').waitFor()
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
