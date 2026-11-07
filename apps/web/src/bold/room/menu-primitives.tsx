import { useEffect, type KeyboardEvent, type RefObject } from 'react'

export function DotsIcon() {
  return (
    <span className="bold-dots" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  )
}

export function useMenu(
  open: boolean,
  setOpen: (open: boolean) => void,
  root: RefObject<HTMLElement | null>,
  trigger: RefObject<HTMLButtonElement | null>,
) {
  function close(restoreFocus = true) {
    setOpen(false)
    if (restoreFocus) trigger.current?.focus()
  }
  useEffect(() => {
    if (!open) return
    const first = requestAnimationFrame(() => {
      root.current?.querySelector<HTMLElement>('[role="menuitem"], [role="option"]')?.focus()
    })
    function onPointerDown(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    function onFocusIn(event: FocusEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('focusin', onFocusIn)
    // The room and job menus also live in the phone's side sheet: one Escape closes the menu, not both layers.
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      cancelAnimationFrame(first)
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open, root, setOpen, trigger])
  return close
}

export function moveInMenu(event: KeyboardEvent<HTMLElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const root = event.currentTarget
  const items = [
    ...root.querySelectorAll<HTMLElement>('[role="menuitem"], [role="option"]'),
  ].filter((item) => item.getAttribute('aria-disabled') !== 'true')
  if (!items.length) return
  event.preventDefault()
  const at = items.indexOf(document.activeElement as HTMLElement)
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : event.key === 'ArrowDown'
          ? (at + 1 + items.length) % items.length
          : (at - 1 + items.length) % items.length
  items[next]?.focus()
}
