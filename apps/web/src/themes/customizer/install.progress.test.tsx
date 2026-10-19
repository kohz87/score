import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ApiError } from '../../data/api.ts'
import { ControlledXhr, installControlledXhr } from '../../test/controlled-xhr.ts'
import { ImportDialog } from '../../routes/customizer/ImportDialog.tsx'
import { emptyManifest } from './draft.ts'
import { installThemeZip } from './api.ts'

const MB = 1024 * 1024
beforeEach(installControlledXhr)
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('installThemeZip posts a form over XHR, keeps If-Match and reports progress', async () => {
  const seen: { loaded: number; total: number }[] = []
  const done = installThemeZip(new Uint8Array([1, 2, 3]), {
    replace: true,
    ifMatch: '"e1"',
    onProgress: (progress) => seen.push(progress),
  })
  const xhr = ControlledXhr.all[0]!
  expect(xhr.method).toBe('POST')
  expect(xhr.url).toBe('/api/themes/import?replace=1')
  expect(xhr.headers['if-match']).toBe('"e1"')
  expect(xhr.sent).toBeInstanceOf(FormData)
  xhr.progress(1, 3)
  expect(seen).toEqual([{ loaded: 1, total: 3 }])
  xhr.answer(412, { error: { code: 'etag_mismatch', message: 'changed' } })
  const error = await done.catch((e: unknown) => e)
  expect(error).toBeInstanceOf(ApiError)
  expect(error).toMatchObject({ status: 412, code: 'etag_mismatch' })
})

test('the install dialog shows "Uploading · …" and then "Installing…"', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  const manifest = emptyManifest('quayside', 'Quayside')
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ImportDialog
        candidate={{
          ok: true,
          name: 'harbour.zip',
          bytes: new Uint8Array(4),
          pkg: { manifest, css: '', assets: new Map(), licenses: {} },
        }}
        themes={[]}
        onClose={() => {}}
        onOpen={() => {}}
        onInstalled={() => {}}
      />
    </QueryClientProvider>,
  )
  const install = screen.getByRole('button', { name: 'Install' }) as HTMLButtonElement
  fireEvent.click(install)
  const xhr = await vi.waitFor(() => {
    if (!ControlledXhr.all[0]) throw new Error('not sent yet')
    return ControlledXhr.all[0]
  })
  xhr.progress(2 * MB, 8 * MB)
  await vi.waitFor(() => expect(document.querySelector('.upload-progress')).toBeTruthy())
  const status = document.querySelector('.upload-progress')!
  expect(status.textContent).toContain('Uploading · 25% · 2.0 MB of 8.0 MB')
  xhr.progress(8 * MB, 8 * MB)
  expect(status.textContent).toContain('Installing…')
})
