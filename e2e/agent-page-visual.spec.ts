import { expect, test, type Page, type Route } from '@playwright/test'
import { AgentDetailSchema, AgentsSnapshotSchema } from '../packages/contract/src/index.ts'
import { fixtureNow } from './now-fixture.ts'
import { visualFixtures, visualHello } from './visual-fixtures.ts'

// PLAN 8.9: the agent page of a Hermes agent and of a coding agent share one layout. Every /api call is answered from
// fixtures (like visual.spec.ts), so the shots do not depend on what other specs do to the fake team.
const hermesBase = AgentDetailSchema.parse(visualFixtures['/api/agents/builder'])
const hermes = AgentDetailSchema.parse({
  ...hermesBase,
  skills: [
    'collaboration',
    'code-review',
    'release-notes',
    'refactoring',
    'debugging',
    'sqlite',
    'websockets',
    'git',
    'testing',
    'accessibility',
    'performance',
    'docs',
  ].map((name, index) => ({ name, enabled: index !== 2 })),
  tools: [
    ['terminal', 'Terminal and processes', 'builtin'],
    ['files', 'File operations', 'builtin'],
    ['web', 'Web search', 'builtin'],
    ['browser', 'Browser automation', 'builtin'],
    ['code', 'Code execution', 'builtin'],
    ['vision', 'Image analysis', 'builtin'],
    ['rag', 'Local RAG', 'mcp'],
    ['tracker', 'Tracker', 'mcp'],
  ].map(([id, label, kind], index) => ({ id, label, kind, enabled: index !== 3 })),
  memory: [
    {
      id: 'm1',
      text: 'Prefers short status updates.',
      source: 'About you',
      at: '2026-10-16T09:00:00.000Z',
    },
    {
      id: 'm2',
      text: 'The test suite runs with pnpm test.',
      source: 'Agent notes',
      at: '2026-10-16T09:00:00.000Z',
    },
    {
      id: 'm3',
      text: 'Releases go out on Fridays.',
      source: 'Agent notes',
      at: '2026-10-16T09:00:00.000Z',
    },
    {
      id: 'm4',
      text: 'Never push to main without a review.',
      source: 'Agent notes',
      at: '2026-10-16T09:00:00.000Z',
    },
  ],
})

const coder = {
  id: 'coder',
  name: 'coder',
  role: 'Reviews build scripts',
  style: { color: '#6B4EFF', shape: 'hexagon' },
  status: 'idle',
  activity: null,
  model: null,
  served: true,
  runtime: 'claude-code',
  runtimeNote: 'Claude Code · uses your Claude plan quota',
}
const codingDetail = AgentDetailSchema.parse({
  ...hermesBase,
  ...coder,
  tagline: '',
  skills: [],
  memory: [],
  tools: [],
  routines: [],
  channels: [],
  permissions: [],
  helpersMax: null,
  reportsTo: null,
  worksIn: null,
  rulesFile: null,
  personality: { excerpt: '', source: 'SOUL.md' },
})
const codingAgent = {
  id: 'coder',
  name: 'coder',
  role: 'Reviews build scripts',
  instructions:
    '## Style\n\nAnswer in short sentences. Run the tests before saying a change is done.\n\n- Never touch the lockfile.\n- Ask before deleting files.',
  instructionsEtag: 'etag-1',
  runtime: 'claude-code',
  workspace: '/home/user/score-workspaces/coder',
  permission: 'workspace-write',
  model: 'sonnet',
  style: coder.style,
  quota: 'Uses your Claude plan quota, shared with your other Claude Code work.',
  quotaFloorPercent: 10,
  cli: { state: 'ready', version: '2.1.302', testedVersions: ['2.1.302'], confirmed: false },
  heldGroups: [],
  createdAt: '2026-10-16T00:00:00.000Z',
}
const agents = AgentsSnapshotSchema.parse({
  ...(visualFixtures['/api/agents'] as object),
  items: [
    ...(visualFixtures['/api/agents'] as { items: unknown[] }).items.filter(
      (item) => (item as { id: string }).id !== 'builder',
    ),
    { ...hermes, tagline: undefined },
    coder,
  ],
})

const fixtures: Record<string, unknown> = {
  ...visualFixtures,
  '/api/agents': agents,
  '/api/agents/builder': hermes,
  '/api/agents/coder': codingDetail,
  '/api/agents/coder/todos': null,
  '/api/coding-agents': { items: [codingAgent] },
  '/api/coding-agents/runtimes': {
    items: [
      {
        runtime: 'claude-code',
        label: 'Claude Code',
        state: 'ready',
        version: '2.1.302',
        testedVersions: ['2.1.302'],
        quota: 'Uses your Claude plan quota.',
        message: null,
        unverifiedPermissions: [],
        warning: null,
      },
    ],
  },
  '/api/coding-agents/backend': {
    kind: 'unit',
    note: 'Runs as a supervised system service.',
    checks: [{ name: 'linger', ok: true, detail: 'linger enabled' }],
    checkedAt: '2026-10-16T00:00:00.000Z',
  },
  '/api/coding-agents/coder/quota': {
    quota: {
      runtime: 'claude-code',
      seenAt: fixtureNow,
      source: 'usage',
      windows: [
        { name: '5 hours', group: null, usedPercent: 6, resetsAt: null },
        { name: 'week', group: null, usedPercent: 78, resetsAt: null },
      ],
    },
  },
  '/api/coding-agents/runtimes/claude-code/models': {
    models: [
      { id: 'sonnet', name: 'Sonnet' },
      { id: 'opus', name: 'Opus' },
    ],
    source: 'aliases',
  },
}

test.use({ timezoneId: 'UTC', locale: 'en-GB' })

async function answer(page: Page, posts: { path: string; body: unknown }[] = []) {
  await page.clock.setFixedTime(new Date(fixtureNow))
  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/stream') {
      await route.fulfill({
        contentType: 'text/event-stream',
        body: `event: stream.hello\ndata: ${JSON.stringify(visualHello)}\n\n`,
      })
      return
    }
    if (route.request().method() !== 'GET') {
      posts.push({ path: url.pathname, body: route.request().postDataJSON() })
      if (url.pathname === '/api/coding-agents/coder')
        await route.fulfill({
          json: { ...codingAgent, ...(route.request().postDataJSON() as object) },
        })
      else await route.fulfill({ json: coder })
      return
    }
    url.searchParams.delete('tz')
    url.searchParams.delete('fresh')
    const key = `${url.pathname}${url.search}`
    const fixture = fixtures[key]
    // Tabs of the agent are only opened here, not shot: they may fail to load without upsetting the test.
    if (fixture === undefined && /^\/api\/agents\/builder\//.test(key)) {
      await route.fulfill({
        status: 404,
        json: { error: { code: 'not_found', message: 'Not in this test' } },
      })
      return
    }
    expect(fixture, `Missing fixture: ${key}`).toBeDefined()
    await route.fulfill({ json: fixture })
  })
}

async function open(page: Page, path: string, width: number, dark: boolean) {
  if (dark) await page.addInitScript(() => window.localStorage.setItem('score.theme', 'dark'))
  await page.setViewportSize({ width, height: width < 600 ? 844 : 1150 })
  await page.goto(path)
  await expect(page.locator('.team-tabs')).toBeVisible()
  await expect(page.getByText(/^Loading/)).toHaveCount(0)
  await page.evaluate(() => document.fonts.ready)
  await expect(page.locator('html[data-motion]')).toHaveCount(0)
}

const kinds = [
  { name: 'hermes', path: '/team/builder', ready: 'Memory' },
  { name: 'coding', path: '/team/coder', ready: 'Access' },
]
for (const kind of kinds) {
  for (const [label, width, dark] of [
    ['light', 1440, false],
    ['dark', 1440, true],
    ['phone', 390, false],
  ] as const) {
    test(`${kind.name} agent page, ${label}`, async ({ page }) => {
      await answer(page)
      await open(page, kind.path, width, dark)
      await expect(page.getByRole('heading', { name: kind.ready, level: 2 })).toBeVisible()
      if (width < 600)
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
        ).toBeLessThanOrEqual(1)
      await expect(page).toHaveScreenshot(`${kind.name}-${label}.png`, {
        fullPage: true,
        animations: 'disabled',
        maxDiffPixelRatio: 0.005,
      })
    })
  }
}

test('cards have a gap between them and the grid has three columns', async ({ page }) => {
  await answer(page)
  await open(page, '/team/builder', 1440, false)
  const grid = page.locator('.team-overview-grid')
  const columns = await grid.evaluate((element) =>
    getComputedStyle(element).gridTemplateColumns.split(' '),
  )
  expect(columns).toHaveLength(3)
  const [skills, memory] = await Promise.all(
    ['Skills', 'Memory'].map(async (name) => page.getByRole('region', { name }).boundingBox()),
  )
  expect(memory!.x - (skills!.x + skills!.width)).toBeGreaterThanOrEqual(12)
  const [permissions, details] = await Promise.all([
    page.getByRole('region', { name: 'Permissions' }).boundingBox(),
    page.getByRole('heading', { name: 'Agent details' }).boundingBox(),
  ])
  expect(details!.y - (permissions!.y + permissions!.height)).toBeGreaterThanOrEqual(16)
})

test('Message opens the direct room, Pause pauses, and Show all opens the full list', async ({
  page,
}) => {
  const posts: { path: string; body: unknown }[] = []
  await answer(page, posts)
  await open(page, '/team/builder', 1440, false)
  await expect(page.getByRole('link', { name: 'Message builder' })).toHaveAttribute(
    'href',
    /^\/chat\/[0-9a-f-]{36}$/,
  )
  await page.getByRole('button', { name: 'Pause' }).click()
  await expect.poll(() => posts.map((post) => post.path)).toContain('/api/agents/builder/pause')

  await expect(page.getByRole('region', { name: 'Skills' }).getByRole('listitem')).toHaveCount(10)
  await page
    .getByRole('region', { name: 'Skills' })
    .getByRole('button', { name: 'Show all 12' })
    .click()
  await expect(page.getByRole('tab', { name: 'Skills', selected: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Overview' }).click()
  await expect(page.getByRole('region', { name: 'Tools' }).getByRole('listitem')).toHaveCount(7)
  await page
    .getByRole('region', { name: 'Tools' })
    .getByRole('button', { name: 'Show all 8' })
    .click()
  await expect(page.getByRole('tab', { name: 'Tools', selected: true })).toBeVisible()
})

test('a coding agent’s Model and Access cards edit in place', async ({ page }) => {
  const posts: { path: string; body: unknown }[] = []
  await answer(page, posts)
  await open(page, '/team/coder', 1440, false)
  await expect(page.getByRole('link', { name: 'Message coder' })).toBeVisible()
  const model = page.getByRole('region', { name: 'Model' })
  await model.getByRole('button', { name: 'Change model' }).click()
  await model.getByRole('combobox', { name: 'Model' }).selectOption('opus')
  await model.getByRole('button', { name: 'Save' }).click()
  await expect.poll(() => posts.at(-1)?.body).toEqual({ model: 'opus' })

  const access = page.getByRole('region', { name: 'Access' })
  await access.getByRole('button', { name: 'Change access' }).click()
  await access.getByRole('radio', { name: /Read only/ }).check()
  const floor = access.getByLabel(/Stop using this agent in runs when a limit is below/)
  await floor.fill('20')
  // The field starts at the left of its card (it was centred before).
  const box = await floor.boundingBox()
  const card = await access.boundingBox()
  expect(box!.x - card!.x).toBeLessThan(60)
  await access.getByRole('button', { name: 'Save' }).click()
  await expect
    .poll(() => posts.at(-1)?.body)
    .toEqual({ permission: 'read-only', quotaFloorPercent: 20 })
})
