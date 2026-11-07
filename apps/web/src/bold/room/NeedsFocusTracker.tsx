import { useEffect } from 'react'

/** Cards live in the stream, outside this component's tree: focus inside any of them is tracked from the document. */
export function NeedsFocusTracker({ onFocusKey }: { onFocusKey: (key: string) => void }) {
  useEffect(() => {
    const onFocus = (event: FocusEvent) => {
      const key =
        event.target instanceof Element
          ? event.target.closest('[data-pin-key]')?.getAttribute('data-pin-key')
          : null
      if (key) onFocusKey(key)
    }
    document.addEventListener('focusin', onFocus)
    return () => document.removeEventListener('focusin', onFocus)
  }, [onFocusKey])
  return null
}
