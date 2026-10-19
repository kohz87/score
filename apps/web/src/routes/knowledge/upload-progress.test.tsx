import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { UploadProgressPanel } from './UploadFlow.tsx'

afterEach(cleanup)
const MB = 1024 * 1024

test('a big upload shows the file, its step, percent and megabytes sent', () => {
  render(
    <UploadProgressPanel
      progress={{
        name: 'pack.zip',
        index: 1,
        count: 3,
        step: 'upload',
        loaded: 12 * MB,
        total: 24 * MB,
      }}
    />,
  )
  const panel = screen.getByRole('status')
  expect(panel.textContent).toContain('pack.zip · file 2 of 3')
  expect(panel.textContent).toContain('Uploading · 50% · 12.0 MB of 24.0 MB')
  const bar = screen.getByRole('progressbar', { name: 'pack.zip: Uploading' })
  expect(bar.getAttribute('value')).toBe(String(12 * MB))
})

test('once everything is sent it says what the server is doing, with a moving bar', () => {
  render(
    <UploadProgressPanel
      progress={{
        name: 'pack.zip',
        index: 0,
        count: 1,
        step: 'unzip',
        loaded: 24 * MB,
        total: 24 * MB,
      }}
    />,
  )
  expect(screen.getByRole('status').textContent).toBe('pack.zipUnzipping…')
  expect(screen.getByRole('progressbar').hasAttribute('value')).toBe(false)
})
