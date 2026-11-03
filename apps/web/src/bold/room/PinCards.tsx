import { createPortal } from 'react-dom'
import { useNeedsTarget, type PinAnchor } from './needs-slots.tsx'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

/** What the strip needs to know about one card to order it and to move focus when it goes. */
export type PinCardMeta = {
  key: string
  /** When the card started waiting on the person, ISO time. */
  since: string
  /** A notice carries no decision: human decisions sort before notices at the same time. */
  notice: boolean
}

function sortPinCards(cards: PinCardMeta[]): PinCardMeta[] {
  return [...cards].sort(
    (a, b) => Number(a.notice) - Number(b.notice) || a.since.localeCompare(b.since),
  )
}

type PinRegistration = {
  register: (card: PinCardMeta) => () => void
  ranks: ReadonlyMap<string, number>
}

const PinsContext = createContext<PinRegistration | null>(null)

/** The strip's registry: every card reports once, and the strip hands back its sorted rank. */
export function usePinRegistry() {
  const [cards, setCards] = useState<PinCardMeta[]>([])
  const register = useCallback((card: PinCardMeta) => {
    setCards((current) => {
      const existing = current.find((item) => item.key === card.key)
      if (existing && existing.since === card.since && existing.notice === card.notice)
        return current
      return [...current.filter((item) => item.key !== card.key), card]
    })
    return () => setCards((current) => current.filter((item) => item.key !== card.key))
  }, [])
  const sorted = useMemo(() => sortPinCards(cards), [cards])
  const ranks = useMemo(() => new Map(sorted.map((card, index) => [card.key, index])), [sorted])
  const value = useMemo(() => ({ register, ranks }), [ranks, register])
  return { cards: sorted, ranks, value }
}

export function PinsProvider({ value, children }: { value: PinRegistration; children: ReactNode }) {
  return <PinsContext value={value}>{children}</PinsContext>
}

/** One needs-you card: a protected article that registers its place in the order. */
export function PinCard({
  pinKey,
  since,
  notice = false,
  label,
  variant,
  region = false,
  anchor,
  children,
}: {
  pinKey: string
  since: string
  notice?: boolean
  label: string
  /** Extra class beside the base one, e.g. `approval` gives `bold-approval`. */
  variant?: 'approval' | 'run-request' | 'question'
  /** The card is its own labelled region and `label` is the whole name (an agent's question: "builder asks"). */
  region?: boolean
  /** 3.24.0: where in the conversation the card sits (its message, else its topic's end, else the end). */
  anchor?: PinAnchor
  children: ReactNode
}) {
  const context = useContext(PinsContext)
  const register = context?.register
  useEffect(() => {
    if (!register) return
    return register({ key: pinKey, since, notice })
  }, [notice, pinKey, register, since])
  const rank = context?.ranks.get(pinKey)
  const { inSlots, target } = useNeedsTarget(anchor)
  const card = (
    <article
      className={variant ? `bold-request bold-${variant}` : 'bold-request'}
      data-protected="flex"
      data-pin-key={pinKey}
      data-pin-rank={rank}
      tabIndex={-1}
      style={rank === undefined ? undefined : { order: rank }}
      role={region ? 'region' : undefined}
      aria-label={region ? label : `Needs you: ${label}`}
    >
      {children}
    </article>
  )
  // Inside a conversation the card lives in one host element that is moved between slots (a new message can change where
  // the card belongs), so the card's own state (a half-typed answer) and focus survive the move.
  const [host] = useState(() => {
    const element = document.createElement('div')
    element.className = 'bold-needs-host'
    // Built in code, not JSX: marked here so a custom look can't hide the card's wrapper.
    element.setAttribute('data-protected', 'block')
    return element
  })
  useEffect(() => {
    if (!inSlots || !target) {
      host.remove()
      return
    }
    if (host.parentElement === target) return
    const active = document.activeElement
    const hadFocus = active instanceof HTMLElement && host.contains(active) ? active : null
    target.appendChild(host)
    hadFocus?.focus({ preventScroll: true })
  }, [host, inSlots, target])
  useEffect(() => () => host.remove(), [host])
  if (!inSlots) return card
  return createPortal(card, host)
}
