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
      if (method === 'DELETE' && url.pathname === '/api/settings/providers/openrouter')
        return Response.json(
          {
            error: {
              code: 'provider_in_use',
              message: 'builder uses OpenRouter. Pick another model there first.',
            },
          },
          { status: 409 },
        )
      if (method === 'DELETE' && url.pathname === '/api/settings/providers/demo') {
        providers = providers.filter((provider) => provider.id !== 'demo')
        return new Response(null, { status: 204 })
      }
      if (method === 'DELETE' && url.pathname === '/api/settings/messaging/telegram') {
        messaging = messaging.map((row) =>
          row.platform === 'telegram' ? { ...row, status: 'disconnected' } : row,
        )
        return Response.json(messaging.find((row) => row.platform === 'telegram'))
      }
      if (url.pathname === '/api/settings/messaging/telegram/fields')
        return Response.json({ fields: [], browserSetup: true })
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
      if (url.pathname === '/api/session/browsers')
        return Response.json({
          items: [
            '11111111-1111-4111-8111-111111111111',
            '22222222-2222-4222-8222-222222222222',
          ].map((id, index) => ({
            id,
            label: index === 0 ? 'This browser' : 'Phone',
            address: '127.0.0.1',
            createdAt: '2026-10-24T09:00:00.000Z',
            lastSeenAt: '2026-10-24T10:00:00.000Z',
            expiresAt: '2026-11-24T10:00:00.000Z',
            current: index === 0,
          })),
        })
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
  expect(document.querySelector('.bold-connect-panel')?.getAttribute('data-protected')).toBe(
    'block',
  )
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
  expect(document.querySelector('.bold-connect-panel')?.getAttribute('data-protected')).toBe(
    'block',
  )
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

test('the phone card points at the real pairing flow instead of promising a QR it does not draw', async () => {
  mount()
  expect(await screen.findByRole('heading', { name: 'Your phone' })).toBeDefined()
  expect(screen.queryByText(/Scan to open/)).toBeNull()
  const link = screen.getByRole('link', { name: 'Pair another device or manage devices' })
  expect(link.getAttribute('href')).toBe('/b/settings/security')
  expect(await screen.findByText(/2 devices paired/)).toBeDefined()
})

test('removing a provider asks first, in plain words, from a protected confirm', async () => {
  mount()
  const row = await waitFor(() => {
    const found = document.querySelector('[data-provider-id="demo"]')
    expect(found).not.toBeNull()
    return found as HTMLElement
  })
  fireEvent.click(within(row).getByRole('button', { name: 'Remove Demo' }))
  const confirm = within(row).getByRole('group', { name: 'Remove Demo' })
  expect(confirm.getAttribute('data-protected')).toBe('block')
  expect(confirm.textContent).toContain(
    'Removes Demo and its stored sign-in or key from Hermes. Agents can’t use it until you connect it again.',
  )
  expect(calls.some(({ method }) => method === 'DELETE')).toBe(false)
  fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))
  expect(within(row).queryByRole('group', { name: 'Remove Demo' })).toBeNull()
  fireEvent.click(within(row).getByRole('button', { name: 'Remove Demo' }))
  fireEvent.click(within(row).getByRole('button', { name: 'Remove' }))
  await waitFor(() => expect(document.querySelector('[data-provider-id="demo"]')).toBeNull())
  expect(
    calls.some(({ url, method }) => method === 'DELETE' && url.endsWith('/providers/demo')),
  ).toBe(true)
})

test('a refusal from the server is shown verbatim and nothing is removed', async () => {
  providers[0] = { ...providers[0]!, status: 'connected', detail: 'API key (1)' }
  mount()
  const row = await waitFor(() => {
    const found = document.querySelector('[data-provider-id="openrouter"]')
    expect(found).not.toBeNull()
    return found as HTMLElement
  })
  fireEvent.click(within(row).getByRole('button', { name: 'Remove OpenRouter' }))
  fireEvent.click(within(row).getByRole('button', { name: 'Remove' }))
  expect((await within(row).findByRole('alert')).textContent).toBe(
    'builder uses OpenRouter. Pick another model there first.',
  )
  expect(document.querySelector('[data-provider-id="openrouter"]')).not.toBeNull()
})

test('a connected browser-setup channel can be disconnected', async () => {
  mount()
  const row = await waitFor(() => {
    const found = document.querySelector('[data-channel="telegram"]')
    expect(found).not.toBeNull()
    return found as HTMLElement
  })
  fireEvent.click(await within(row).findByRole('button', { name: 'Disconnect Telegram' }))
  expect(within(row).getByRole('group', { name: 'Remove Telegram' }).textContent).toContain(
    'Clears Telegram’s settings. It disconnects when the gateway restarts.',
  )
  fireEvent.click(within(row).getByRole('button', { name: 'Remove' }))
  await waitFor(() => expect(row.textContent).toContain('Not connected'))
})

test('the local model form says every agent can use it', async () => {
  mount()
  const local = await waitFor(() => {
    const found = document.querySelector('[data-provider-id="local"]')
    expect(found).not.toBeNull()
    return found as HTMLElement
  })
  fireEvent.click(within(local).getByRole('button', { name: 'Add' }))
  expect(within(local).getByText('Every agent can use it.')).toBeDefined()
})
