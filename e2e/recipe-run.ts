import { expect, type Page } from '@playwright/test'
import { makeTeam, startInOwnChat } from './one-job-helpers.ts'

// Starting a recipe from the Recipes page (2.8.0): Run… opens Start a job with the recipe chosen, and the run then opens
// on its own page. Shared by the specs that used to start a workflow from the classic list.

const web = { 'x-score-client': 'web' }

export async function recipeIdByName(page: Page, name: string): Promise<string> {
  let id = ''
  await expect(async () => {
    const response = await page.request.get('/api/workflows', { headers: web })
    const found = ((await response.json()) as { items: { id: string; name: string }[] }).items.find(
      (item) => item.name === name,
    )
    expect(found).toBeTruthy()
    id = found!.id
  }).toPass({ timeout: 20_000 })
  return id
}

/** With Start a job open on a recipe: fill its inputs, accept, start, and wait for "Started". */
export interface StartOptions {
  /** Start a job defaults to a $5 spend cap, under which a step of unknown cost pauses; the classic dialog had none. */
  noBudget?: boolean
}

export async function finishStartJob(
  page: Page,
  inputs: Record<string, string> = {},
  options: StartOptions = {},
) {
  const dialog = page.getByRole('dialog', { name: 'Start a job' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('version')
  for (const [label, value] of Object.entries(inputs))
    await dialog.getByLabel(new RegExp(`^${label}`)).fill(value)
  if (options.noBudget) await dialog.getByLabel(/^Spend cap/).fill('0')
  await dialog.getByRole('checkbox', { name: /Score controls the work it starts/ }).check()
  const start = dialog.getByRole('button', { name: 'Start the job' })
  await expect(start).toBeEnabled({ timeout: 30_000 })
  // 3.28.0: Run… opens in the team room, which holds jobs already; the run starts in a chat of its own.
  await startInOwnChat(page, 'Recipe')
  await expect(dialog.getByRole('heading', { name: 'Started' })).toBeVisible({ timeout: 30_000 })
}

/** Opens the page of the newest run of a recipe. */
export async function openRunOf(page: Page, workflowId: string) {
  let briefId = ''
  await expect(async () => {
    const response = await page.request.get('/api/workflow-runs', { headers: web })
    const run = (
      (await response.json()) as { items: { workflowId: string; briefId: string }[] }
    ).items.find((item) => item.workflowId === workflowId)
    expect(run).toBeTruthy()
    briefId = run!.briefId
  }).toPass({ timeout: 20_000 })
  // 3.29.0: a run is read in its chat (no run page): `/b?run=` lands on the chat with the Graph tab open, where the run
  // card, the graph, the session log and the needs-you cards are.
  await page.goto(`/b?run=${encodeURIComponent(briefId)}`)
}

/** Starts a saved recipe by its id from its page and lands on the run. */
export async function startRecipe(
  page: Page,
  id: string,
  inputs: Record<string, string> = {},
  options: StartOptions = {},
) {
  await page.goto(`/b/recipes/${id}`)
  await expect(page.getByRole('region', { name: 'Recipe editor' })).toBeVisible()
  // 3.29.0: Run… is in the editor's ⋯ menu.
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('group', { name: 'More' }).getByRole('button', { name: 'Run…' }).click()
  await finishStartJob(page, inputs, options)
  await openRunOf(page, id)
}

export async function startRecipeByName(
  page: Page,
  name: string,
  inputs: Record<string, string> = {},
  options: StartOptions = {},
) {
  await startRecipe(page, await recipeIdByName(page, name), inputs, options)
}

export const startPolicyA = 'a'.repeat(64)
export const startPolicyB = 'b'.repeat(64)

/**
 * Start a job on a saved plain Hermes recipe whose preflight is answered as if one of its agents were a Codex coding agent
 * with reach beyond its workspace. Nothing is created: the browser's own POST is answered 409 `policy_changed` and its
 * body recorded. `policy.id` is what the next preflight says.
 */
export async function openCodingRecipeStart(page: Page, label: string) {
  // Tests run in parallel on one server: the name must be unique to this test.
  const name = `${label} ${Math.random().toString(36).slice(2, 7)}`
  const created = await page.request.post('/api/workflows', {
    headers: web,
    data: {
      definition: {
        name,
        inputs: [],
        nodes: [
          {
            id: 'one',
            kind: 'agent',
            label: 'First',
            agentId: 'builder',
            instruction: 'Say hello',
            retries: 0,
            onFailure: 'fail_run',
          },
          { id: 'done', kind: 'end', label: 'Done' },
        ],
        edges: [{ id: 'e1', from: 'one', port: 'ok', to: 'done' }],
      },
    },
  })
  expect(created.ok()).toBe(true)
  const id = ((await created.json()) as { workflowId: string }).workflowId
  const policy = { id: startPolicyA }
  const bodies: Record<string, unknown>[] = []
  await page.route('**/api/workflow-runs/preflight*', async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as Record<string, unknown> & {
      defaults: Record<string, unknown>
    }
    body.workers = [
      {
        agentId: 'builder',
        runtime: 'codex',
        readiness: 'ready',
        detail: null,
        policyId: policy.id,
        reach:
          'Reads any file you can read, not only the ones in /work/site. It changes files only in /work/site.',
        reachBeyondWorkspace: true,
      },
    ]
    body.defaults = { ...body.defaults, codingSteps: 4 }
    await route.fulfill({ response, json: body })
  })
  await page.route('**/api/workflow-runs', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    bodies.push(route.request().postDataJSON() as Record<string, unknown>)
    await route.fulfill({
      status: 409,
      json: {
        error: { code: 'policy_changed', message: 'changed', details: { agentId: 'builder' } },
      },
    })
  })
  // 3.28.0: the seeded team room holds jobs, so the start opens in a team of its own.
  const team = await makeTeam(page, 'Coding')
  await page.goto(`/b?room=${team.id}&start=job&recipe=${id}`)
  const dialog = page.getByRole('dialog', { name: 'Start a job' })
  await expect(dialog.getByRole('radio', { name })).toBeChecked({ timeout: 30_000 })
  return { dialog, bodies, policy, id }
}

/**
 * A recipe name no other spec can share: the fake server is shared by every worker, a millisecond stamp alone can repeat,
 * and the prefix of one name can sit inside another's (the Start a job picker matches names as substrings).
 */
export function uniqueRecipeName(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/**
 * 3.29.0: a frozen run read in its chat. The old run page (Steps tab with the decision cards, Graph tab) is gone; a
 * run's decisions are the needs-you cards of its chat and its diagram is the chat's Graph tab. This opens the team room
 * with one job linked to the run and answers every other read from `reads` (path + query -> body). Every POST is recorded
 * into `posted` and answered 500 ("stop here"), as the frozen pages did.
 */
export async function openFrozenRunInChat(
  page: Page,
  options: {
    recipe: { kind: 'orchestration' | 'workflow'; ref: string }
    reads: Record<string, unknown>
    posted: { url: string; body: unknown }[]
  },
) {
  const at = '2026-10-24T10:00:00.000Z'
  const job = (id: string, title: string, extra: Record<string, unknown>) => ({
    id,
    roomId: 'team-room',
    title,
    state: 'working',
    holderAgentId: 'lead',
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
    createdAt: at,
    updatedAt: at,
    ...extra,
  })
  const { openBoldRoom } = await import('./bold-room-fixtures.ts')
  await openBoldRoom(page, {
    jobs: [
      job('job-default', 'Team room', { isDefault: true }),
      job('job-run', 'The run', { state: 'waiting_on_you', recipe: options.recipe }),
    ],
    approvals: [],
    exchanges: [],
    handle: (request) => {
      if (request.method === 'POST') {
        options.posted.push({ url: request.path, body: request.body })
        return { status: 500, body: { error: { code: 'x', message: 'stop here' } } }
      }
      const query = request.search.toString()
      const key = query ? `${request.path}?${query}` : request.path
      const found = options.reads[key] ?? options.reads[request.path]
      return found === undefined ? undefined : { body: found }
    },
  })
}
