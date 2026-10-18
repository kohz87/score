// Helpers for the documents the Customizer draws in: an empty iframe document that wears the app's own style sheets
// but none of the look applied to the page around it. The preview paints the draft into one; the defaults probe reads
// Score's and the packs' values from another, so a custom theme on the page can't leak into the copy of a built-in.

const BLANK =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body></body></html>'
export const FRAME_SRCDOC = BLANK

/** Style nodes of the app, not the look applied to the page: those are the engine's (adopted sheets, boot copy). */
function appStyleNodes(head: HTMLHeadElement): Element[] {
  return [...head.querySelectorAll('link[rel="stylesheet"], style')].filter(
    (node) =>
      node.id !== 'score-look-boot' &&
      !node.hasAttribute('data-score-look') &&
      !node.hasAttribute('data-preview-look'),
  )
}

/**
 * Copies the app's style sheets into another document and keeps copying the ones added later (a lazy chunk's CSS,
 * a pack's fonts). Resolves when the sheets that were there have loaded, so the first picture isn't unstyled.
 */
export function mirrorStyles(
  from: Document,
  to: Document,
): { ready: Promise<void>; stop: () => void } {
  const copied = new WeakSet<Element>()
  const loads: Promise<void>[] = []
  const copy = (node: Element) => {
    if (copied.has(node)) return
    copied.add(node)
    const clone = node.cloneNode(true) as Element
    if (clone instanceof to.defaultView!.HTMLLinkElement)
      loads.push(
        new Promise((resolve) => {
          clone.addEventListener('load', () => resolve(), { once: true })
          clone.addEventListener('error', () => resolve(), { once: true })
        }),
      )
    to.head.append(clone)
  }
  for (const node of appStyleNodes(from.head)) copy(node)
  const observer = new MutationObserver((records) => {
    for (const record of records)
      for (const added of record.addedNodes)
        if (added instanceof Element && appStyleNodes(from.head).includes(added)) copy(added)
  })
  observer.observe(from.head, { childList: true })
  const settled = Promise.all(loads).then(() => undefined)
  // A sheet that never answers must not keep the preview blank.
  const ready = Promise.race([settled, new Promise<void>((resolve) => setTimeout(resolve, 4000))])
  return { ready, stop: () => observer.disconnect() }
}

export type Probe = {
  /** The computed value of a custom property on a root wearing this pack and colour mode. */
  read: (packId: string, mode: 'light' | 'dark', property: string) => string
  dispose: () => void
}

/** A hidden frame to ask the stylesheets what a pack's values are. */
export async function createProbe(): Promise<Probe> {
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.tabIndex = -1
  frame.title = ''
  frame.style.cssText =
    'position:fixed;left:-9999px;top:0;width:800px;height:600px;border:0;visibility:hidden;pointer-events:none'
  frame.srcdoc = BLANK
  const loaded = new Promise<void>((resolve) =>
    frame.addEventListener('load', () => resolve(), { once: true }),
  )
  document.body.append(frame)
  await loaded
  const doc = frame.contentDocument!
  const mirror = mirrorStyles(document, doc)
  await mirror.ready
  const root = doc.documentElement
  return {
    read(packId, mode, property) {
      root.setAttribute('data-pack', packId)
      root.setAttribute('data-theme', mode)
      return doc.defaultView!.getComputedStyle(root).getPropertyValue(property).trim()
    },
    dispose() {
      mirror.stop()
      frame.remove()
    },
  }
}
