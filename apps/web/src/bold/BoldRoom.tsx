import type { AgentSummary, OutsideSession } from '@score/contract'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate, useOutletContext } from 'react-router'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { useStreamQuery } from '../data/query-client.ts'
import { useMediaQuery } from '../data/use-media.ts'
import { agentsQuery } from '../routes/chat/queries.ts'
import { agentNameColor, agentStateLabel } from './bold-agents.ts'
import { BoldLibrary } from './BoldLibrary.tsx'
import { BoldResults } from './BoldResults.tsx'
import { BookIcon, ChevronIcon, CloseIcon, GridIcon, ThreadIcon } from './BoldIcons.tsx'
import { BoldWorkbench } from './BoldWorkbench.tsx'
import { boldResultsLink, boldWorkbenchLink } from './bold-links.ts'
import type { BoldSheetState } from './bold-ui.ts'
import { BoldThread } from './room/BoldThread.tsx'
import { BoldTeamRoom } from './room/BoldTeamRoom.tsx'
import { BoldElsewhere } from './room/BoldElsewhere.tsx'

const PHONE = '(max-width: 860px)'

type SideMode = 'work' | 'library' | 'thread' | 'elsewhere' | `agent:${string}`

function sideCopy(mode: SideMode, agent: AgentSummary | undefined): string {
  if (mode === 'work') return 'The Work panel comes in a later task.'
  if (mode === 'library') return ''
  if (mode === 'thread') return ''
  if (mode === 'elsewhere') return 'A chat from elsewhere.'
  return `Your one-to-one with ${agent?.id ?? 'this agent'} comes in a later task.`
}

function SideGlyph({ agent }: { agent: AgentSummary }) {
  return (
    <span className="side-glyph">
      <AgentGlyph agent={agent} size="sm" plain bare decorative />
    </span>
  )
}

/** The room column and the switchable side panel: the frame only, until 11.4/11.5 bring the screens inside it. */
export function BoldRoom() {
  const agents = useStreamQuery(agentsQuery).data ?? []
  const phone = useMediaQuery(PHONE)
  const { sheetOpen, setSheetOpen } = useOutletContext<BoldSheetState>()
  const location = useLocation()
  const navigate = useNavigate()
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
  const workbenchVisible =
    mode === 'work' &&
    ['workbench', 'code', 'screen', 'draft'].includes(
      new URLSearchParams(location.search).get('work') ?? '',
    )
  const [menuOpen, setMenuOpen] = useState(false)
  const sideRef = useRef<HTMLElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const phoneOpenRef = useRef<HTMLButtonElement>(null)
  const phoneCloseRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const agent = mode.startsWith('agent:')
    ? agents.find((item) => item.id === mode.slice(6))
    : undefined
  const elsewhereAgent = elsewhere
    ? agents.find((item) => item.id === elsewhere.agentId)
    : undefined
  const label =
    mode === 'work'
      ? 'Work'
      : mode === 'library'
        ? 'Library'
        : mode === 'thread'
          ? 'Thread'
          : mode === 'elsewhere'
            ? `${elsewhere?.agentId ?? 'Elsewhere'} · ${elsewhere?.sourceLabel ?? ''}`.trim()
            : agent?.id

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
      setSheetOpen(false)
      requestAnimationFrame(() => phoneOpenRef.current?.focus())
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [phone, setSheetOpen, sheetOpen])

  useEffect(() => {
    if (phone && sheetOpen) phoneCloseRef.current?.focus()
  }, [phone, sheetOpen])

  useEffect(() => {
    if (!phone) setSheetOpen(false)
  }, [phone, setSheetOpen])

  const choose = (next: SideMode) => {
    if (next === 'thread') {
      const current = new URLSearchParams(location.search).get('job')
      if (current && current !== 'all') setThreadJob(current)
    }
    setMode(next)
    setMenuOpen(false)
    toggleRef.current?.focus()
  }
  const openThread = (jobId: string | null) => {
    setThreadJob(jobId)
    setMode('thread')
    setMenuOpen(false)
    if (phone) setSheetOpen(true)
    toggleRef.current?.focus()
  }
  const closeSheet = () => {
    setSheetOpen(false)
    setMenuOpen(false)
    requestAnimationFrame(() => phoneOpenRef.current?.focus())
  }
  const openElsewhere = (session: OutsideSession) => {
    setElsewhere(session)
    setMode('elsewhere')
    setSheetOpen(true)
  }
  const broughtIntoJob = (jobId: string) => {
    setMode('work')
    setSheetOpen(false)
    navigate(`/b?job=${encodeURIComponent(jobId)}`)
  }
  const option = (target: SideMode, icon: ReactNode, name: string, hint: string) => (
    <button
      key={target}
      type="button"
      aria-current={mode === target ? 'true' : undefined}
      className={`mi ${mode === target ? 'sel' : ''}`}
      onClick={() => choose(target)}
    >
      {icon}
      <span className="menu-copy">
        <b>{name}</b>
        <span className="small muted">{hint}</span>
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
        className={`bold-sidecol${phone && sheetOpen ? ' open' : ''}`}
        hidden={phone && !sheetOpen}
      >
        <aside
          className="side"
          id="bold-side-panel"
          ref={sideRef}
          aria-label="Side panel"
          aria-modal={phone && sheetOpen ? true : undefined}
        >
          <div className="sidehead">
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
              ) : mode === 'thread' ? (
                <ThreadIcon />
              ) : mode === 'elsewhere' && elsewhereAgent ? (
                <SideGlyph agent={elsewhereAgent} />
              ) : agent ? (
                <SideGlyph agent={agent} />
              ) : null}
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
            {agent && (
              <span className="small muted side-privacy">Only you and {agent.id} see this</span>
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
            {menuOpen && (
              <div className="menu side-menu" id={menuId}>
                {option('work', <GridIcon />, 'Work', 'What the team is making')}
                {option('library', <BookIcon />, 'Library', 'Notes and files')}
                {option('thread', <ThreadIcon />, 'Thread', "A job's back-and-forth")}
                {agents.length > 0 && <div className="sec">One to one</div>}
                {agents.map((item) =>
                  option(
                    `agent:${item.id}`,
                    <SideGlyph agent={item} />,
                    item.id,
                    agentStateLabel(item),
                  ),
                )}
              </div>
            )}
          </div>
          {mode === 'thread' && (
            <BoldThread jobId={threadJob} onSelectJob={(jobId) => setThreadJob(jobId)} />
          )}
          {mode !== 'library' &&
            mode !== 'work' &&
            mode !== 'thread' &&
            (mode === 'elsewhere' && elsewhere ? (
              <BoldElsewhere
                key={`${elsewhere.agentId}:${elsewhere.id}`}
                session={elsewhere}
                agents={agents}
                onBroughtIn={broughtIntoJob}
              />
            ) : (
              <div className="sidebody" data-placeholder={mode}>
                <p className="side-placeholder">{sideCopy(mode, agent)}</p>
                {agent && (
                  <span className="side-agent-name" style={{ color: agentNameColor(agent) }}>
                    {agent.id}
                  </span>
                )}
              </div>
            ))}
          <BoldResults agents={agents} hidden={mode !== 'work' || workbenchVisible} />
          <BoldWorkbench agents={agents} hidden={!workbenchVisible} />
          <BoldLibrary agents={agents} hidden={mode !== 'library'} />
        </aside>
      </div>
    </div>
  )
}
