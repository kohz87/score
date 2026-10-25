import type { AgentSummary } from '@score/contract'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { Link, Outlet, useLocation, useNavigate } from 'react-router'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { BoldFrameContext } from '../shell/framed-paths.tsx'
import { BoldRecipes } from './BoldRecipes.tsx'
import { useStreamQuery } from '../data/query-client.ts'
import { useTextScale } from '../data/text-scale.ts'
import { useMediaQuery } from '../data/use-media.ts'
import { agentsQuery, approvalsQuery, roomsQuery } from '../routes/chat/queries.ts'
import { useFence } from '../routes/orchestrations/orchestration-queries.ts'
import { approvalNeedsYou } from './room/room-model.ts'
import { useRoomNeedsYouState } from './room/use-needs-you.ts'
import { usePreview } from '../themes/preview-context.ts'
import { useLook } from '../themes/use-look.ts'
import { agentDisplayName, agentStateLabel, dockProgress } from './bold-agents.ts'
import { boldCloseRecipesLink, boldOneToOneLink } from './bold-links.ts'
import { BoldSearch } from './BoldSearch.tsx'
import { GearIcon, RoomIcon, SearchIcon, TeamIcon, TerminalIcon } from './BoldIcons.tsx'
import { useTerminalAvailable } from '../shell/TerminalButton.tsx'
import { isTerminalShortcut } from './terminal-shortcut.ts'
import { terminalBackTarget } from './BoldTerminal.tsx'
import type { BoldSheetState } from './bold-ui.ts'
import { BoldStartJob, StartJobContext } from './BoldStartJob.tsx'
import { DeleteToast } from '../routes/chat/DeleteToast.tsx'
import { JobUndoToast } from './room/JobUndoToast.tsx'
import './tokens.css'
import './bold.css'
import './bold-theme.css'

const PHONE = '(max-width: 860px)'

type View = 'room' | 'team' | 'settings'

function viewOf(path: string): View {
  if (path.startsWith('/b/team')) return 'team'
  if (path.startsWith('/b/settings')) return 'settings'
  return 'room'
}

function DockRing({
  agent,
  needsYou,
  onOpen,
}: {
  agent: AgentSummary
  needsYou: boolean
  onOpen: () => void
}) {
  const progress = dockProgress()
  const state = needsYou ? 'needs you' : agentStateLabel(agent)
  const name = agentDisplayName(agent)
  return (
    <button
      type="button"
      className={`ring ${needsYou ? 'needs bold-needs' : ''}`}
      // A ring that says "needs you" is a decision marker no theme may hide (PLAN 11.3, AGENTS.md design rules).
      data-protected={needsYou ? 'grid' : undefined}
      aria-label={`One to one with ${name}, ${state}`}
      title={`${name} · ${state}`}
      onClick={onOpen}
      data-progress={progress ?? undefined}
      style={{
        background:
          progress !== null
            ? `conic-gradient(${agent.style.color} 0 ${progress}%, var(--line) 0)`
            : 'var(--line)',
      }}
    >
      <span className="dock-ring-inner">
        <AgentGlyph agent={agent} size="sm" bare decorative />
      </span>
    </button>
  )
}

/**
 * The bold shell's frame (PLAN 11.3a): the top bar and, on a phone, the fixed tab bar. The room and its side panel are
 * the index child; Settings' Look choices apply to this whole shell, not only its own page.
 */
export function BoldShell() {
  const agents = useStreamQuery(agentsQuery).data ?? []
  // An agent needs you while a decision of yours is open for it (as the classic Needs-you dot), not only while a run
  // says it waits.
  const approvals = useStreamQuery(approvalsQuery).data ?? []
  const waitingOn = new Set(approvals.filter(approvalNeedsYou).map((item) => item.agentId))
  const navigate = useNavigate()
  const location = useLocation()
  const recipesOpen = new URLSearchParams(location.search).get('recipes') === '1'
  const view = viewOf(location.pathname)
  const phone = useMediaQuery(PHONE)
  // The phone badge counts the same job the strip does. It waits for the canonical team-room read: before that the
  // room's jobs are unknown, and counting All would briefly inflate the badge and then change it.
  const roomJob = new URLSearchParams(location.search).get('job') ?? 'all'
  const roomNeeds = useRoomNeedsYouState({ roomId: null, jobs: [], selectedJob: roomJob })
  // What has loaded counts at once; a failed read shows the count as "at least" (N+, or ! when nothing loaded).
  const roomNeedsYou = roomNeeds.total
  const roomNeedsShort = roomNeeds.incomplete
  const roomBadge =
    roomNeedsYou > 0
      ? `${roomNeedsYou > 99 ? '99' : roomNeedsYou}${roomNeedsShort || roomNeedsYou > 99 ? '+' : ''}`
      : roomNeedsShort
        ? '!'
        : null
  const systemLight = useMediaQuery('(prefers-color-scheme: light)')
  const look = useLook()
  const preview = usePreview()
  const shellRef = useRef<HTMLDivElement>(null)
  // The Customizer's frame (11.9d) has a document of its own: the colour mode it previews is on its <html>, not the
  // host's Look, and the shell must never touch the Customizer page's body or keys.
  const [previewLight, setPreviewLight] = useState<boolean | null>(null)
  // A layout effect, so the Customizer's first paint already uses the frame's mode rather than the host's Look.
  useLayoutEffect(() => {
    const html = shellRef.current?.ownerDocument.documentElement
    if (!preview || !html) return
    const read = () => setPreviewLight(html.getAttribute('data-theme') === 'light')
    read()
    const observer = new MutationObserver(read)
    observer.observe(html, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [preview])
  const scale = useTextScale()
  // The Look setting (11.9a) decides; Search's "Switch to dark/light" (11.10f) overrides it for this visit only.
  const [manualLight, setManualLight] = useState<boolean | null>(null)
  const light =
    manualLight ?? previewLight ?? (look.mode === 'system' ? systemLight : look.mode === 'light')
  const resolvedLook = light ? 'light' : 'dark'
  const rooms = useStreamQuery(roomsQuery).data?.rooms
  const frame = useMemo(() => ({ look: resolvedLook, rooms }) as const, [resolvedLook, rooms])
  const [commandOpen, setCommandOpen] = useState(false)
  // Start a job is open while the address says `?start=job` (bold-links.ts) or the room's button opened it.
  const [startOpened, setStartOpened] = useState(false)
  const startOpen = startOpened || new URLSearchParams(location.search).get('start') === 'job'
  const openStartJob = useCallback(() => setStartOpened(true), [])
  const closeStartJob = useCallback(() => {
    setStartOpened(false)
    const params = new URLSearchParams(location.search)
    if (params.get('start') === 'job') {
      params.delete('start')
      const search = params.toString()
      void navigate(
        { pathname: location.pathname, search: search ? `?${search}` : '' },
        { replace: true },
      )
    }
  }, [location.pathname, location.search, navigate])
  const startContext = useMemo(() => ({ openStartJob }), [openStartJob])
  const [sheetOpen, setSheetOpen] = useState(false)
  const commandTrigger = useRef<HTMLElement | null>(null)
  const searchTrigger = useRef<HTMLButtonElement>(null)
  const dockHasProgress = agents.some(() => dockProgress() !== null)

  // The room fills the window: body.fit stops the page scrolling and lets the room and side panel scroll inside. Only
  // the room: Team and Settings are ordinary pages, and a fixed-height frame clipped them below the fold on phones.
  // The player screen is an ordinary page, even though it belongs to Room in the navigation.
  const fit = view === 'room' && location.pathname === '/b'
  useEffect(() => {
    const body = shellRef.current?.ownerDocument.body
    if (!fit || !body) return
    body.classList.add('fit')
    return () => body.classList.remove('fit')
  }, [fit])

  const openCommand = useCallback(() => {
    if (commandOpen) return
    const active = document.activeElement
    commandTrigger.current =
      active instanceof HTMLElement &&
      active !== document.body &&
      active !== document.documentElement
        ? active
        : searchTrigger.current
    setCommandOpen(true)
  }, [commandOpen])
  const closeCommand = useCallback(() => {
    setCommandOpen(false)
    requestAnimationFrame(() => commandTrigger.current?.focus())
  }, [])

  useEffect(() => {
    if (preview) return
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        openCommand()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [openCommand, preview])

  // The terminal button exists only when the server offers a terminal (never when it reports it unavailable).
  const terminalOffered = useTerminalAvailable(preview)
  const onTerminal = location.pathname === '/b/terminal'
  const toggleTerminal = useCallback(() => {
    if (onTerminal) void navigate(terminalBackTarget(location.state))
    else
      void navigate('/b/terminal', {
        state: { terminalFrom: `${location.pathname}${location.search}` },
      })
  }, [onTerminal, navigate, location.state, location.pathname, location.search])
  useEffect(() => {
    if (preview || !terminalOffered) return
    function onKeyDown(event: KeyboardEvent) {
      if (!isTerminalShortcut(event)) return
      event.preventDefault()
      toggleTerminal()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [preview, terminalOffered, toggleTerminal])

  const go = (to: string) => () => void navigate(to)
  const navButton = (target: View, label: string, to: string) => (
    <button
      type="button"
      className={view === target ? 'on' : undefined}
      aria-current={view === target ? 'page' : undefined}
      onClick={go(to)}
    >
      {label}
    </button>
  )

  return (
    <StartJobContext value={startContext}>
      <div
        ref={shellRef}
        className="bold-shell"
        data-ui="bold"
        data-look={resolvedLook}
        style={{ '--scale': scale } as CSSProperties}
      >
        <div className="bold-frame" inert={commandOpen || recipesOpen || startOpen}>
          <header className="top" inert={phone && sheetOpen}>
            <button
              type="button"
              className="word"
              aria-label="Score, go to the team room"
              onClick={go('/b')}
            >
              score
            </button>
            {!phone && (
              <nav className="nav" aria-label="Main">
                {navButton('room', 'Room', '/b')}
                {navButton('team', 'Team', '/b/team')}
                <button type="button" onClick={go('/b?recipes=1')}>
                  Recipes
                </button>
              </nav>
            )}
            {!phone && (
              <div
                className="dock"
                role="group"
                aria-label="Your team. Click someone to talk one to one."
              >
                {agents.map((agent) => (
                  <DockRing
                    key={agent.id}
                    agent={agent}
                    needsYou={agent.status === 'waiting' || waitingOn.has(agent.id)}
                    onOpen={() => void navigate(boldOneToOneLink(agent.id, location.search))}
                  />
                ))}
                {dockHasProgress && (
                  <span className="small muted dock-note">Rings show progress</span>
                )}
              </div>
            )}
            {phone && (
              <button type="button" className="btn sm" onClick={go('/b?recipes=1')}>
                Recipes
              </button>
            )}
            {!phone && (
              <button
                ref={searchTrigger}
                type="button"
                className="searchbtn"
                aria-haspopup="dialog"
                aria-expanded={commandOpen}
                aria-label="Search"
                onClick={openCommand}
              >
                <SearchIcon />
                Search
                <span className="kbd">⌘K</span>
              </button>
            )}
            {!phone && (
              <button
                type="button"
                className={`icon-btn gear ${view === 'settings' ? 'on' : ''}`}
                aria-label="Settings"
                onClick={go('/b/settings')}
              >
                <GearIcon />
              </button>
            )}
            {terminalOffered && (
              <button
                type="button"
                className={`icon-btn bold-terminal-btn ${phone ? 'sm' : ''} ${onTerminal ? 'on' : ''}`}
                aria-label="Terminal"
                title="Terminal (Ctrl+`)"
                aria-keyshortcuts="Control+` Meta+`"
                onClick={toggleTerminal}
              >
                <TerminalIcon />
              </button>
            )}
            <span className="bold-avatar" aria-label="You">
              Y
            </span>
          </header>

          <main className="main">
            <ShellFenceNotice pathname={location.pathname} />
            <BoldFrameContext value={frame}>
              <Outlet context={{ sheetOpen, setSheetOpen } satisfies BoldSheetState} />
            </BoldFrameContext>
          </main>

          {phone && (
            <nav className="bold-tabbar" aria-label="Main" inert={phone && sheetOpen}>
              <button
                type="button"
                className={view === 'room' ? 'on' : undefined}
                aria-current={view === 'room' ? 'page' : undefined}
                aria-label={
                  roomNeedsYou > 0
                    ? `Room, ${roomNeedsShort ? 'at least ' : ''}${roomNeedsYou} need you`
                    : roomNeedsShort
                      ? 'Room, couldn’t check everything that needs you'
                      : 'Room'
                }
                onClick={go('/b')}
              >
                <RoomIcon />
                <span>Room</span>
                {roomBadge && (
                  <span className="bold-tab-count" data-protected="inline-flex">
                    {roomBadge}
                  </span>
                )}
              </button>
              <button
                type="button"
                className={view === 'team' ? 'on' : undefined}
                aria-current={view === 'team' ? 'page' : undefined}
                onClick={go('/b/team')}
              >
                <TeamIcon />
                Team
              </button>
              <button ref={searchTrigger} type="button" onClick={openCommand}>
                <SearchIcon size={22} />
                Search
              </button>
              <button
                type="button"
                className={view === 'settings' ? 'on' : undefined}
                aria-current={view === 'settings' ? 'page' : undefined}
                onClick={go('/b/settings')}
              >
                <GearIcon size={22} />
                Settings
              </button>
            </nav>
          )}
        </div>
        {recipesOpen && (
          <BoldRecipes
            onClose={() => {
              void navigate(boldCloseRecipesLink(location.search))
            }}
          />
        )}
        {commandOpen && (
          <BoldSearch
            agents={agents}
            light={light}
            onClose={closeCommand}
            onToggleLook={() => setManualLight(!light)}
            onResetLook={() => setManualLight(null)}
          />
        )}
        {startOpen && <BoldStartJob onClose={closeStartJob} />}
        <JobUndoToast />
        {/* A message delete is undoable for a few seconds in every bold surface (room, one-to-one, thread). */}
        <DeleteToast className="bold-job-toasts bold-delete-toasts" />
      </div>
    </StartJobContext>
  )
}

/**
 * A restore or lost journal blocks every run. The room's Needs-you strip carries the card; every other page of the
 * shell says it here, so the person can't miss it wherever they are (the review itself is Settings › System).
 */
function ShellFenceNotice({ pathname }: { pathname: string }) {
  const fence = useFence().data
  if (!fence?.fenced || pathname === '/b' || pathname === '/b/settings/system') return null
  return (
    <div className="bold-fence-notice" role="status" data-protected="flex">
      <span>Starting work is blocked until you review the runs it stopped.</span>
      <Link className="btn sm" to="/b/settings/system#global-fence">
        Review the runs
      </Link>
    </div>
  )
}
