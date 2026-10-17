// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, test, vi } from 'vitest'
import { AgentAdded } from './AgentAdded.tsx'

afterEach(cleanup)

test('"joined the team" names the agent, says what it is and offers where to go next', () => {
  const another = vi.fn()
  const close = vi.fn()
  render(
    <MemoryRouter>
      <AgentAdded
        agent={{ id: 'luna', name: 'luna', style: { color: '#19C39A', shape: 'hexagon' } }}
        detail="Coding agent · Codex · gpt-6-luna · workspace write"
        onAnother={another}
        onClose={close}
      />
    </MemoryRouter>,
  )
  expect(screen.getByRole('heading', { name: 'luna joined the team' })).toBeDefined()
  expect(screen.getByText('Coding agent · Codex · gpt-6-luna · workspace write')).toBeDefined()
  expect(screen.getByRole('link', { name: 'Open luna' }).getAttribute('href')).toBe('/team/luna')
  fireEvent.click(screen.getByRole('button', { name: 'Add another' }))
  expect(another).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  expect(close).toHaveBeenCalledOnce()
})

test('without onAnother (import) there is no "Add another"', () => {
  render(
    <MemoryRouter>
      <AgentAdded
        agent={{ id: 'helper', name: 'helper', style: { color: '#19C39A', shape: 'triangle' } }}
        detail="Hermes agent, imported from an archive"
        onClose={() => undefined}
      />
    </MemoryRouter>,
  )
  expect(screen.queryByRole('button', { name: 'Add another' })).toBeNull()
})
