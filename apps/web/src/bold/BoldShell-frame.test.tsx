import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { expect, test, vi } from 'vitest'
import { agents, open, shellState } from './BoldShell-helpers.tsx'

test('/b draws the frame, and the top bar has no agent row', async () => {
  open('/b')
  expect(screen.getByRole('banner')).toBeDefined()
  expect(screen.getByRole('main')).toBeDefined()
  expect(screen.getByRole('complementary', { name: 'Side panel' })).toBeDefined()
  expect(screen.getByRole('button', { name: 'Score, go to the team room' })).toBeDefined()
  expect(screen.getByRole('button', { name: 'Agents' })).toBeDefined()
  // The title has no switcher: the chat list switches chats, and the room menu keeps the older ones.
  expect(screen.getByRole('heading', { name: 'Team room' })).toBeDefined()
  expect(screen.queryByRole('button', { name: 'Team room' })).toBeNull()

  // Decision 184: the top bar has no agent row; who needs you is the count on Chats and the chat rows.
  expect(screen.queryByRole('group', { name: /Your team/ })).toBeNull()
  expect(screen.queryByText('Rings show progress')).toBeNull()
  expect(document.querySelector('.dock, .ring')).toBeNull()
  const nav = screen.getByRole('navigation', { name: 'Main' })
  expect(
    within(nav)
      .getAllByRole('button')
      .map((button) => button.textContent?.replace(/\d+$/, '')),
  ).toEqual(expect.arrayContaining(['Chats', 'Agents']))
})

test('a phone keeps the wordmark and avatar, shows the tab bar and opens the side panel as a sheet', async () => {
  shellState.phone = true
  open('/b?open=1')
  const nav = screen.getByRole('navigation', { name: 'Main' })
  for (const label of ['Chats', 'Agents', 'Knowledge', 'Search', 'Settings'])
    expect(within(nav).getByRole('button', { name: label })).toBeDefined()
  expect(screen.queryByRole('complementary', { name: 'Side panel' })).toBeNull()
  expect(screen.queryByRole('group', { name: /Your team/ })).toBeNull()
  expect(screen.getByRole('button', { name: 'Score, go to the team room' })).toBeDefined()
  expect(screen.getByText('Y')).toBeDefined()
  const openPanel = screen.getByRole('button', { name: 'Chat info' })
  expect(openPanel.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(openPanel)
  const panel = screen.getByRole('complementary', { name: 'Side panel' })
  expect(panel.getAttribute('aria-modal')).toBe('true')
  expect(openPanel.getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByRole('banner').hasAttribute('inert')).toBe(true)
  expect(nav.hasAttribute('inert')).toBe(true)
  expect(document.querySelector('.roomcol')?.hasAttribute('inert')).toBe(true)
  const close = screen.getByRole('button', { name: 'Close side panel' })
  await waitFor(() => expect(document.activeElement).toBe(close))
  fireEvent.click(close)
  expect(screen.queryByRole('complementary', { name: 'Side panel' })).toBeNull()
  expect(document.getElementById('bold-side-panel')).not.toBeNull()
  expect(document.querySelector('.bold-sidecol')?.hasAttribute('hidden')).toBe(true)
  expect(screen.getByRole('banner').hasAttribute('inert')).toBe(false)
  expect(nav.hasAttribute('inert')).toBe(false)
  expect(document.querySelector('.roomcol')?.hasAttribute('inert')).toBe(false)
  const openPanelAgain = screen.getByRole('button', { name: 'Chat info' })
  await waitFor(() => expect(document.activeElement).toBe(openPanelAgain))
})

test('Agents, Knowledge and Settings are real pages, and the search button and Ctrl+K open the palette', async () => {
  open('/b')
  fireEvent.click(screen.getByRole('button', { name: 'Agents' }))
  expect(await screen.findByRole('heading', { name: 'Agents' })).toBeDefined()
  expect(screen.getByRole('button', { name: 'Pause everyone' })).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
  expect(await screen.findByRole('heading', { name: 'Settings' })).toBeDefined()
  expect(await screen.findByRole('heading', { name: 'Usage' })).toBeDefined()

  fireEvent.click(screen.getByRole('button', { name: 'Search' }))
  const palette = await screen.findByRole('dialog', { name: 'Search and commands' })
  fireEvent.click(within(palette).getByRole('button', { name: 'Close search' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
  expect(await screen.findByRole('dialog', { name: 'Search and commands' })).toBeDefined()
})

test('Look choices apply to the whole bold shell', async () => {
  window.localStorage.setItem('score.theme', 'light')
  window.localStorage.setItem('score.textScale', '1.15')
  open('/b')
  const shell = document.querySelector<HTMLElement>('.bold-shell')!
  await waitFor(() => expect(shell.dataset.look).toBe('light'))
  expect(shell.style.getPropertyValue('--scale')).toBe('1.15')
})

test.each(['ctrlKey', 'metaKey'])(
  '%s+K does nothing while the palette is already open',
  async (modifier) => {
    vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => {
      run(0)
      return 1
    })
    open('/b')
    const trigger = screen.getByRole('button', { name: 'Search' })
    trigger.focus()
    fireEvent.click(trigger)
    const palette = await screen.findByRole('dialog', { name: 'Search and commands' })
    fireEvent.keyDown(document, { key: 'k', [modifier]: true })
    expect(screen.getByRole('dialog', { name: 'Search and commands' })).toBeDefined()
    fireEvent.click(within(palette).getByRole('button', { name: 'Close search' }))
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  },
)

test('the index opens the new shell', async () => {
  const bold = open('/')
  await waitFor(() => expect(bold.state.location.pathname).toBe('/b'))
})

test('the shell mounts the notification bridge and the update banner', async () => {
  open('/b')
  expect(await screen.findByTestId('notification-bridge')).toBeDefined()
  expect(screen.getByTestId('update-banner')).toBeDefined()
})

// was: 'a removed agent leaves the dock and the Direct list; one setting up stays in the dock only' (the dock is gone, 184)
test('a removed agent, and one still setting up, are not in the Direct list', async () => {
  const base = agents[1]!
  shellState.extraAgents = [
    {
      ...base,
      id: 'gone',
      name: 'gone',
      lifecycle: {
        state: 'removed',
        incarnationId: '00000000-0000-4000-8000-000000000001',
        operationId: null,
      },
    },
    {
      ...base,
      id: 'fresh',
      name: 'fresh',
      lifecycle: {
        state: 'setting_up',
        incarnationId: '00000000-0000-4000-8000-000000000002',
        operationId: '00000000-0000-4000-8000-000000000003',
      },
    },
  ]
  open('/b')
  const chats = await screen.findByRole('complementary', { name: 'Chats' })
  const direct = within(within(chats).getByRole('heading', { name: 'Direct' }).parentElement!)
  await direct.findByRole('link', { name: /builder/ })
  expect(direct.queryByRole('link', { name: /gone/ })).toBeNull()
  expect(direct.queryByRole('link', { name: /fresh/ })).toBeNull()
})

// New (3.22.0 item 11): the phone top bar fits one row with the terminal button on.
test('the phone top bar keeps wordmark, section pills, terminal button and avatar in one row', async () => {
  shellState.phone = true
  shellState.terminalFixture = { terminal: true, terminalUnavailable: null }
  open('/b')
  const terminal = await screen.findByRole('button', { name: 'Terminal' })
  const bar = screen.getByRole('banner')
  const mark = within(bar).getByRole('button', { name: 'Score, go to the team room' })
  const avatar = within(bar).getByText('Y')
  const links = bar.querySelector('.bold-top-links') as HTMLElement
  for (const name of ['Tasks', 'Screens'])
    expect(within(links).getByRole('button', { name })).toBeDefined()
  // 3.27.0: Recipes moved into Settings.
  expect(within(links).queryByRole('button', { name: 'Recipes' })).toBeNull()
  // All four parts are direct children of the one bar, in reading order, and nothing else is on a phone's bar.
  const parts = [...bar.children]
  expect(parts).toEqual([mark, links, terminal, avatar])
  expect(terminal.classList.contains('sm')).toBe(true)

  // jsdom has no layout, so the rules that keep it on one row are read from the stylesheet: the bar never wraps on a
  // phone, the pills take only the room that is left and scroll, and the other three parts never shrink.
  const css = readFileSync(`${__dirname}/bold-topbar.css`, 'utf8')
  const phoneRules = readFileSync(`${__dirname}/bold-responsive.css`, 'utf8')
  expect(phoneRules).toMatch(/\.top \{[^}]*flex-wrap: nowrap/)
  expect(css).toMatch(/\.bold-top-links \{[^}]*flex: 1 1 0;[^}]*overflow-x: auto/)
  const chatsCss = readFileSync(`${__dirname}/chats/chats-conversation.css`, 'utf8')
  expect(chatsCss).toMatch(
    /\.top \.word,\s*\[data-ui='bold'\] \.bold-avatar,\s*\[data-ui='bold'\] \.bold-terminal-btn \{\s*flex-shrink: 0/,
  )
})
