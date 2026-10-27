import { useLayoutEffect, type RefObject } from 'react'

const GUTTER = 14
const WIDTH = 300

/**
 * 3.8.1 (owner, phone): a menu hangs from its ⋯ button; where the button sits near one edge the menu ran off the other.
 * While it is open this places the wrapper's menu under the button, shifted just enough to stay inside the screen.
 */
export function useMenuPlacement(root: RefObject<HTMLElement | null>, open: boolean): void {
  useLayoutEffect(() => {
    const menu = open ? root.current?.querySelector<HTMLElement>(':scope > [role="menu"]') : null
    if (!menu || !root.current) return
    const place = () => {
      const anchor = root.current!.getBoundingClientRect()
      const width = Math.min(WIDTH, window.innerWidth - 2 * GUTTER)
      // Right-aligned with the button, as before, unless that leaves the screen on either side.
      const left = Math.min(
        Math.max(anchor.right - width, GUTTER),
        window.innerWidth - GUTTER - width,
      )
      menu.style.left = `${left - anchor.left}px`
      menu.style.right = 'auto'
      menu.style.width = `${width}px`
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open, root])
}
