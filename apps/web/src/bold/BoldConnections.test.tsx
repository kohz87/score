import type { AgentSummary, MessagingPlatform, ProviderItem } from '@score/contract'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { BoldConnections } from './BoldConnections.tsx'

const builder: AgentSummary = {
  id: 'builder',
  name: 'Builder',
  role: 'Builds it',
  style: { color: '#19c39a', shape: 'triangle' },
  status: 'idle',
  activity: null,
  model: { id: 'm-2', label: 'Model Two' },
  served: true,
}

let providers: ProviderItem[]
let messaging: MessagingPlatform[]
let calls: { url: string; method: string; body: unknown }[]

beforeEach(() => {
  calls = []
  providers = [
    {
      id: 'openrouter',
      label: 'OpenRouter',
      status: 'missing',
      detail: 'Not connected',
      usedBy: ['builder'],
      signIn: 'api_key',
    },
    {
      id: 'demo',
      label: 'Demo',
      status: 'connected',
      detail: 'Built-in demo models',
      usedBy: [],
      signIn: 'terminal',
    },
  ]
  messaging = [
    { platform: 'telegram', label: 'Telegram', status: 'connected', detail: null },
    { platform: 'discord', label: 'Discord', status: 'disconnected', detail: null },
  ]
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://x')
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : null
      calls.push({ url: url.pathname, method, body })
      if (url.pathname === '/api/system')
        return Response.json({
          mode: 'fake',
          hermes: {
            version: '0.15.2',
            reachable: true,
            apiServer: true,
            capabilities: [],
            servedProfiles: [],
          },
          bridge: { producers: 1, lastSeenAt: null, isolation: 'unknown' },
          compatibility: { fingerprint: 'f', tested: true, disabled: [] },
          agentIsolation: 'same_user',
          degraded: [],
        })
      if (url.pathname === '/api/settings/providers') return Response.json({ items: providers })
      if (url.pathname === '/api/settings/providers/openrouter/key' && method === 'POST') {
        providers = providers.map((provider) =>
          provider.id === 'openrouter'
            ? { ...provider, status: 'connected', detail: 'API key (1)' }
            : provider,
        )
        return Response.json(providers.find((provider) => provider.id === 'openrouter'))
      }
      if (url.pathname === '/api/settings/providers/local' && method === 'POST') {
        const provider: ProviderItem = {
          id: 'local-box',
          label: body.label,
          status: 'connected',
          detail: '127.0.0.1',
          usedBy: [],
        }
        providers = [...providers, provider]
        return Response.json(provider)
      }
      if (url.pathname === '/api/settings/connections')
        return Response.json({
          toolServers: [{ id: 'files', label: 'files', status: 'ok', usedBy: 'everyone' }],
          messaging,
        })
      if (url.pathname === '/api/settings/messaging/discord/fields')
        return Response.json({
          fields: [
            {
              key: 'DISCORD_BOT_TOKEN',
              label: 'Bot token',
              help: null,
              url: null,
              secret: true,
              required: true,
            },
          ],
          browserSetup: true,
        })
      if (url.pathname === '/api/settings/messaging/discord' && method === 'PUT') {
        messaging = messaging.map((row) =>
          row.platform === 'discord' ? { ...row, status: 'connected', detail: null } : row,
        )
        return Response.json(messaging.find((row) => row.platform === 'discord'))
      }
      if (url.pathname === '/api/session/browsers') return Response.json({ items: [{}, {}] })
      if (url.pathname === '/api/session/security')
        return Response.json({
          passwordSet: true,
          origins: [],
          terminal: false,
          terminalUnavailable: null,
        })
      return Response.json({ error: { code: 'not_found', message: 'No' } }, { status: 404 })
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <BoldConnections agents={[builder]} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

test('an API-key provider connects through the classic panel and the row updates', async () => {
  mount()
  const row = await waitFor(() => {
    const found = document.querySelector('[data-provider-id="openrouter"]')
    expect(found).not.toBeNull()
    return found as HTMLElement
  })
  fireEvent.click(within(row).getByRole('button', { name: 'Connect OpenRouter' }))
  fireEvent.change(await screen.findByLabelText('API key'), {
    target: { value: 'sk-or-example-key' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save key' }))
  expect(await screen.findByText('OpenRouter is connected.')).toBeDefined()
  await waitFor(() =>
    expect(document.querySelector('[data-provider-id="openrouter"]')?.textContent).toContain(
      'API key (1)',
    ),
  )
  const call = calls.find(({ url }) => url === '/api/settings/providers/openrouter/key')
  expect(call?.body).toEqual({ apiKey: 'sk-or-example-key' })
})

test('a channel uses the same browser setup form as classic Settings', async () => {
  mount()
  const row = await waitFor(() => {
    const found = document.querySelector('[data-channel="discord"]')
    expect(found).not.toBeNull()
    return found as HTMLElement
  })
  fireEvent.click(within(row).getByRole('button', { name: 'Connect Discord' }))
  fireEvent.change(await screen.findByLabelText('Bot token'), {
    target: { value: 'discord-secret-token' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(await screen.findByText(/Saved. The gateway picks up/)).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Done' }))
  await waitFor(() =>
    expect(document.querySelector('[data-channel="discord"]')?.textContent).toContain('Connected'),
  )
  const call = calls.find(
    ({ url, method }) => url === '/api/settings/messaging/discord' && method === 'PUT',
  )
  expect(call?.body).toEqual({ values: { DISCORD_BOT_TOKEN: 'discord-secret-token' } })
})

test('a local OpenAI-compatible endpoint can be added', async () => {
  mount()
  const local = await waitFor(() => {
    const found = document.querySelector('[data-provider-id="local"]')
    expect(found).not.toBeNull()
    return found as HTMLElement
  })
  fireEvent.click(within(local).getByRole('button', { name: 'Add' }))
  fireEvent.change(within(local).getByLabelText('Name'), { target: { value: 'Local box' } })
  fireEvent.change(within(local).getByLabelText('Address'), {
    target: { value: 'http://127.0.0.1:8080/v1' },
  })
  fireEvent.change(within(local).getByLabelText('Model'), { target: { value: 'local-model' } })
  fireEvent.click(within(local).getByRole('button', { name: 'Add model' }))
  expect(await screen.findByText('Added Local box.')).toBeDefined()
  await waitFor(() => expect(screen.getByText('Local box')).toBeDefined())
})
