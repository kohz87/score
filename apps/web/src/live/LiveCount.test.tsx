import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { stubReducedMotion } from '../motion/test-support.ts'
import { LiveCount } from './LiveCount.tsx'
import { StatusLine } from './StatusLine.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('with reduced motion a counter just shows the new number', () => {
  stubReducedMotion()
  const { rerender } = render(<LiveCount value={3} />)
  expect(screen.getByText('3')).toBeTruthy()
  rerender(<LiveCount value={1204} />)
  expect(screen.getByText('1,204')).toBeTruthy()
  expect(document.documentElement.dataset.motion).toBeUndefined()
})

test('a counter formats money and keeps the final text from the start', () => {
  stubReducedMotion()
  render(<LiveCount value={0.0094} format={(n) => `$${n.toFixed(3)}`} />)
  expect(screen.getByText('$0.009')).toBeTruthy()
})

test('the status line keeps its height when empty and shows tool names in code style', () => {
  const { container, rerender } = render(<StatusLine line={null} />)
  expect(container.querySelector('.live-status')).toBeTruthy()
  expect(container.textContent).toBe('')
  rerender(<StatusLine line={'Calling `read_file()`…'} />)
  expect(container.querySelector('code')?.textContent).toBe('read_file()')
  rerender(<StatusLine line={null} reserve={false} />)
  expect(container.querySelector('.live-status')).toBeNull()
})
