import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, vi } from 'vitest'
import {
  okValidation,
  releaseDefinition,
  releaseVersion,
  unfinishedValidation,
  workflowFixtures,
} from '../../../../e2e/workflow-fixtures.ts'
import { createQueryClient, StreamContext } from '../data/query-client.ts'
import { createStreamQueryRegistry } from '../data/resync.ts'
import { createStreamClient } from '../data/stream.ts'
import { BoldRecipesPage } from './BoldRecipes.tsx'

class Source extends EventTarget {
  close() {}
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
const agents = [
  {
    id: 'builder',
    name: 'builder',
    role: '',
    style: { color: '#19C39A', shape: 'square' },
    status: 'idle',
    activity: null,
    model: null,
    served: true,
  },
  {
    id: 'reviewer',
    name: 'reviewer',
    role: '',
    style: { color: '#FFB61E', shape: 'triangle' },
    status: 'idle',
    activity: null,
    model: null,
    served: true,
  },
]

export type PostHandler = (url: string, init?: RequestInit) => Response | undefined

type RecipeTestOptions = {
  getPost?: () => PostHandler
  resetPost?: () => void
}

export function setUpRecipeTests(options: RecipeTestOptions = {}) {
  const requests: { url: string; init?: RequestInit }[] = []
  const disposers: (() => void)[] = []
  let post: PostHandler = () => undefined
  const getPost = options.getPost ?? (() => post)
  const resetPost =
    options.resetPost ??
    (() => {
      post = () => undefined
    })

  beforeEach(() => {
    requests.length = 0
    resetPost()
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
        requests.push({ url, ...(init ? { init } : {}) })
        const method = init?.method ?? 'GET'
        if (method === 'POST') {
          const custom = getPost()(url, init)
          if (custom) return Promise.resolve(custom)
        }
        if (url === '/api/workflows/validate' && method === 'POST') {
          const body = JSON.parse(String(init?.body)) as { definition: { name: string } }
          return Promise.resolve(
            json(body.definition.name.includes('(draft)') ? unfinishedValidation : okValidation),
          )
        }
        if (url === '/api/workflows/wf-release/versions' && method === 'POST') {
          const body = JSON.parse(String(init?.body)) as { definition: typeof releaseDefinition }
          return Promise.resolve(
            json({ ...releaseVersion, version: 2, definition: body.definition }),
          )
        }
        if (url === '/api/agents') return Promise.resolve(json({ asOfSeq: 1, items: agents }))
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
    disposers.splice(0).forEach((dispose) => dispose())
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function mount(path = '/b/settings/recipes/wf-release') {
    const queryClient = createQueryClient()
    const client = createStreamClient({ EventSourceImpl: Source })
    const queries = createStreamQueryRegistry(queryClient, client)
    disposers.push(() => {
      queries.dispose()
      client.close()
      queryClient.clear()
    })
    const router = createMemoryRouter(
      [
        { path: '/b/settings/recipes', Component: BoldRecipesPage },
        { path: '/b/settings/recipes/:workflowId', Component: BoldRecipesPage },
        { path: '*', element: <p>elsewhere</p> },
      ],
      { initialEntries: [path] },
    )
    render(
      <QueryClientProvider client={queryClient}>
        <StreamContext value={{ client, queries }}>
          <RouterProvider router={router} />
        </StreamContext>
      </QueryClientProvider>,
    )
    return router
  }

  const saveButton = () =>
    screen.getByRole('button', { name: 'Save as version 2' }) as HTMLButtonElement

  /** The editor opens on the graph; the step list is the "As text" tab. */
  async function showText() {
    fireEvent.click(await screen.findByRole('tab', { name: 'As text' }))
    return screen.findByRole('list', { name: 'Steps' })
  }

  const phoneMedia = () =>
    vi.stubGlobal(
      'matchMedia',
      (query: string) =>
        ({
          matches: query.includes('width < 600px') || query.includes('width <= 860px'),
          media: query,
          addEventListener() {},
          removeEventListener() {},
        }) as unknown as MediaQueryList,
    )

  const withStoredLayout = () => {
    const drawn = structuredClone(workflowFixtures['/api/workflows/wf-release']) as {
      latest: { definition: { layout?: unknown } }
    }
    drawn.latest.definition.layout = {
      nodes: { draft: { x: 640, y: 480 }, review: { x: 16, y: 16 }, publish: { x: 320, y: 160 } },
    }
    const original = workflowFixtures['/api/workflows/wf-release']
    workflowFixtures['/api/workflows/wf-release'] = drawn
    disposers.push(() => {
      workflowFixtures['/api/workflows/wf-release'] = original
    })
  }

  return {
    requests,
    json,
    mount,
    saveButton,
    showText,
    phoneMedia,
    withStoredLayout,
  }
}
