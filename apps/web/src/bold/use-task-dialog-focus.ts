import { useEffect, useRef } from 'react'

/** A native modal dialog (inert page behind, focus kept inside); Escape closes it and focus goes back to what opened it. */
export function useDialogFocus(onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null)
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  }, [onClose])
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const dialog = ref.current
    // Without showModal (old engines, jsdom) the dialog is rendered `open` and only the Escape handler applies.
    if (dialog && typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal()
    ref.current?.querySelector<HTMLElement>('input, textarea, select')?.focus()
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      event.stopPropagation()
      close.current()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      opener?.focus?.()
    }
  }, [])
  return ref
}
