import { screen, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { open } from './BoldSettings-helpers.tsx'

// Decision 183: Recipes moved from Settings to Tasks (this file held the "Recipes is a Settings section" tests).
test('Settings no longer has a Recipes section', async () => {
  open('/b/settings/usage')
  const nav = screen.getByRole('navigation', { name: 'Settings' })
  expect(within(nav).queryByRole('button', { name: /^Recipes/ })).toBeNull()
  expect(within(nav).getByRole('button', { name: /^Usage/ })).toBeDefined()
})

test('a recipe’s old Settings address opens it in Tasks, not Usage', async () => {
  const router = open('/b/settings/recipes/wf-1')
  await screen.findByRole('navigation', { name: 'Tasks views' })
  expect(router.state.location.pathname).toBe('/b/tasks/recipes/wf-1')
  expect(screen.queryByRole('navigation', { name: 'Settings' })).toBeNull()
})
