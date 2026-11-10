import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { expect, test } from 'vitest'
import { RoomEmpty } from './RoomEmpty.tsx'

test('a command’s note shows in an empty room too, with its action (Undo)', () => {
  let undone = false
  render(
    <MemoryRouter>
      <RoomEmpty
        agents={[]}
        onStart={() => {}}
        notes={[
          {
            id: 'n1',
            at: '2026-11-10T00:00:00.000Z',
            text: 'You set builder’s model to deep (example-large) for this chat',
            action: { label: 'Undo', run: () => (undone = true) },
          },
        ]}
      />
    </MemoryRouter>,
  )
  expect(screen.getByText('Your team is ready. What first?')).toBeDefined()
  expect(screen.getByText(/You set builder’s model to deep/)).toBeDefined()
  screen.getByRole('button', { name: 'Undo' }).click()
  expect(undone).toBe(true)
})
