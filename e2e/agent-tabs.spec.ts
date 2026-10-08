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

// Edits need a paired browser and the single-use pairing link belongs to chat-composer.spec.ts, so the
// writes are answered here. Reads come from the fake server and seed the state, so this exercises the real
// response shapes; the server side of every write (fake and stubbed live adapters) is in the server tests.
test('Model, Skills, Memory and Tools tabs read and edit', async ({ page }) => {
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

  await page.goto('/team/reviewer')
  await expect(page.getByRole('heading', { name: 'reviewer', level: 1 })).toBeVisible()

  // Model
  await page.getByRole('tab', { name: 'Model' }).click()
  const modelForm = page.getByRole('form', { name: 'Change model' })
  await modelForm.getByLabel('Model', { exact: true }).fill('demo/next-model')
  await modelForm.getByRole('button', { name: 'Change model' }).click()
  await expect(page.getByText('Model changed to demo/next-model.')).toBeVisible()

  // Skills: toggle one, then find and install one from the (fake) hub
  await page.getByRole('tab', { name: 'Skills' }).click()
  const review = page.getByRole('switch', { name: 'code-review enabled for reviewer' })
  await expect(review).toHaveAttribute('aria-checked', 'true')
  await review.click()
  await expect(review).toHaveAttribute('aria-checked', 'false')
  await page.getByRole('searchbox', { name: 'Search skills' }).fill('changelog')
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await page.getByRole('button', { name: 'Install changelog-writer' }).click()
  await expect(page.getByText('Installed changelog-writer for reviewer.')).toBeVisible()
  await expect(
    page.getByRole('switch', { name: 'changelog-writer enabled for reviewer' }),
  ).toBeVisible()

  // Memory: add, search, delete with a confirmation
  await page.getByRole('tab', { name: 'Memory' }).click()
  await expect(page.getByText('Releases go out on Fridays.')).toBeVisible()
  await page.getByLabel('New memory').fill('The demo is on Monday.')
  await page.getByRole('button', { name: 'Add memory' }).click()
  await expect(page.getByText('Memory added.')).toBeVisible()
  await expect(page.getByText('The demo is on Monday.')).toBeVisible()
  await page.getByRole('searchbox', { name: 'Search memory' }).fill('monday')
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(page.getByText('Releases go out on Fridays.')).toHaveCount(0)
  await page.getByRole('button', { name: /^Delete memory: The demo is on Monday/ }).click()
  await page.getByRole('button', { name: /^Confirm deleting memory: The demo/ }).click()
  await expect(page.getByText('Memory deleted.')).toBeVisible()
  await expect(page.getByText('No memories match.')).toBeVisible()

  // Tools: toggle a built-in; the MCP server is read-only
  await page.getByRole('tab', { name: 'Tools' }).click()
  const browser = page.getByRole('switch', { name: 'Browser Automation enabled for reviewer' })
  await expect(browser).toHaveAttribute('aria-checked', 'false')
  await browser.click()
  await expect(browser).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByText(/managed in Hermes/)).toBeVisible()

  // The Overview shows the same state from the agent detail.
  await page.getByRole('tab', { name: 'Overview' }).click()
  await expect(page.getByText('code-review · Disabled')).toBeVisible()
  await expect(page.getByText('changelog-writer')).toBeVisible()
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
