import { useEffect, useRef } from 'react'

export function Sheet({
  children,
  onClose,
  side = false,
}: {
  children: React.ReactNode
  onClose: () => void
  /** 601-1279px: a sheet on the right over the board instead of the phone's full screen. */
  side?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  // The page re-renders on every stream event with a new onClose: read it through a ref so focus moves only when the
  // sheet opens and closes, never while someone is typing in it.
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  }, [onClose])
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    ref.current?.focus()
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      close.current()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      opener?.focus?.()
    }
  }, [])
  return (
    <div
      ref={ref}
      className={`bold-tb-sheet${side ? ' bold-tb-sheet--side' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label="Task details"
      tabIndex={-1}
    >
      <span className="bold-tb-sheet-grip" aria-hidden="true" />
      {children}
    </div>
  )
}
