import { useLayoutEffect, type RefObject } from 'react'

const GUTTER = 14
const WIDTH = 300

/**
 * Where the menu goes, relative to its wrapper: right-aligned with the button, as before, unless that leaves the screen
 * on either side; then shifted just enough to stay inside it.
 */
export function menuBox(
  anchor: { left: number; right: number },
  viewport: number,
): { left: number; width: number } {
  const width = Math.min(WIDTH, viewport - 2 * GUTTER)
  const left = Math.min(Math.max(anchor.right - width, GUTTER), viewport - GUTTER - width)
  return { left: left - anchor.left, width }
}

/**
 * 3.8.1 (owner, phone): a menu hangs from its ⋯ button; where the button sits near one edge the menu ran off the other.
 * While it is open this places the wrapper's menu under the button, shifted just enough to stay inside the screen.
 */
export function useMenuPlacement(root: RefObject<HTMLElement | null>, open: boolean): void {
  useLayoutEffect(() => {
    const menu = open ? root.current?.querySelector<HTMLElement>(':scope > [role="menu"]') : null
    if (!menu || !root.current) return
    const place = () => {
      const { left, width } = menuBox(root.current!.getBoundingClientRect(), window.innerWidth)
      menu.style.left = `${left}px`
      menu.style.right = 'auto'
      menu.style.width = `${width}px`
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open, root])
}
