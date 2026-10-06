import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { App } from './App.tsx'

test('renders the scaffold heading', () => {
  render(<App />)
  expect(screen.getByRole('heading', { name: 'score' })).toBeDefined()
})
