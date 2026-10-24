import type { AgentSummary, OutsideSession } from '@score/contract'
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Link, useLocation, useNavigate, useOutletContext, useSearchParams } from 'react-router'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { useStreamQuery } from '../data/query-client.ts'
import { useMediaQuery } from '../data/use-media.ts'
import { agentsQuery } from '../routes/chat/queries.ts'
import { agentNameColor, agentStateLabel } from './bold-agents.ts'
import { BoldLibrary } from './BoldLibrary.tsx'
import { BoldResults } from './BoldResults.tsx'
import { BookIcon, ChevronIcon, CloseIcon, GridIcon, ThreadIcon } from './BoldIcons.tsx'
import { BoldWorkbench } from './BoldWorkbench.tsx'
import { boldOneToOneLink, boldResultsLink, boldWorkbenchLink } from './bold-links.ts'
import type { BoldSheetState } from './bold-ui.ts'
import { BoldDirect, DirectHeaderActions, PrivacyNote } from './direct/BoldDirect.tsx'
import { BoldElsewhere } from './room/BoldElsewhere.tsx'
import { BoldThread } from './room/BoldThread.tsx'
import { BoldTeamRoom } from './room/BoldTeamRoom.tsx'

const PHONE = '(max-width: 860px)'

type SideMode = 'work' | 'library' | 'thread' | 'elsewhere' | `agent:${string}`

function sideCopy(mode: SideMode): string {
  if (mode === 'work') return 'The Work panel comes in a later task.'
  if (mode === 'library') return ''
  return ''
}

function SideGlyph({ agent }: { agent: AgentSummary }) {
  return (
    <span className="side-glyph">
      <AgentGlyph agent={agent} size="sm" bare decorative />
    </span>
  )
}

/** The room column and the switchable side panel (PLAN 11.3), with the one-to-one as its agent mode (11.7). */
export function BoldRoom() {
  const agentsState = useStreamQuery(agentsQuery)
  const agents = agentsState.data ?? []
  const phone = useMediaQuery(PHONE)
  const { sheetOpen, setSheetOpen } = useOutletContext<BoldSheetState>()
  const location = useLocation()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [mode, setMode] = useState<SideMode>('work')
  const [elsewhere, setElsewhere] = useState<OutsideSession | null>(null)
  const [threadJob, setThreadJob] = useState<string | null>(null)
  // The thread follows the room's job tab: another tab opens that job's thread, All goes back to the picker.
  const tabJob = new URLSearchParams(location.search).get('job')
  const [seenTabJob, setSeenTabJob] = useState(tabJob)
  if (tabJob !== seenTabJob) {
    setSeenTabJob(tabJob)
    setThreadJob(tabJob && tabJob !== 'all' ? tabJob : null)
  }
  const [menuOpen, setMenuOpen] = useState(false)
  const sideRef = useRef<HTMLElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const phoneOpenRef = useRef<HTMLButtonElement>(null)
  const phoneCloseRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const closeSheetRef = useRef<() => void>(() => undefined)

  const directId = params.get('with')
  const directAgent = directId ? agents.find((item) => item.id === directId) : undefined
  const directMode = directId !== null
  const chatId = params.get('chat')
  const referenceJobId = params.get('ref')
  const workbenchVisible =
    !directMode &&
    mode === 'work' &&
    ['workbench', 'code', 'screen', 'draft'].includes(params.get('work') ?? '')
  const activeMode: SideMode = directAgent ? `agent:${directAgent.id}` : mode
  const label = directMode
    ? (directAgent?.id ?? directId)
    : mode === 'work'
      ? 'Work'
      : mode === 'library'
        ? 'Library'
        : mode === 'elsewhere'
          ? `${elsewhere?.agentId ?? 'Elsewhere'} · ${elsewhere?.sourceLabel ?? ''}`.trim()
          : 'Thread'
  const elsewhereAgent = elsewhere
    ? agents.find((item) => item.id === elsewhere.agentId)
    : undefined

  useEffect(() => {
    if (!menuOpen) return
    function onPointerDown(event: PointerEvent) {
      if (!sideRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        setMenuOpen(false)
        toggleRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  useEffect(() => {
    if (!phone || !sheetOpen) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const dialog =
        event.target instanceof Element
          ? event.target.closest('[role="dialog"], [aria-modal="true"]')
          : null
      // The sheet itself is labelled aria-modal; a dialog *inside* it owns its own Escape.
      if (dialog && dialog !== sideRef.current) return
      event.preventDefault()
      closeSheetRef.current()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [phone, sheetOpen])

  useEffect(() => {
    if (phone && sheetOpen) phoneCloseRef.current?.focus()
  }, [phone, sheetOpen])

  useEffect(() => {
    if (!phone) setSheetOpen(false)
  }, [phone, setSheetOpen])

  // A direct link (dock, Search, the Team page's Message button) opens the phone sheet itself.
  useEffect(() => {
    if (phone && directMode) setSheetOpen(true)
  }, [directMode, phone, setSheetOpen])

  const withoutDirect = (next: URLSearchParams) => {
    next.delete('with')
    next.delete('chat')
    next.delete('ref')
    return next
  }

  const choose = (next: SideMode) => {
    if (next === 'thread') {
      const current = new URLSearchParams(location.search).get('job')
      if (current && current !== 'all') setThreadJob(current)
    }
    setMode(next)
    setMenuOpen(false)
    setParams(withoutDirect(new URLSearchParams(params)), { replace: true })
    toggleRef.current?.focus()
  }

  const openElsewhere = (session: OutsideSession) => {
    setElsewhere(session)
    setMode('elsewhere')
    setMenuOpen(false)
    setParams(withoutDirect(new URLSearchParams(params)), { replace: true })
    setSheetOpen(true)
  }
  const broughtIntoJob = (jobId: string) => {
    setMode('work')
    setSheetOpen(false)
    void navigate(`/b?job=${encodeURIComponent(jobId)}`)
  }
  const openThread = (jobId: string | null) => {
    setThreadJob(jobId)
    setMode('thread')
    setMenuOpen(false)
    // A one-to-one is driven by `?with=`: opening a thread leaves it, as choosing a mode does.
    setParams(withoutDirect(new URLSearchParams(params)), { replace: true })
    if (phone) setSheetOpen(true)
    toggleRef.current?.focus()
  }

  const chooseAgent = (agentId: string) => {
    setMenuOpen(false)
    void navigate(boldOneToOneLink(agentId))
  }

  const backToRoom = () => {
    setMenuOpen(false)
    setSheetOpen(false)
    const next = withoutDirect(new URLSearchParams(params))
    void navigate({ pathname: location.pathname, search: next.toString() ? `?${next}` : '' })
  }

  const closeSheet = () => {
    if (directMode) backToRoom()
    else {
      setSheetOpen(false)
      setMenuOpen(false)
      requestAnimationFrame(() => phoneOpenRef.current?.focus())
    }
  }

  // The sheet's Escape closes it the same way its own close button does (a one-to-one drops `?with=`).
  useEffect(() => {
    closeSheetRef.current = closeSheet
  })

  const option = (target: SideMode, icon: ReactNode, name: string, hint: string) => (
    <button
      key={target}
      type="button"
      aria-current={activeMode === target ? 'true' : undefined}
      className={`mi ${activeMode === target ? 'sel' : ''}`}
      onClick={() => choose(target)}
    >
      {icon}
      <span className="menu-copy">
        <b>{name}</b>
        <span className="small muted">{hint}</span>
      </span>
    </button>
  )
  const agentOption = (item: AgentSummary) => (
    <button
      key={`agent:${item.id}`}
      type="button"
      aria-current={activeMode === `agent:${item.id}` ? 'true' : undefined}
      className={`mi ${activeMode === `agent:${item.id}` ? 'sel' : ''}`}
      onClick={() => chooseAgent(item.id)}
    >
      <SideGlyph agent={item} />
      <span className="menu-copy">
        <b>{item.id}</b>
        <span className="small muted">{agentStateLabel(item)}</span>
      </span>
    </button>
  )

  const phoneAction = phone ? (
    <button
      ref={phoneOpenRef}
      type="button"
      className="btn sm phone-side-open"
      aria-expanded={sheetOpen}
      aria-controls="bold-side-panel"
      onClick={() => setSheetOpen(true)}
    >
      <BookIcon /> Open side panel
    </button>
  ) : undefined

  return (
    <div className="roomgrid">
      <section className="roomcol" aria-label="Team room" inert={phone && sheetOpen}>
        <BoldTeamRoom
          agents={agents}
          phoneAction={phoneAction}
          onOpenElsewhere={openElsewhere}
          onOpenThread={openThread}
        />
      </section>

      <div
        className={`bold-sidecol${phone && sheetOpen ? ' open' : ''}${directMode ? ' bold-dm-open' : ''}`}
        hidden={phone && !sheetOpen}
      >
        <aside
          className={`side${directAgent ? ' bold-dm-side' : ''}`}
          id="bold-side-panel"
          ref={sideRef}
          aria-label="Side panel"
          aria-modal={phone && sheetOpen ? true : undefined}
          style={
            directAgent
              ? ({
                  '--dm-color': directAgent.style.color,
                  '--dm-glow': `${directAgent.style.color}44`,
                } as CSSProperties)
              : undefined
          }
        >
          <div className={`sidehead${directAgent ? ' bold-dm-head' : ''}`}>
            {directAgent ? (
              phone ? (
                <>
                  <button
                    ref={phoneCloseRef}
                    type="button"
                    className="icon-btn sm bold-dm-back"
                    aria-label="Back"
                    onClick={backToRoom}
                  >
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M15 18l-6-6 6-6" />
                    </svg>
                  </button>
                  <span className="bold-dm-phone-id">
                    <AgentGlyph agent={directAgent} size="sm" bare decorative />
                    <span>
                      <b style={{ color: agentNameColor(directAgent) }}>{directAgent.id}</b>
                      <PrivacyNote agentId={directAgent.id} />
                    </span>
                  </span>
                  <DirectHeaderActions agent={directAgent} chatId={chatId} iconOnly />
                </>
              ) : (
                <>
                  <button
                    ref={toggleRef}
                    type="button"
                    className="btn sm side-toggle bold-dm-identity"
                    aria-expanded={menuOpen}
                    aria-controls={menuId}
                    onClick={() => setMenuOpen((open) => !open)}
                  >
                    <SideGlyph agent={directAgent} />
                    {directAgent.id}
                    <ChevronIcon />
                  </button>
                  <DirectHeaderActions agent={directAgent} chatId={chatId} />
                  <PrivacyNote agentId={directAgent.id} />
                </>
              )
            ) : (
              <>
                <button
                  ref={toggleRef}
                  type="button"
                  className="btn sm side-toggle"
                  aria-expanded={menuOpen}
                  aria-controls={menuId}
                  onClick={() => setMenuOpen((open) => !open)}
                >
                  {mode === 'work' ? (
                    <GridIcon />
                  ) : mode === 'library' ? (
                    <BookIcon />
                  ) : mode === 'elsewhere' && elsewhereAgent ? (
                    <SideGlyph agent={elsewhereAgent} />
                  ) : (
                    <ThreadIcon />
                  )}
                  {label}
                  <ChevronIcon />
                </button>
                {mode === 'work' && (
                  <nav className="seg bold-work-tabs" aria-label="How to see the work">
                    <Link
                      className={workbenchVisible ? undefined : 'on'}
                      aria-current={workbenchVisible ? undefined : 'page'}
                      to={boldResultsLink(location.search)}
                    >
                      Results
                    </Link>
                    <Link
                      className={workbenchVisible ? 'on' : undefined}
                      aria-current={workbenchVisible ? 'page' : undefined}
                      to={boldWorkbenchLink(location.search)}
                    >
                      Workbench
                    </Link>
                  </nav>
                )}
                {phone && (
                  <button
                    ref={phoneCloseRef}
                    type="button"
                    className="icon-btn sm sideclose"
                    aria-label="Close side panel"
                    onClick={closeSheet}
                  >
                    <CloseIcon />
                  </button>
                )}
              </>
            )}

            {menuOpen && (
              <div className="menu side-menu" id={menuId}>
                {option('work', <GridIcon />, 'Work', 'What the team is making')}
                {option('library', <BookIcon />, 'Library', 'Notes and files')}
                {option('thread', <ThreadIcon />, 'Thread', "A job's back-and-forth")}
                {agents.length > 0 && <div className="sec">One to one</div>}
                {agents.map(agentOption)}
              </div>
            )}
          </div>

          {directMode ? (
            <div className="sidebody bold-dm-sidebody" data-placeholder="agent">
              {directAgent ? (
                <BoldDirect
                  agent={directAgent}
                  agents={agents}
                  chatId={chatId}
                  referenceJobId={referenceJobId}
                  onClearReference={() => {
                    if (!params.has('ref')) return
                    const next = new URLSearchParams(params)
                    next.delete('ref')
                    setParams(next, { replace: true })
                  }}
                  onCloseSheet={phone ? closeSheet : undefined}
                />
              ) : (
                <p className="bold-stream-note bold-dm-status" role="status">
                  {agentsState.status === 'pending'
                    ? 'Opening your chats…'
                    : 'That agent isn’t on your team any more.'}
                </p>
              )}
            </div>
          ) : mode === 'thread' ? (
            <BoldThread jobId={threadJob} onSelectJob={(jobId) => setThreadJob(jobId)} />
          ) : mode === 'elsewhere' && elsewhere ? (
            <BoldElsewhere
              key={`${elsewhere.agentId}:${elsewhere.id}`}
              session={elsewhere}
              agents={agents}
              onBroughtIn={broughtIntoJob}
            />
          ) : (
            mode !== 'library' &&
            mode !== 'work' && (
              <div className="sidebody" data-placeholder={mode}>
                <p className="side-placeholder">{sideCopy(mode)}</p>
              </div>
            )
          )}
          <BoldResults agents={agents} hidden={directMode || mode !== 'work' || workbenchVisible} />
          <BoldWorkbench agents={agents} hidden={directMode || !workbenchVisible} />
          <BoldLibrary agents={agents} hidden={directMode || mode !== 'library'} />
        </aside>
      </div>
    </div>
  )
}
