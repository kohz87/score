import { useEffect, useId, useRef, useState, type ReactNode, type Ref } from 'react'

/** The sections the person can fold in Info (3.27.1), by kind; a direct chat's Workspace is the same kind as a group's. */
export type InfoSectionKind =
  'members' | 'workspace' | 'topic' | 'files' | 'topics' | 'agent' | 'chats' | 'add'

const DEFAULT_OPEN: Record<InfoSectionKind, boolean> = {
  members: false,
  workspace: false,
  topic: true,
  files: true,
  topics: false,
  agent: false,
  chats: false,
  add: false,
}

const storageKey = (kind: InfoSectionKind) => `score.info-fold.${kind}`

function readOpen(kind: InfoSectionKind): boolean {
  try {
    const stored = window.localStorage.getItem(storageKey(kind))
    if (stored === 'open') return true
    if (stored === 'folded') return false
  } catch {
    // No storage (a private window, blocked site data): the defaults apply.
  }
  return DEFAULT_OPEN[kind]
}

function saveOpen(kind: InfoSectionKind, open: boolean): void {
  try {
    window.localStorage.setItem(storageKey(kind), open ? 'open' : 'folded')
  } catch {
    // Not remembered; the section still toggles.
  }
}

/**
 * One foldable Info section: the heading is the toggle (aria-expanded / aria-controls) and shows a short summary while
 * folded. `needsYou` is a decision inside: the section opens by itself when one arrives, and while folded again by the
 * person the heading carries a protected badge, so a fold never hides a decision (AGENTS.md design rules).
 * `forceOpen` changes (a `?jobs=1` / `?work=results` landing) also open it.
 */
export function InfoSection({
  kind,
  headingId,
  title,
  summary,
  needsYou = false,
  forceOpen = 0,
  headingRef,
  testId,
  className,
  children,
}: {
  kind: InfoSectionKind
  headingId: string
  title: string
  /** Shown after the title while folded ("11", "none", "3 open"). */
  summary?: string | undefined
  needsYou?: boolean
  /** A counter: each increase opens the section and (the caller scrolls) lands on it. */
  forceOpen?: number
  headingRef?: Ref<HTMLHeadingElement>
  testId?: string
  className?: string
  children: ReactNode
}) {
  const bodyId = useId()
  const [open, setOpenState] = useState(() => readOpen(kind) || needsYou || forceOpen > 0)
  const setOpen = (next: boolean) => {
    setOpenState(next)
    saveOpen(kind, next)
  }
  // A decision arriving opens the section (not remembered: the person's own choice is what is saved).
  const wasWaiting = useRef(needsYou)
  useEffect(() => {
    if (needsYou && !wasWaiting.current) setOpenState(true)
    wasWaiting.current = needsYou
  }, [needsYou])
  const seenForce = useRef(forceOpen)
  useEffect(() => {
    if (forceOpen !== seenForce.current) {
      seenForce.current = forceOpen
      setOpenState(true)
    }
  }, [forceOpen])
  return (
    <section
      className={className}
      aria-labelledby={headingId}
      data-testid={testId}
      data-open={open ? 'true' : 'false'}
    >
      <h2 id={headingId} ref={headingRef} className="bold-chat-kicker bold-info-head" tabIndex={-1}>
        <button
          type="button"
          className="bold-info-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen(!open)}
        >
          <span className="bold-info-caret" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          <span>{title}</span>{' '}
          {!open && summary ? <span className="bold-info-summary">· {summary}</span> : null}
        </button>
        {!open && needsYou && (
          <span className="bold-info-needs" data-protected="inline-flex">
            Needs you
          </span>
        )}
      </h2>
      <div id={bodyId} className="bold-info-body" hidden={!open}>
        {children}
      </div>
    </section>
  )
}
