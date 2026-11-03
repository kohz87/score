import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

/** Where a needs-you card belongs in the conversation: after its message, else at its topic's end, else at the end. */
export type PinAnchor = { message?: string | null; job?: string | null }

type Slots = {
  elements: ReadonlyMap<string, HTMLElement>
  register: (id: string, element: HTMLElement) => void
  /** Removes the entry only when it still holds this element (a second slot with the same id may have replaced it). */
  unregister: (id: string, element: HTMLElement) => void
}

/** The registry's two moves as pure functions, so the "only the owner removes its entry" rule can be tested. */
export function withSlot(
  current: ReadonlyMap<string, HTMLElement>,
  id: string,
  element: HTMLElement,
): ReadonlyMap<string, HTMLElement> {
  if (current.get(id) === element) return current
  return new Map(current).set(id, element)
}

export function withoutSlot(
  current: ReadonlyMap<string, HTMLElement>,
  id: string,
  element: HTMLElement,
): ReadonlyMap<string, HTMLElement> {
  if (current.get(id) !== element) return current
  const next = new Map(current)
  next.delete(id)
  return next
}

const SlotsContext = createContext<Slots | null>(null)

export function useNeedsSlotsOuter(): Slots | null {
  return useContext(SlotsContext)
}

/**
 * 3.24.0: the places in the conversation where a needs-you card can sit. The stream draws one slot after each message,
 * one at the end of each topic's run and one at the end of the conversation; a card portals into the first of these
 * that exists. The registry lives above both the stream and the cards, which are siblings.
 */
export function NeedsSlotsProvider({ children }: { children: ReactNode }) {
  const [elements, setElements] = useState<ReadonlyMap<string, HTMLElement>>(new Map())
  const register = useCallback(
    (id: string, element: HTMLElement) => setElements((current) => withSlot(current, id, element)),
    [],
  )
  const unregister = useCallback(
    (id: string, element: HTMLElement) =>
      setElements((current) => withoutSlot(current, id, element)),
    [],
  )
  const value = useMemo(
    () => ({ elements, register, unregister }),
    [elements, register, unregister],
  )
  return <SlotsContext value={value}>{children}</SlotsContext>
}

/** One place a card can sit. Empty slots take no room (CSS `:empty`). */
export function NeedsSlot({ id, className }: { id: string; className?: string }) {
  const slots = useContext(SlotsContext)
  const register = slots?.register
  const unregister = slots?.unregister
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!register || !unregister || !element) return
    register(id, element)
    return () => unregister(id, element)
  }, [element, id, register, unregister])
  return (
    <div
      ref={setElement}
      className={className ? `bold-needs-slot ${className}` : 'bold-needs-slot'}
      data-needs-slot={id}
    />
  )
}

export const slotIds = {
  message: (id: string) => `after:${id}`,
  topic: (id: string) => `topic:${id}`,
  end: 'end',
  fallback: 'fallback',
  chip: 'chip',
} as const

/** The element a card with this anchor renders into (null: no slot is drawn yet). */
export function useNeedsTarget(anchor: PinAnchor | undefined): {
  inSlots: boolean
  target: HTMLElement | null
} {
  const slots = useContext(SlotsContext)
  if (!slots) return { inSlots: false, target: null }
  const { elements } = slots
  const target =
    (anchor?.message ? elements.get(slotIds.message(anchor.message)) : undefined) ??
    (anchor?.job ? elements.get(slotIds.topic(anchor.job)) : undefined) ??
    elements.get(slotIds.end) ??
    elements.get(slotIds.fallback) ??
    null
  return { inSlots: true, target }
}
