import { useEffect, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'

/** The choices of a menu built from `role="menuitemradio"` buttons. */
const choiceItems = (menu: HTMLElement | null) =>
  Array.from(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])

/** Up and Down step through the choices (wrapping), Home and End jump to the first and the last. */
export function onChoiceMenuKeyDown(
  event: ReactKeyboardEvent<HTMLDivElement>,
  menu: HTMLElement | null,
) {
  const items = choiceItems(menu)
  if (items.length === 0) return
  const index = items.indexOf(document.activeElement as HTMLButtonElement)
  let target: number
  if (event.key === 'ArrowDown') target = index + 1 >= items.length ? 0 : index + 1
  else if (event.key === 'ArrowUp') target = index <= 0 ? items.length - 1 : index - 1
  else if (event.key === 'Home') target = 0
  else if (event.key === 'End') target = items.length - 1
  else return
  event.preventDefault()
  items[target]?.focus()
}

/**
 * A choice menu's behaviour while it is open: an outside pointer closes it, Escape closes it and gives focus back to its
 * button, and it opens on the checked choice so the keyboard starts where the person is.
 */
export function useChoiceMenu({
  open,
  setOpen,
  button,
  menu,
  ready = true,
}: {
  open: boolean
  setOpen: (value: boolean) => void
  button: RefObject<HTMLButtonElement | null>
  menu: RefObject<HTMLDivElement | null>
  /** False while the menu's data is still on its way: focus moves once the menu has rendered. */
  ready?: boolean
}) {
  useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent) {
      if (!button.current?.parentElement?.contains(event.target as Node)) setOpen(false)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      requestAnimationFrame(() => button.current?.focus())
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open, setOpen, button])

  useEffect(() => {
    if (!open || !ready) return
    // Focus moves only from the trigger (or nowhere): a person who has already gone elsewhere keeps their place.
    const active = document.activeElement
    if (active && active !== document.body && active !== button.current) return
    const items = choiceItems(menu.current)
    ;(items.find((item) => item.getAttribute('aria-checked') === 'true') ?? items[0])?.focus()
  }, [open, ready, menu, button])
}
