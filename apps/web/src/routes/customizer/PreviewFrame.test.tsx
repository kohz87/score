import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { ThemeManifest } from '@score/contract'
import { afterEach, expect, test, vi } from 'vitest'

const sampled: { url: string; dim: number }[] = []
vi.mock('../../App.tsx', () => ({ appRoutes: [{ path: '*', element: null }] }))
vi.mock('../../themes/preview-paint.ts', () => ({
  paintPreview: (doc: Document) => {
    doc.documentElement.style.setProperty('--ground', '#ffffff')
    return { warnings: [] }
  },
}))
vi.mock('../../themes/customizer/measure.ts', () => ({
  measureText: () => [],
  pictureSampler: async (options: { url: string; dim: number }) => {
    sampled.push({ url: options.url, dim: options.dim })
    return null
  },
}))

import { FRAME_SRCDOC } from '../../themes/customizer/frame-document.ts'
import { PreviewFrame } from './PreviewFrame.tsx'
import { previewDevices, previewPages } from './preview-pages.ts'

afterEach(() => {
  cleanup()
  sampled.length = 0
})

test('K3 X16: a preview page is measured against the applied theme background', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  const manifest = {
    schemaVersion: 1,
    id: 'x',
    name: 'X',
    background: { image: 'admin.png', dim: 0.1 },
    views: { user: { background: { image: 'user.png', dim: 0.4 } } },
  } as unknown as ThemeManifest
  const chat = previewPages.find((page) => page.id === 'chat')!
  const { container } = render(
    <QueryClientProvider client={new QueryClient()}>
      <PreviewFrame
        draft={{ manifest, css: '', themeId: 'x', resolve: (name: string) => `/assets/${name}` }}
        mode="light"
        page={chat}
        device={previewDevices[0]!}
        onText={() => undefined}
      />
    </QueryClientProvider>,
  )
  // jsdom doesn't load `srcdoc`: write the frame's document the way a browser would, then signal the load.
  const frame = container.querySelector('iframe')!
  frame.contentDocument!.open()
  frame.contentDocument!.write(FRAME_SRCDOC)
  frame.contentDocument!.close()
  fireEvent.load(frame)
  await waitFor(() => expect(sampled.length).toBeGreaterThan(0), { timeout: 4000 })
  expect(sampled[0]).toEqual({ url: '/assets/admin.png', dim: 0.1 })
})
