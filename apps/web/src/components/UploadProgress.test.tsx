import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { shortName, UploadProgress } from './UploadProgress.tsx'

afterEach(cleanup)

test('long names keep their start and extension', () => {
  expect(shortName('report.pdf')).toBe('report.pdf')
  const short = shortName('quarterly-revenue-breakdown-by-region-2026.pdf')
  expect(short.length).toBeLessThanOrEqual(32)
  expect(short.endsWith('….pdf')).toBe(true)
  expect(short.startsWith('quarterly-')).toBe(true)
})

test('shows bytes while sending and the named step once everything is out', () => {
  const MB = 1024 * 1024
  const view = render(
    <UploadProgress progress={{ loaded: 84 * MB, total: 200 * MB }} after="Checking…" />,
  )
  expect(view.getByRole('status').textContent).toBe('Uploading · 42% · 84.0 MB of 200.0 MB')
  view.rerender(
    <UploadProgress
      progress={{ loaded: 200 * MB, total: 200 * MB, done: true }}
      after="Checking…"
    />,
  )
  expect(view.getByRole('status').textContent).toBe('Checking…')
})

test('an empty file reaches the named step when the upload says it is done', () => {
  const view = render(<UploadProgress progress={{ loaded: 0, total: 0 }} after="Saving…" />)
  expect(view.getByRole('status').textContent).toContain('Uploading')
  view.rerender(<UploadProgress progress={{ loaded: 0, total: 0, done: true }} after="Saving…" />)
  expect(view.getByRole('status').textContent).toBe('Saving…')
})
