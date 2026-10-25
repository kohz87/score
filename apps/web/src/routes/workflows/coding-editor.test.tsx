import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  codingTeam,
  okValidation,
  releaseDetail,
  releaseVersion,
  workflowFixtures,
} from '../../../../../e2e/workflow-fixtures.ts'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamQueryRegistry } from '../../data/resync.ts'
import { createStreamClient } from '../../data/stream.ts'
import { WorkflowEditorRoute } from './WorkflowEditor.tsx'

// 7.7c-2 #3: the editor offers Claude Code and Codex agents for steps (with their program named), refuses Antigravity
// with the reason, and Validate's coding issues show on the step they are about, with words for what to do.

class Source extends EventTarget {
  close() {}
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
const team = [
  {
    id: 'builder',
    name: 'builder',
    role: '',
    style: { color: '#19C39A', shape: 'square' },
    status: 'idle',
  },
  ...codingTeam,
  {
    id: 'coder-c',
    name: 'coder-c',
    role: '',
    style: { color: '#6B4EFF', shape: 'diamond' },
    status: 'idle',
    runtime: 'antigravity',
  },
]
const dispose: (() => void)[] = []
let validations: unknown[]
let definition: unknown

beforeEach(() => {
  validations = []
  definition = releaseVersion.definition
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList,
  )
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/workflows/validate') {
        const sent = JSON.parse(String(init?.body)) as {
          definition: { nodes: { id: string; kind: string; agentId?: string }[] }
        }
        validations.push(sent.definition)
        // What the server's runtime validation answers for a step whose agent is Antigravity.
        const bad = sent.definition.nodes.filter((n) => n.agentId === 'coder-c')
        return Promise.resolve(
          json(
            bad.length === 0
              ? okValidation
              : {
                  ok: false,
                  stats: okValidation.stats,
                  issues: bad.map((n) => ({
                    code: 'coding_agent_unsupported',
                    severity: 'error',
                    nodeId: n.id,
                    edgeId: null,
                    field: 'agentId',
                    message:
                      'coder-c is an Antigravity agent, which can’t take workflow steps. Choose a Hermes, Claude Code or Codex agent.',
                  })),
                },
          ),
        )
      }
      if (url === '/api/agents')
        return Promise.resolve(
          json({
            asOfSeq: 1,
            items: team.map((agent) => ({ activity: null, model: null, served: true, ...agent })),
          }),
        )
      if (url === '/api/workflows/wf-release')
        return Promise.resolve(
          json({ ...releaseDetail, latest: { ...releaseVersion, definition } }),
        )
      if (url === '/api/workflows/wf-release/versions/1')
        return Promise.resolve(json({ ...releaseVersion, definition }))
      const fixture = workflowFixtures[url]
      return Promise.resolve(
        fixture === undefined
          ? json({ error: { code: 'not_found', message: 'none' } }, 404)
          : json(fixture),
      )
    }),
  )
})
afterEach(() => {
  cleanup()
  dispose.splice(0).forEach((fn) => fn())
  vi.unstubAllGlobals()
})

function mountEditor() {
  const queryClient = createQueryClient()
  const client = createStreamClient({ EventSourceImpl: Source })
  const queries = createStreamQueryRegistry(queryClient, client)
  dispose.push(() => {
    queries.dispose()
    client.close()
    queryClient.clear()
  })
  const router = createMemoryRouter(
    [{ path: '/workflows/:workflowId', element: <WorkflowEditorRoute /> }],
    { initialEntries: ['/workflows/wf-release'] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client, queries }}>
        <RouterProvider router={router} />
      </StreamContext>
    </QueryClientProvider>,
  )
}

test('the agent picker offers Claude Code and Codex agents with their program, and refuses Antigravity with the reason', async () => {
  mountEditor()
  fireEvent.click(await screen.findByRole('button', { name: /^Agent step Draft the notes/ }))
  const inspector = await screen.findByRole('complementary', { name: 'Step settings' })
  const picker = within(inspector).getByRole('combobox', { name: /^Agent/ })
  const options = within(picker)
    .getAllByRole('option')
    .map((o) => ({ text: o.textContent, disabled: (o as HTMLOptionElement).disabled }))
  expect(options).toEqual([
    { text: 'builder', disabled: false },
    { text: 'coder-a · Codex', disabled: false },
    { text: 'coder-b · Claude Code', disabled: false },
    { text: 'coder-c · Antigravity (can’t take workflow steps)', disabled: true },
  ])
  fireEvent.change(picker, { target: { value: 'coder-a' } })
  expect((picker as HTMLSelectElement).value).toBe('coder-a')
  // A coding step says what the person will be asked at the start; the canvas names the program too.
  expect(within(inspector).getByText(/Codex works on this computer/)).toBeTruthy()
  expect(
    screen.getByRole('button', { name: /^Agent step Draft the notes, coder-a \(Codex\)/ }),
  ).toBeTruthy()
})

test('Validate’s coding issue shows on the step it is about, with words for what to do, and blocks saving', async () => {
  definition = {
    ...releaseVersion.definition,
    nodes: releaseVersion.definition.nodes.map((n) =>
      n.id === 'draft' ? { ...n, agentId: 'coder-c' } : n,
    ),
  }
  mountEditor()
  const problems = await screen.findByRole('region', { name: 'Problems' })
  await within(problems).findByText(
    /coder-c is an Antigravity agent, which can’t take workflow steps/,
  )
  expect(
    within(problems).getByText(/Open the step and pick one of those from the Agent list\./),
  ).toBeTruthy()
  expect(
    await screen.findByRole('button', {
      name: /^Agent step Draft the notes, coder-c \(Antigravity\).*, 1 problem$/,
    }),
  ).toBeTruthy()
  const save = screen.getByRole('button', { name: 'Save as new version' }) as HTMLButtonElement
  await waitFor(() => expect(save.disabled).toBe(true))
  // Choosing an agent that can take the step clears it.
  fireEvent.click(within(problems).getByRole('button', { name: 'Draft the notes' }))
  const inspector = screen.getByRole('complementary', { name: 'Step settings' })
  fireEvent.change(within(inspector).getByRole('combobox', { name: /^Agent/ }), {
    target: { value: 'coder-b' },
  })
  await waitFor(() => expect(within(problems).getByText('Nothing to fix.')).toBeTruthy())
})
