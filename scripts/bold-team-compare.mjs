// Side-by-side check for PLAN 11.8b (not part of `pnpm e2e`): screenshots the prototype's Team and agent pages beside
// the built `/b/team` pages at the two review sizes and compares the values that carry the layout.
// Run `pnpm build` first, then `node scripts/bold-team-compare.mjs`. No server or port is used.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from '@playwright/test'

const root = resolve(new URL('..', import.meta.url).pathname)
const output = join(root, 'test-results')
const dist = join(root, 'apps/web/dist')
const baseURL = 'http://score.local'
const prototype = pathToFileURL(join(root, 'docs/design/bold/prototype.html')).href

if (!existsSync(join(dist, 'index.html'))) {
  console.error('Score is not built. Run `pnpm build`, then try again.')
  process.exit(1)
}

mkdirSync(output, { recursive: true })
const recorded = JSON.parse(readFileSync(join(root, 'e2e/fixtures/visual.json'), 'utf8'))
const agents = recorded['/api/agents']
const builder = recorded['/api/agents/builder']
const now = {
  asOfSeq: 1,
  now: '2026-10-24T10:00:00.000Z',
  paused: false,
  headline: { working: 1, needsYou: 0, text: 'One agent is working.' },
  lanes: [],
  handoffs: [],
  focusApproval: null,
  thread: null,
  madeToday: [],
}
const modelSettings = {
  fallbacks: [{ provider: 'demo', model: 'safe' }],
  fallbacksEditable: true,
  aliases: [],
  speech: {
    stt: { provider: null, model: null },
    tts: { provider: null, model: null, voice: null },
  },
}
const generated = {
  '/api/now': now,
  '/api/watch/overview': {
    items: agents.items.map((agent) => ({
      agent,
      thumbnail: null,
      status: agent.activity ?? agent.status,
      live: agent.status === 'working',
      surface: agent.id === 'builder' ? 'editor' : null,
    })),
  },
  '/api/agents/builder/files/SOUL.md': {
    content: builder.personality.excerpt,
    etag: 'a'.repeat(64),
  },
  '/api/agents/builder/files/AGENTS.md': {
    content: 'Write small changes. Run the tests before saying a change is done.',
    etag: 'b'.repeat(64),
  },
  '/api/agents/builder/model-settings': modelSettings,
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
    const fixture =
      generated[`${url.pathname}${url.search}`] ??
      generated[url.pathname] ??
      recorded[`${url.pathname}${url.search}`] ??
      recorded[url.pathname]
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

const teamParts = [
  {
    name: 'Page',
    props: ['maxWidth', 'gap', 'paddingTop'],
    prototype: '.page',
    app: '.page',
  },
  {
    name: 'Heading',
    props: ['fontSize', 'fontWeight', 'letterSpacing', 'lineHeight'],
    prototype: '.pagehead .big',
    app: '.pagehead .big',
  },
  {
    name: 'Add button',
    props: ['height', 'borderRadius', 'padding', 'fontSize', 'fontWeight'],
    prototype: '.pagehead .btn.primary',
    app: '.pagehead .btn.primary',
  },
  {
    name: 'Agent grid',
    props: ['gridTemplateColumns', 'gap'],
    prototype: '.grid4',
    app: '.bold-team-grid',
  },
  {
    name: 'Agent card',
    props: ['backgroundColor', 'borderRadius', 'padding', 'gap'],
    prototype: '.agentcard',
    app: '.bold-agentcard',
  },
  {
    name: 'Agent name',
    props: ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight'],
    prototype: '.agentcard b',
    app: '.bold-agentcard-name a',
  },
  {
    name: 'Pause card',
    props: ['backgroundColor', 'borderRadius', 'padding', 'gap'],
    prototype: '.page > .card.row',
    app: '.bold-pause',
  },
]

const agentParts = [
  {
    name: 'Page',
    props: ['maxWidth', 'gap', 'paddingTop'],
    prototype: '.page',
    app: '.page',
  },
  {
    name: 'Agent heading',
    props: ['fontSize', 'fontWeight', 'letterSpacing', 'lineHeight'],
    prototype: '.pagehead .big',
    app: '.pagehead .big',
  },
  {
    name: 'Up-front grid',
    props: ['gridTemplateColumns', 'gap'],
    prototype: '.page > .grid2',
    app: '.bold-upfront',
  },
  {
    name: 'Up-front card',
    props: ['backgroundColor', 'borderRadius', 'padding', 'gap'],
    prototype: '.page > .grid2 > .card',
    app: '.bold-up-card',
  },
  {
    name: 'Card label',
    props: ['fontSize', 'fontWeight', 'color'],
    prototype: '.page > .grid2 > .card .lab',
    app: '.bold-up-card .lab',
  },
  {
    name: 'More button',
    props: ['height', 'borderRadius', 'padding', 'fontSize', 'fontWeight'],
    prototype: '.page > .btn.ghost',
    app: '.bold-more-toggle',
  },
]

async function measure(page, parts) {
  return page.evaluate(
    (items) => {
      const result = {}
      for (const part of items) {
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
    },
    parts.map(({ name, props, selector }) => ({ name, props, selector })),
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

async function capture(page, name, selector) {
  await page.locator(selector).first().waitFor({ timeout: 20_000 })
  await page.evaluate(() => globalThis.document.fonts.ready)
  await page.screenshot({ path: join(output, `bold-${name}.png`) })
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
    const teamButton =
      viewport.width > 860
        ? page.locator('.nav button', { hasText: 'Team' })
        : page.locator('.tabbar button', { hasText: 'Team' })
    await teamButton.click()
    await capture(page, `prototype-team-${size}`, '.pagehead .big')
    const prototypeTeam = await measure(
      page,
      teamParts.map((part) => ({ ...part, selector: part.prototype })),
    )

    await page
      .locator('.agentcard')
      .filter({ hasText: 'builder' })
      .getByRole('button', { name: 'Open' })
      .click()
    await page.locator('.pagehead .big').filter({ hasText: 'builder' }).waitFor()
    await capture(page, `prototype-agent-${size}`, '.pagehead .big')
    const prototypeAgent = await measure(
      page,
      agentParts.map((part) => ({ ...part, selector: part.prototype })),
    )

    await page.goto(`${baseURL}/b/team`)
    await capture(page, `app-team-${size}`, '.bold-team')
    const appTeam = await measure(
      page,
      teamParts.map((part) => ({ ...part, selector: part.app })),
    )

    await page.goto(`${baseURL}/b/team/builder`)
    await page.locator('#agent-title').waitFor({ timeout: 20_000 })
    await capture(page, `app-agent-${size}`, '.bold-agent')
    const appAgent = await measure(
      page,
      agentParts.map((part) => ({ ...part, selector: part.app })),
    )

    results[size] = {
      team: { prototype: prototypeTeam, app: appTeam },
      agent: { prototype: prototypeAgent, app: appAgent },
    }
  }

  writeFileSync(join(output, 'bold-team-metrics.json'), `${JSON.stringify(results, null, 2)}\n`)

  const lines = ['# Bold Team and agent: prototype vs app', '']
  for (const size of Object.keys(results)) {
    for (const screen of ['team', 'agent']) {
      lines.push(`## ${screen === 'team' ? 'Team' : 'Agent'} · ${size}px`, '')
      lines.push('| Part | Prototype | App | Difference |', '|---|---|---|---|')
      const parts = screen === 'team' ? teamParts : agentParts
      for (const part of parts)
        lines.push(
          `| ${part.name} | ${cell(results[size][screen].prototype, part)} | ${cell(results[size][screen].app, part)} | ${difference(results[size][screen].prototype, results[size][screen].app, part)} |`,
        )
      lines.push('')
    }
  }
  writeFileSync(join(output, 'bold-team-metrics.md'), `${lines.join('\n')}\n`)
  console.log(`Wrote screenshots and measurements to ${output}`)
} finally {
  await browser?.close()
}
