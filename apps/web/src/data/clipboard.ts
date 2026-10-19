// navigator.clipboard exists only in secure contexts (HTTPS or localhost); over plain HTTP on a LAN it is undefined.
// Fall back to the classic selected-textarea copy, which browsers still allow from a click.
export async function copyText(text: string): Promise<boolean> {
  try {
    // eslint-disable-next-line no-restricted-syntax -- the one sanctioned use, guarded for insecure contexts
    const clipboard = navigator.clipboard as Clipboard | undefined
    if (clipboard?.writeText) {
      await clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to the legacy path.
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.top = '0'
  area.style.opacity = '0'
  document.body.append(area)
  area.select()
  let copied: boolean
  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  }
  area.remove()
  return copied
}

/**
 * The clipboard's text for a Paste button, or null where the browser won't hand it over (plain HTTP, a refused
 * permission): the person can still press Ctrl+V, which needs no permission.
 */
export async function readClipboardText(): Promise<string | null> {
  try {
    // eslint-disable-next-line no-restricted-syntax -- the sanctioned read, from a click, guarded like copyText
    const clipboard = navigator.clipboard as Clipboard | undefined
    return clipboard?.readText ? await clipboard.readText() : null
  } catch {
    return null
  }
}

/** Selects an element's text so the person can press Ctrl+C when no copy path works. */
export function selectText(element: HTMLElement | null) {
  if (!element) return
  const range = document.createRange()
  range.selectNodeContents(element)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}
