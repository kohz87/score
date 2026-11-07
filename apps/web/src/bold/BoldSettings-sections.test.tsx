import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { FakeNotification, calls, open, settingsState } from './BoldSettings-helpers.tsx'

test('the nine Settings sections open their bold views, including Connections, Tools and Look', async () => {
  open('/b/settings/connections')
  expect(await screen.findByRole('heading', { name: 'Connections' })).toBeDefined()
  expect(await screen.findByRole('heading', { name: 'Hermes' })).toBeDefined()
  expect(await screen.findByText('OpenRouter')).toBeDefined()
  expect(await screen.findByText('Telegram')).toBeDefined()
  const nav = screen.getByRole('navigation', { name: 'Settings' })
  fireEvent.click(within(nav).getByRole('button', { name: /^Tools and triggers/ }))
  expect(await screen.findByRole('heading', { name: 'Tools and triggers' })).toBeDefined()
  expect(await screen.findByText('files')).toBeDefined()
  expect(screen.getByRole('button', { name: 'New trigger' })).toBeDefined()
  fireEvent.click(within(nav).getByRole('button', { name: /^Look/ }))
  expect(await screen.findByRole('heading', { name: 'Look' })).toBeDefined()
  expect(screen.getByRole('radiogroup', { name: 'Mode on this device' })).toBeDefined()
  expect(screen.getByRole('slider', { name: 'Text size' })).toBeDefined()
  fireEvent.click(within(nav).getByRole('button', { name: /^Rules/ }))
  expect(await screen.findByRole('heading', { name: 'Rules' })).toBeDefined()
  fireEvent.click(within(nav).getByRole('button', { name: /^Notifications/ }))
  expect(await screen.findByRole('heading', { name: 'Notifications' })).toBeDefined()
  fireEvent.click(within(nav).getByRole('button', { name: /^Remote access and security/ }))
  expect(await screen.findByRole('heading', { name: 'Remote access and security' })).toBeDefined()
  fireEvent.click(within(nav).getByRole('button', { name: /^Advanced/ }))
  expect(await screen.findByRole('heading', { name: 'Advanced' })).toBeDefined()
  fireEvent.click(within(nav).getByRole('button', { name: /^System/ }))
  expect(await screen.findByRole('heading', { name: 'System' })).toBeDefined()
})

test('Rules stages a mode and a Never rule, reviews the diff, then saves for the team', async () => {
  open('/b/settings/rules')
  const region = await screen.findByRole('region', { name: 'Rules' })
  expect(region.getAttribute('data-protected')).toBe('block')
  expect(within(region).getByRole('group', { name: 'Go ahead' })).toBeDefined()
  fireEvent.click(within(region).getByRole('radio', { name: /Always ask me/ }))
  fireEvent.click(within(region).getByRole('button', { name: 'Add a rule' }))
  const never = within(region).getByRole('form', { name: 'Add a Never rule' })
  fireEvent.change(within(never).getByLabelText(/Never allow commands that match/), {
    target: { value: 'rm   -rf /tmp/*' },
  })
  fireEvent.click(within(never).getByRole('button', { name: 'Add to Never' }))
  expect(within(region).getByRole('group', { name: 'Never' }).textContent).toContain(
    'rm -rf /tmp/*',
  )
  fireEvent.click(within(region).getByRole('button', { name: 'Review changes' }))
  expect(await within(region).findByLabelText('Changes')).toHaveProperty(
    'textContent',
    expect.stringContaining('+never: rm -rf /tmp/*'),
  )
  fireEvent.click(within(region).getByRole('button', { name: 'Save for the whole team' }))
  expect(await within(region).findByText('Saved for the whole team.')).toBeDefined()
  expect(
    calls.filter((call) => call.url === '/api/settings/rules' && call.method === 'PUT').at(-1)
      ?.body,
  ).toEqual({ mode: 'manual', goAhead: ['read'], never: ['secrets', 'rm -rf /tmp/*'] })
})

test('Notifications asks for permission on the click, then remembers the chosen kinds', async () => {
  open('/b/settings/notifications')
  expect(await screen.findByRole('heading', { name: 'Notifications' })).toBeDefined()
  expect(FakeNotification.requestPermission).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Turn on notifications on this device' }))
  expect(
    await screen.findByRole('button', { name: 'Turn off notifications on this device' }),
  ).toBeDefined()
  const kind = screen.getByRole('checkbox', {
    name: /An approval is waiting for me/,
  }) as HTMLInputElement
  expect(kind.disabled).toBe(false)
  fireEvent.click(kind)
  expect(JSON.parse(window.localStorage.getItem('score.notifications')!)).toMatchObject({
    enabled: true,
    kinds: { approvals: false },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Send a test notification' }))
  await waitFor(() => expect(FakeNotification.shown).toContain('Score notifications work'))
})

test('Advanced searches, stages, previews and applies a Hermes setting', async () => {
  open('/b/settings/advanced')
  expect(await screen.findByRole('heading', { name: 'Advanced' })).toBeDefined()
  const search = screen.getByRole('searchbox', { name: 'Search settings' })
  fireEvent.change(search, { target: { value: 'display.compact' } })
  expect(await screen.findByText('display.compact')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Edit display.compact' }))
  fireEvent.change(screen.getByLabelText('New value for display.compact'), {
    target: { value: 'true' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Add change' }))
  const tray = screen.getByRole('group', { name: 'Pending changes' })
  expect(tray.textContent).toContain('display.compact = true')
  expect(within(tray).getByRole('button', { name: 'Apply' })).toHaveProperty('disabled', true)
  fireEvent.click(within(tray).getByRole('button', { name: 'Preview' }))
  expect(await within(tray).findByLabelText('Changes preview')).toHaveProperty(
    'textContent',
    expect.stringContaining('+display.compact: true'),
  )
  fireEvent.click(within(tray).getByRole('button', { name: 'Apply' }))
  expect(await screen.findByText(/Saved\./)).toBeDefined()
})

test('the Hermes version banner sits above every bold section and keeps its protected mark', async () => {
  settingsState.hermesTested = false
  open('/b/settings/notifications')
  const banner = await screen.findByRole('region', { name: 'Hermes was updated' })
  expect(banner.getAttribute('data-protected')).toBe('block')
  expect(within(banner).getByRole('button', { name: 'Check this Hermes version' })).toBeDefined()
  const nav = screen.getByRole('navigation', { name: 'Settings' })
  fireEvent.click(within(nav).getByRole('button', { name: /^System/ }))
  expect(await screen.findByRole('heading', { name: 'System' })).toBeDefined()
  expect(screen.getByRole('region', { name: 'Hermes was updated' })).toBe(banner)
})

test('the Customizer page marks the Settings frame as a section page (phone: the list steps aside)', async () => {
  open('/b/settings/look/customize')
  expect(await screen.findByRole('button', { name: /All settings/ })).toBeDefined()
  expect(document.querySelector('.setgrid[data-section-page]')).toBeTruthy()
  open('/b/settings/look')
  expect(await screen.findByRole('heading', { name: 'Look' })).toBeDefined()
})
