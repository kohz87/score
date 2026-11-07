import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { open, shellState } from './BoldShell-helpers.tsx'

// 3.22.0 replacements for the shell tests the Library/Runs/Thread modes took with them. Each says what it replaces.

// was: 'the side-panel dropdown is a disclosure that closes and restores focus'
test('the side panel is a lone Info tab (Graph joins it on a run), not a dropdown of modes', () => {
  open('/b')
  const tabs = screen.getByRole('tablist', { name: 'Panel' })
  const info = within(tabs).getByRole('tab', { name: 'Info' })
  expect(within(tabs).getAllByRole('tab')).toHaveLength(1)
  expect(info.getAttribute('aria-selected')).toBe('true')
  // Results folded into Info (3.25.0); Thread, Runs and Library are not modes of the panel either.
  for (const gone of ['Results', 'Thread', 'Runs', 'Library'])
    expect(within(tabs).queryByRole('tab', { name: gone })).toBeNull()
  expect(screen.queryByRole('navigation', { name: 'How to see the work' })).toBeNull()
  expect(screen.queryByRole('button', { name: /^Library/ })).toBeNull()
  // The files and results are a section of Info.
  expect(screen.getByRole('heading', { name: 'Files and results' })).toBeDefined()
})

// was: 'an in-place edit of the address (a replace) does not reopen a run the person closed'
test('an in-place edit of the address (a replace) does not reopen a sheet the person closed', async () => {
  shellState.phone = true
  const router = open('/b?open=1&work=results')
  fireEvent.click(screen.getByRole('button', { name: 'Chat info' }))
  await screen.findByRole('complementary', { name: 'Side panel' })
  // Chat info opens the sheet on Info (`?work=results` is Info at Files and results), then the person closes it.
  fireEvent.click(screen.getByRole('button', { name: 'Close side panel' }))
  expect(screen.queryByRole('complementary', { name: 'Side panel' })).toBeNull()
  await act(async () => {
    await router.navigate('/b?open=1&work=results&ref=other', { replace: true })
  })
  expect(screen.queryByRole('complementary', { name: 'Side panel' })).toBeNull()
})

// was: 'Escape in a Library dialog closes the dialog, not the phone sheet'
test('Escape inside a dialog in the phone sheet is the dialog’s, and Escape on the sheet itself closes it', async () => {
  shellState.phone = true
  open('/b?open=1')
  fireEvent.click(screen.getByRole('button', { name: 'Chat info' }))
  const panel = await screen.findByRole('complementary', { name: 'Side panel' })
  const dialog = document.createElement('div')
  dialog.setAttribute('role', 'dialog')
  const field = document.createElement('input')
  dialog.append(field)
  panel.append(dialog)
  try {
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(screen.getByRole('complementary', { name: 'Side panel' })).toBeDefined()
  } finally {
    dialog.remove()
  }
  fireEvent.keyDown(screen.getByRole('tab', { name: 'Info' }), { key: 'Escape' })
  await waitFor(() =>
    expect(screen.queryByRole('complementary', { name: 'Side panel' })).toBeNull(),
  )
})

// was: 'the Results view keeps its element while the phone sheet closes and the tab changes'
test('the Files and results section keeps its element while the phone sheet closes and opens', async () => {
  shellState.phone = true
  open('/b?open=1&work=results')
  fireEvent.click(screen.getByRole('button', { name: 'Chat info' }))
  const files = await screen.findByTestId('files-results')
  expect(screen.getByRole('tab', { name: 'Info' }).getAttribute('aria-selected')).toBe('true')

  fireEvent.click(screen.getByRole('button', { name: 'Close side panel' }))
  expect(screen.getByTestId('files-results')).toBe(files)
  fireEvent.click(screen.getByRole('button', { name: 'Chat info' }))
  expect(screen.getByTestId('files-results')).toBe(files)
})
