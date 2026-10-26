import { expect, test, type Route } from '@playwright/test'

type Skill = { name: string; enabled: boolean }
type Memory = { id: string; text: string; source: string; at: string }
type Tool = { id: string; label: string; kind: 'builtin' | 'mcp'; enabled: boolean }
type Detail = {
  model: { id: string; label: string; via: string; fallback: string | null }
  skills: Skill[]
  memory: Memory[]
  tools: Tool[]
}

// Edits need a paired browser, so the writes are answered here. Reads come from the fake server and seed the state, so this exercises the real
// response shapes; the server side of every write (fake and stubbed live adapters) is in the server tests.
test('Model, Skills, Memory and Tools cards read and edit', async ({ page }) => {
  const state: Partial<Detail> = {}
  const sent: string[] = []
  const seed = async (route: Route) => {
    if (state.skills) return
    const detail = (await (await route.fetch({ url: '/api/agents/reviewer' })).json()) as Detail
    Object.assign(state, detail)
  }
  await page.route('**/api/agents/reviewer', async (route) => {
    const response = await route.fetch()
    const detail = (await response.json()) as Detail
    if (!state.skills) Object.assign(state, detail)
    await route.fulfill({ response, json: { ...detail, ...state } })
  })
  await page.route('**/api/agents/reviewer/skills', async (route) => {
    await seed(route)
    if (route.request().method() === 'POST') {
      const { name } = route.request().postDataJSON() as { name: string }
      sent.push(`install ${name}`)
      state.skills = [...state.skills!, { name: name.split('/').pop()!, enabled: true }]
    }
    await route.fulfill({ json: { items: state.skills } })
  })
  await page.route('**/api/agents/reviewer/skills/*', async (route) => {
    const { enabled } = route.request().postDataJSON() as { enabled: boolean }
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop()!)
    sent.push(`skill ${name} ${enabled}`)
    state.skills = state.skills!.map((skill) =>
      skill.name === name ? { ...skill, enabled } : skill,
    )
    await route.fulfill({ json: { name, enabled } })
  })
  await page.route('**/api/agents/reviewer/model', async (route) => {
    const body = route.request().postDataJSON() as { model: string; provider?: string }
    sent.push(`model ${body.model} ${body.provider}`)
    state.model = {
      id: body.model,
      label: body.model,
      via: body.provider ?? 'Demo',
      fallback: null,
    }
    await route.fulfill({ json: { ...state } })
  })
  await page.route('**/api/agents/reviewer/memory*', async (route) => {
    await seed(route)
    const request = route.request()
    if (request.method() === 'POST') {
      const { text } = request.postDataJSON() as { text: string }
      sent.push(`remember ${text}`)
      const item = {
        id: 'm-aaaaaaaaaaaa',
        text,
        source: 'Agent notes',
        at: new Date().toISOString(),
      }
      state.memory = [item, ...state.memory!]
      return route.fulfill({ json: item })
    }
    const q = new URL(request.url()).searchParams.get('q')?.toLowerCase()
    const items = state.memory!.filter((item) => !q || item.text.toLowerCase().includes(q))
    return route.fulfill({ json: { items, nextCursor: null } })
  })
  await page.route('**/api/agents/reviewer/memory/*', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').pop()!
    sent.push(`forget ${id}`)
    state.memory = state.memory!.filter((item) => item.id !== id)
    await route.fulfill({ json: { id } })
  })
  await page.route('**/api/agents/reviewer/tools/*', async (route) => {
    const { enabled } = route.request().postDataJSON() as { enabled: boolean }
    const id = new URL(route.request().url()).pathname.split('/').pop()!
    sent.push(`tool ${id} ${enabled}`)
    state.tools = state.tools!.map((tool) => (tool.id === id ? { ...tool, enabled } : tool))
    await route.fulfill({ json: state.tools.find((tool) => tool.id === id) })
  })

  await page.goto('/b/team/reviewer')
  await expect(page.getByRole('heading', { name: 'reviewer', level: 1 })).toBeVisible()

  // Model: the "Runs on" card
  const runsOn = page.locator('#agent-model')
  const modelForm = runsOn.getByRole('form', { name: 'Change model' })
  await modelForm.getByLabel('Model', { exact: true }).fill('demo/next-model')
  await modelForm.getByRole('button', { name: 'Change model' }).click()
  await expect(runsOn.getByText('Saved: demo/next-model')).toBeVisible()

  await page
    .getByRole('button', { name: 'More: memory, skills, tools, workspace, repeating jobs, delete' })
    .click()

  // Skills: turn one off, then find and add one from the (fake) hub
  const skills = page.locator('#agent-skills')
  const review = skills.locator('.chip').filter({ hasText: 'code-review' })
  await expect(review).not.toHaveClass(/bold-mc-off/)
  await review.getByRole('button', { name: 'Turn off code-review' }).click()
  await expect(review).toHaveClass(/bold-mc-off/)
  await expect(review.getByRole('button', { name: 'Turn on code-review' })).toBeVisible()
  await skills.getByLabel('Find a skill').fill('changelog')
  await skills.getByRole('button', { name: 'Search', exact: true }).click()
  await skills.getByRole('button', { name: 'Add changelog-writer' }).click()
  await expect(skills.getByRole('button', { name: 'Installed changelog-writer' })).toBeDisabled()
  await expect(skills.getByRole('button', { name: 'Turn off changelog-writer' })).toBeVisible()

  // Memory: add, then forget
  const memory = page.locator('#agent-memory')
  await expect(memory.getByText('Releases go out on Fridays.')).toBeVisible()
  await memory.getByLabel('New memory').fill('The demo is on Monday.')
  await memory.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(memory.getByText('The demo is on Monday.')).toBeVisible()
  await memory.getByRole('button', { name: /^Forget: The demo is on Monday/ }).click()
  await expect(memory.getByText('The demo is on Monday.')).toHaveCount(0)
  await expect(memory.getByText('Releases go out on Fridays.')).toBeVisible()

  // Tools: toggle a built-in; the tool servers are read-only here and managed in Settings
  const tools = page.locator('#agent-tools')
  const browser = tools.getByRole('checkbox', { name: 'Browser Automation' })
  await expect(browser).not.toBeChecked()
  await browser.click()
  await expect(browser).toBeChecked()
  await expect(tools.getByText(/Tool servers:/)).toBeVisible()
  await expect(tools.getByRole('link', { name: 'Manage' })).toHaveAttribute(
    'href',
    '/b/settings/tools',
  )

  expect(sent).toEqual([
    'model demo/next-model undefined',
    'skill code-review false',
    'install example/skills/changelog-writer',
    'remember The demo is on Monday.',
    'forget m-aaaaaaaaaaaa',
    'tool browser true',
  ])
})

test('the fake server serves the tab reads and rejects unpaired writes', async ({ request }) => {
  const skills = await request.get('/api/agents/lead/skills')
  expect((await skills.json()).items.length).toBeGreaterThan(0)
  const memory = await request.get('/api/agents/lead/memory?q=friday')
  expect((await memory.json()).items).toHaveLength(1)
  const hub = await request.get('/api/skills/hub?q=changelog')
  expect((await hub.json()).items[0].name).toBe('changelog-writer')
  const denied = await request.patch('/api/agents/lead/tools/web', {
    headers: { 'x-score-client': 'web' },
    data: { enabled: false },
  })
  expect([401, 403]).toContain(denied.status())
})
