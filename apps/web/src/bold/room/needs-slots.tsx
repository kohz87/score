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
  register: (id: string, element: HTMLElement | null) => void
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
  const register = useCallback((id: string, element: HTMLElement | null) => {
    setElements((current) => {
      if ((current.get(id) ?? null) === element) return current
      const next = new Map(current)
      if (element) next.set(id, element)
      else next.delete(id)
      return next
    })
  }, [])
  const value = useMemo(() => ({ elements, register }), [elements, register])
  return <SlotsContext value={value}>{children}</SlotsContext>
}

/** One place a card can sit. Empty slots take no room (CSS `:empty`). */
export function NeedsSlot({ id, className }: { id: string; className?: string }) {
  const slots = useContext(SlotsContext)
  const register = slots?.register
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!register || !element) return
    register(id, element)
    return () => register(id, null)
  }, [element, id, register])
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
