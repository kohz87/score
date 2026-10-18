import { QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider, type DataRouter } from 'react-router'
import type { ThemeManifest } from '@score/contract'
import { appRoutes } from '../../App.tsx'
import { MediaWindow } from '../../data/use-media.ts'
import { StreamContext } from '../../data/query-client.ts'
import { parseColor, type Rgba } from '../../themes/color.ts'
import { type AssetResolver } from '../../themes/engine.ts'
import { LayoutOverride, lookForView, resolveLayout } from '../../themes/layout.ts'
import { paintPreview, type PreviewResult } from '../../themes/preview-paint.ts'
import { PreviewContext } from '../../themes/preview-context.ts'
import {
  FRAME_SRCDOC,
  frameDocument,
  mirrorStyles,
} from '../../themes/customizer/frame-document.ts'
import { measureText, pictureSampler, type TextFinding } from '../../themes/customizer/measure.ts'
import type { PreviewDevice, PreviewPage } from './preview-pages.ts'

// The live preview (PLAN 9.4): the real routes of the app, drawn in a frame of their own with the draft painted into
// that frame's document only. The page around it, the boot cache and every other device never see the draft. The
// frame is read-only (inert): it is a picture of the app that reads the same data.

export type PreviewDraft = {
  manifest: ThemeManifest
  css: string
  themeId: string
  resolve: AssetResolver
}

type Props = {
  draft: PreviewDraft
  mode: 'light' | 'dark'
  page: PreviewPage
  device: PreviewDevice
  onPainted?: (result: PreviewResult) => void
  onText?: (page: PreviewPage, findings: TextFinding[]) => void
}

type FrameState = { doc: Document; win: Window; root: Root; router: DataRouter; stop: () => void }

export function PreviewFrame({ draft, mode, page, device, onPainted, onText }: Props) {
  const queryClient = useQueryClient()
  const streamContext = useContext(StreamContext)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<FrameState | null>(null)
  const [styled, setStyled] = useState(false)
  const [box, setBox] = useState({ width: 0, height: 0 })
  const pageRef = useRef(page)
  useEffect(() => {
    pageRef.current = page
  })

  // The frame's document: styles of the app copied in, the app mounted in its own React root.
  const start = () => {
    const frame = frameRef.current
    const doc = frame ? frameDocument(frame) : null
    const win = frame?.contentWindow
    if (!frame || !doc || !win || state) return
    const mirror = mirrorStyles(document, doc)
    const holder = doc.createElement('div')
    holder.id = 'root'
    holder.inert = true
    doc.body.append(holder)
    const router = createMemoryRouter(appRoutes, { initialEntries: [pageRef.current.path] })
    const root = createRoot(holder)
    setState({
      doc,
      win,
      root,
      router,
      stop: () => {
        mirror.stop()
        router.dispose()
        // Unmounting while React renders (a route change in the page) is an error: let it finish first.
        setTimeout(() => root.unmount(), 0)
      },
    })
    void mirror.ready.then(() => setStyled(true))
  }
  useEffect(() => () => state?.stop(), [state])

  useEffect(() => {
    const element = boxRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setBox({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const layout = useMemo(
    () => resolveLayout(lookForView(draft.manifest, page.view)),
    [draft.manifest, page.view],
  )

  // Paint the draft into the frame; nowhere else.
  useEffect(() => {
    if (!state) return
    const result = paintPreview(state.doc, {
      manifest: draft.manifest,
      css: draft.css,
      themeId: draft.themeId,
      mode,
      view: page.view,
      resolve: draft.resolve,
    })
    onPainted?.(result)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, draft, mode, page.view])

  useEffect(() => {
    if (!state) return
    state.root.render(
      <QueryClientProvider client={queryClient}>
        <StreamContext value={streamContext}>
          <PreviewContext value>
            <MediaWindow value={state.win}>
              <LayoutOverride value={layout}>
                <RouterProvider router={state.router} />
              </LayoutOverride>
            </MediaWindow>
          </PreviewContext>
        </StreamContext>
      </QueryClientProvider>,
    )
  }, [state, queryClient, streamContext, layout])

  useEffect(() => {
    if (state && state.router.state.location.pathname !== page.path)
      void state.router.navigate(page.path)
  }, [state, page.path])

  // Text that is really drawn: measured a moment after the picture settles.
  useEffect(() => {
    if (!state || !onText) return
    let cancelled = false
    let timer = 0
    const run = async () => {
      const { doc, win } = state
      // The picture the page really wears: `/u` lays `views.user.background` over the theme's own.
      const background = lookForView(draft.manifest, pageRef.current.view).background
      const image = background?.image
      const url = image ? draft.resolve(image) : null
      const ground = parseColor(
        win.getComputedStyle(doc.documentElement).getPropertyValue('--ground'),
      )
      const sampler =
        url && ground
          ? await pictureSampler({
              url,
              fit: background?.fit ?? 'cover',
              dim: background?.dim ?? 0,
              ground: ground as Rgba,
              width: win.innerWidth,
              height: win.innerHeight,
            })
          : null
      if (cancelled) return
      onText(pageRef.current, measureText(doc, sampler))
    }
    const schedule = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void run(), 600)
    }
    schedule()
    const observer = new MutationObserver(schedule)
    observer.observe(state.doc.body, { childList: true, subtree: true, characterData: true })
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      observer.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, draft, mode, page.view, page.path, device.width, box.width])

  const scale = box.width > 0 ? Math.min(1, box.width / device.width) : 1
  const height = box.height > 0 ? box.height / scale : 600
  return (
    <div className="cz-stage" ref={boxRef} data-device={device.id}>
      <div
        className="cz-frame-box"
        style={{ width: device.width * scale, height: box.height || undefined }}
      >
        <iframe
          ref={frameRef}
          className="cz-frame"
          title="Preview of your theme"
          srcDoc={FRAME_SRCDOC}
          tabIndex={-1}
          onLoad={start}
          style={{
            width: device.width,
            height,
            transform: `scale(${scale})`,
            visibility: styled && state ? 'visible' : 'hidden',
          }}
        />
        {!(styled && state) && (
          <p className="cz-loading" role="status">
            Loading the preview…
          </p>
        )}
      </div>
    </div>
  )
}
