// Side-by-side check for PLAN 11.10e (not part of `pnpm e2e`): screenshots the prototype's Library side panel and the
// built `/b` Library at the two review sizes, then compares the panel's computed values. Run `pnpm build` first, then
// `node scripts/bold-library-compare.mjs`. Like bold-frame-compare, Chromium serves the build by routing requests so
// this check does not need a listening socket.
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

// The prototype's own sample vault, in the shape the real Knowledge endpoints return. This keeps both screenshots on
// the same folder and note instead of comparing an empty app Library with a populated prototype.
const notes = [
  {
    path: 'Decisions/Event cursors.md',
    title: 'Event cursors',
    mtime: '2026-10-24T09:00:00Z',
    lastAuthor: { agentId: 'reviewer' },
  },
  {
    path: 'Decisions/Websockets vs SSE.md',
    title: 'Websockets vs SSE',
    mtime: '2026-10-24T08:30:00Z',
    lastAuthor: { agentId: 'builder' },
  },
  {
    path: 'Release notes/2.4 draft.md',
    title: '2.4 draft',
    mtime: '2026-10-24T08:00:00Z',
    lastAuthor: { agentId: 'lead' },
  },
  {
    path: 'Research/Queue libraries.md',
    title: 'Queue libraries',
    mtime: '2026-10-23T16:00:00Z',
    lastAuthor: { agentId: 'lead' },
  },
]
const info = {
  vault: '/home/score/knowledge',
  notes: notes.length,
  gitAvailable: true,
  agentAccess: true,
  memoryNotes: true,
  documents: 0,
  documentBytes: 0,
  moveIssue: null,
}
const tree = { folders: ['Decisions', 'Release notes', 'Research'], notes, documents: [] }
const bodies = {
  'Decisions/Event cursors.md':
    '# Event cursors\n\nPage task events by (created_at, id), never by a timestamp alone. Two events written in the same millisecond otherwise collide and one is skipped.\n\nFound in review on the activity feed; see [[Websockets vs SSE]] for how the stream resumes from a cursor.\n',
  'Decisions/Websockets vs SSE.md':
    '# Websockets vs SSE\n\nWe use a websocket so the browser can pause and resume the feed over one connection.\n',
  'Release notes/2.4 draft.md':
    '# 2.4 draft\n\nActivity feed streams live. CSV export. Login rate limit. Migration steps: to follow.\n',
  'Research/Queue libraries.md':
    '# Queue libraries\n\nThree options compared on retries, persistence and licence. One clear pick, with sources.\n',
}

function note(path) {
  return {
    path,
    title: notes.find((item) => item.path === path)?.title ?? path.replace(/\.md$/i, ''),
    frontmatter: { status: 'approved' },
    body: bodies[path] ?? `# ${path}\n`,
    etag: `etag-${path}`,
    mtime: notes.find((item) => item.path === path)?.mtime ?? '2026-10-24T09:00:00Z',
    links:
      path === 'Decisions/Event cursors.md'
        ? [{ target: 'Websockets vs SSE', path: 'Decisions/Websockets vs SSE.md' }]
        : [],
    backlinks:
      path === 'Decisions/Websockets vs SSE.md'
        ? [{ path: 'Decisions/Event cursors.md', title: 'Event cursors' }]
        : [],
    lastAuthor: notes.find((item) => item.path === path)?.lastAuthor ?? null,
    versioned: true,
    history: 'unchanged',
  }
}

async function serve(route) {
  const url = new URL(route.request().url())
  if (url.pathname.startsWith('/api/')) {
    if (url.pathname === '/api/stream') return route.fulfill({ status: 204 })
    if (url.pathname === '/api/knowledge')
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(info),
      })
    if (url.pathname === '/api/knowledge/tree')
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(tree),
      })
    if (url.pathname.startsWith('/api/knowledge/notes/')) {
      const rest = decodeURIComponent(url.pathname.slice('/api/knowledge/notes/'.length))
      if (rest.endsWith('/history'))
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ items: [] }),
        })
      const path = rest.replace(/\/history$/, '')
      if (!bodies[path]) return route.fulfill({ status: 404, body: 'not found' })
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(note(path)),
      })
    }
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
    name: 'Side panel',
    prototype: '.side',
    app: '.side',
    props: ['width', 'height', 'borderRadius', 'color', 'backgroundColor', 'boxShadow'],
    note: 'Same surface; its width depends on the room column beside it.',
  },
  {
    name: 'Side head',
    prototype: '.sidehead',
    app: '.sidehead',
    props: ['height', 'gap', 'padding', 'borderBottomColor'],
    note: 'The prototype wins over the board: no “whole team can read” subtitle.',
  },
  {
    name: 'Library body',
    prototype: '.sidebody',
    app: '.sidebody.bold-library',
    props: ['padding', 'gap', 'display', 'flexDirection', 'flexWrap', 'backgroundColor'],
    note: 'Two wrapped columns with the prototype’s 18px padding and 16px gap.',
  },
  {
    name: 'Search',
    prototype: null,
    app: '.bold-library-search',
    props: ['minHeight', 'height', 'borderRadius', 'padding', 'gap', 'backgroundColor'],
    note: 'The prototype abbreviates this; the binding board and the plan both require search.',
  },
  {
    name: 'Notes nav',
    prototype: 'nav[aria-label="Notes"]',
    app: '.bold-library-nav',
    props: ['width', 'maxWidth', 'flexBasis', 'gap', 'fontSize'],
    note: '200px basis, 240px cap, 2px row gap from the prototype.',
  },
  {
    name: 'Folder',
    prototype: '.sidebody nav[aria-label="Notes"] > span.small.muted',
    app: '.bold-library-folder',
    props: ['padding', 'fontSize', 'fontWeight', 'color'],
    note: 'The prototype’s small muted folder label.',
  },
  {
    name: 'Selected note',
    prototype: 'nav[aria-label="Notes"] button[data-v="n1"]',
    app: '.bold-library-item.is-selected',
    props: ['minHeight', 'padding', 'borderRadius', 'fontSize', 'color', 'backgroundColor'],
    note: 'The app row is taller because the plan adds the author byline the prototype abbreviates.',
  },
  {
    name: 'New note',
    prototype: 'nav[aria-label="Notes"] > button.btn.ghost',
    app: '.bold-library-tools .bold-library-new',
    props: ['minHeight', 'padding', 'borderRadius', 'fontSize', 'color', 'backgroundColor'],
    note: 'The app also needs Upload, Files and Export beside it; all use the prototype’s small ghost pill.',
  },
  {
    name: 'Article',
    prototype: '.sidebody > article',
    app: '.bold-library-main',
    props: ['width', 'flexBasis', 'gap', 'padding', 'backgroundColor'],
    note: 'The app fills this with the reused Knowledge editor and panels.',
  },
  {
    name: 'Byline',
    prototype: '.sidebody > article > span.small.muted.row.wrap',
    app: '.bold-library-by.is-detail',
    props: ['fontSize', 'fontWeight', 'gap', 'color'],
    note: 'Written by + agent glyph from the prototype; no job is available in Knowledge’s API, so none is invented.',
  },
  {
    name: 'Title',
    prototype: '#ntitle',
    app: '.bold-library .kn-note h2',
    props: ['fontFamily', 'fontSize', 'fontWeight', 'backgroundColor', 'color'],
    note: 'The prototype edits a field; the app reuses the classic editor’s heading and controls.',
  },
  {
    name: 'Editor surface',
    prototype: '#nbody',
    app: '.bold-library .kn-edit-area',
    props: ['minHeight', 'padding', 'borderRadius', 'fontSize', 'lineHeight', 'backgroundColor'],
    note: 'Classic CodeMirror inside the prototype textarea’s field surface (14px radius, 12px 14px padding).',
  },
]

async function measure(page, selectors) {
  return page.evaluate((selectors) => {
    const result = {}
    for (const part of selectors) {
      if (!part.selector) {
        result[part.name] = null
        continue
      }
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
  }, selectors)
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
    return left ? 'extra in app' : right ? 'missing in app' : 'not on either side'
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

    // The prototype's phone sheet is the same aside with `.sidecol.open`; pick Library at desktop width first so the
    // menu is visible, then resize to the phone and let the binding phone rules turn it into the full-screen sheet.
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(prototype, { waitUntil: 'domcontentloaded' })
    await page.locator('.top .word').waitFor()
    await page.locator('[data-a="sideMenu"]').click()
    await page.locator('[data-a="sideMode"][data-v="library"]').click()
    await page.locator('.sidebody nav[aria-label="Notes"]').waitFor()
    await page.setViewportSize(viewport)
    await page.evaluate(() => globalThis.document.fonts.ready)
    await page.screenshot({ path: join(output, `bold-library-prototype-${size}.png`) })
    await page.locator('.side').screenshot({
      path: join(output, `bold-library-prototype-${size}-panel.png`),
      animations: 'disabled',
    })
    const prototypeMetrics = await measure(
      page,
      parts.map((part) => ({
        name: part.name,
        selector: part.prototype,
        props: part.props,
      })),
    )

    await page.setViewportSize(viewport)
    await page.goto(`${baseURL}/b`)
    await page.locator('[data-ui="bold"] .top .word').waitFor({ timeout: 20_000 })
    if (viewport.width < 861) await page.getByRole('button', { name: 'Open side panel' }).click()
    await page.getByRole('button', { name: /^Work/ }).click()
    await page.getByRole('button', { name: /^Library/ }).click()
    await page.locator('[data-testid="bold-library"]').waitFor({ timeout: 20_000 })
    await page.locator('.bold-library-item.is-selected').waitFor({ timeout: 20_000 })
    await page.locator('.bold-library .kn-edit-area').waitFor({ timeout: 20_000 })
    await page.evaluate(() => globalThis.document.fonts.ready)
    await page.screenshot({ path: join(output, `bold-library-app-${size}.png`) })
    await page.locator('.bold-sidecol .side').screenshot({
      path: join(output, `bold-library-app-${size}-panel.png`),
      animations: 'disabled',
    })
    const appMetrics = await measure(
      page,
      parts.map((part) => ({ name: part.name, selector: part.app, props: part.props })),
    )

    results[size] = { prototype: prototypeMetrics, app: appMetrics }
  }

  writeFileSync(join(output, 'bold-library-metrics.json'), `${JSON.stringify(results, null, 2)}\n`)

  const lines = ['# Bold Library: prototype vs app', '']
  for (const size of Object.keys(results)) {
    lines.push(
      `## ${size}px`,
      '',
      '| Part | Prototype | App | Difference | Why |',
      '|---|---|---|---|---|',
    )
    for (const part of parts)
      lines.push(
        `| ${part.name} | ${cell(results[size].prototype, part)} | ${cell(results[size].app, part)} | ${difference(results[size].prototype, results[size].app, part)} | ${part.note} |`,
      )
    lines.push('')
  }
  lines.push(
    'Screenshots: `bold-library-{prototype,app}-{1440,390}.png` (context) and `-panel.png` (the side panel alone).',
    '',
  )
  writeFileSync(join(output, 'bold-library-metrics.md'), `${lines.join('\n')}\n`)
  console.log(`Wrote Library screenshots and measurements to ${output}`)
} finally {
  await browser?.close()
}
