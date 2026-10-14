import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { AboutSection, shellPath, updateSteps } from './AboutSection.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const about = {
  version: '1.3.0',
  commit: 'abc1234',
  schema: 67,
  contract: 1,
  hermes: { version: '0.9.0' },
  node: 'v24.0.0',
  mode: 'live',
  repository: 'https://github.com/kohz87/score',
  checkout: '/srv/my score',
}
const check = (status: string, message: string, latest: unknown = null) => ({
  checkedAt: '2026-10-14T10:00:00.000Z',
  current: '1.3.0',
  status,
  latest,
  message,
})
const latest = {
  version: '1.4.0',
  tag: 'v1.4.0',
  url: 'https://github.com/kohz87/score/releases/tag/v1.4.0',
  changelogUrl: 'https://github.com/kohz87/score/blob/v1.4.0/CHANGELOG.md',
}

function mount(update: () => Response | Promise<Response>) {
  const fetch = vi.fn((url: string) =>
    Promise.resolve(String(url).endsWith('/about') ? Response.json(about) : update()),
  )
  vi.stubGlobal('fetch', fetch)
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AboutSection />
    </QueryClientProvider>,
  )
  return fetch
}
const posts = (fetch: ReturnType<typeof mount>) =>
  fetch.mock.calls.filter(([url]) => String(url).includes('update-check'))

test('shows the version details and does not check for updates until the button is pressed', async () => {
  const fetch = mount(() => Response.json(check('up_to_date', 'x')))
  await screen.findByText('Score v1.3.0')
  for (const text of ['abc1234', '67', '0.9.0', 'v24.0.0', 'Live'])
    expect(screen.getByText(text)).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Score on GitHub' }).getAttribute('href')).toBe(
    about.repository,
  )
  expect(posts(fetch)).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
  await waitFor(() => expect(posts(fetch)).toHaveLength(1))
})

test('says you are up to date', async () => {
  mount(() => Response.json(check('up_to_date', 'You’re up to date (v1.3.0).', latest)))
  fireEvent.click(await screen.findByRole('button', { name: 'Check for updates' }))
  expect((await screen.findByRole('status')).textContent).toBe('You’re up to date (v1.3.0).')
  expect(screen.queryByRole('group', { name: 'Steps to update' })).toBeNull()
})

test('an available update links to what is new and shows the steps with a backup link first', async () => {
  mount(() => Response.json(check('update_available', 'v1.4.0 is available.', latest)))
  fireEvent.click(await screen.findByRole('button', { name: 'Check for updates' }))
  await screen.findByText('v1.4.0 is available.')
  expect(screen.getByRole('link', { name: 'What’s new' }).getAttribute('href')).toBe(
    latest.changelogUrl,
  )
  expect(screen.getByRole('link', { name: 'Release page' }).getAttribute('href')).toBe(latest.url)
  const steps = screen.getByRole('group', { name: 'Steps to update' })
  expect(steps.querySelector('a')?.getAttribute('href')).toBe('#backup')
  const text = steps.querySelector('code')?.textContent ?? ''
  expect(text.split('\n')).toEqual([
    "cd '/srv/my score'",
    'git pull --ff-only',
    'pnpm install --frozen-lockfile',
    'pnpm build',
    'scripts/score stop',
  ])
  expect(steps.textContent).toContain('start Score again the way you usually do')
})

test('says when the build is newer, and when GitHub can’t be reached', async () => {
  mount(() => Response.json(check('ahead', 'This build is newer than the latest release.')))
  fireEvent.click(await screen.findByRole('button', { name: 'Check for updates' }))
  await screen.findByText('This build is newer than the latest release.')
  cleanup()
  mount(() =>
    Response.json(
      check('unavailable', 'Couldn’t reach GitHub. Check your connection and try again.'),
    ),
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Check for updates' }))
  await screen.findByText('Couldn’t reach GitHub. Check your connection and try again.')
})

test('a failed request says what to do', async () => {
  mount(() => Response.json({ error: { code: 'not_paired', message: 'x' } }, { status: 401 }))
  fireEvent.click(await screen.findByRole('button', { name: 'Check for updates' }))
  expect((await screen.findByRole('alert')).textContent).toMatch(/Pair this browser/)
})

test('folder names with spaces or quotes are quoted for the shell', () => {
  expect(shellPath('/home/me/score')).toBe('/home/me/score')
  expect(shellPath("/home/o'brien/score")).toBe("'/home/o'\\''brien/score'")
  expect(updateSteps('/a b')[0]).toBe("cd '/a b'")
})
