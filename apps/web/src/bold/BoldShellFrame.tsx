import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router'
import { BoldFrameContext } from '../shell/framed-paths.tsx'
import { useStreamQuery } from '../data/query-client.ts'
import { useTextScale } from '../data/text-scale.ts'
import { useMediaQuery } from '../data/use-media.ts'
import { agentsQuery, roomsQuery } from '../routes/chat/queries.ts'
import { useNeedsElsewhere } from './use-needs-elsewhere.ts'
import { useRoomNeedsYouState } from './room/use-needs-you.ts'
import { NotificationBridge } from '../notifications/NotificationBridge.tsx'
import { UpdateBanner } from '../pwa/UpdateBanner.tsx'
import { usePreview } from '../themes/preview-context.ts'
import { useLook } from '../themes/use-look.ts'
import { BoldSearch } from './BoldSearch.tsx'
import { BookIcon, GearIcon, RoomIcon, SearchIcon, TeamIcon, TerminalIcon } from './BoldIcons.tsx'
import { useTerminalAvailable } from '../shell/TerminalButton.tsx'
import { isTerminalShortcut } from './terminal-shortcut.ts'
import { terminalBackTarget } from './BoldTerminal.tsx'
import type { BoldSheetState } from './bold-ui.ts'
import { BoldStartJob, StartJobContext, type StartJobOptions } from './BoldStartJob.tsx'
import { DeleteToast } from '../routes/chat/DeleteToast.tsx'
import { JobUndoToast } from './room/JobUndoToast.tsx'
import { HermesCheckNotice, ShellFenceNotice } from './BoldShellNotices.tsx'
import { PHONE, viewOf, type View } from './bold-shell-model.ts'

export function BoldShellFrame() {
  const agents = useStreamQuery(agentsQuery).data ?? []
  const navigate = useNavigate()
  const location = useLocation()
  const view = viewOf(location.pathname)
  const phone = useMediaQuery(PHONE)
  // The phone badge counts the same job the strip does. It waits for the canonical team-room read: before that the
  // room's jobs are unknown, and counting All would briefly inflate the badge and then change it.
  const roomJob = new URLSearchParams(location.search).get('job') ?? 'all'
  const roomNeeds = useRoomNeedsYouState({ roomId: null, jobs: [], selectedJob: roomJob })
  // Decision 184: with the dock gone the Chats button is where every page says something waits, so it also counts the
  // approvals and questions in other chats; the team room counts its own items.
  const elsewhere = useNeedsElsewhere()
  // What has loaded counts at once; a failed read shows the count as "at least" (N+, or ! when nothing loaded).
  const roomNeedsYou = roomNeeds.total + elsewhere
  const roomNeedsShort = roomNeeds.incomplete
  const roomBadge =
    roomNeedsYou > 0
      ? `${roomNeedsYou > 99 ? '99' : roomNeedsYou}${roomNeedsShort || roomNeedsYou > 99 ? '+' : ''}`
      : roomNeedsShort
        ? '!'
        : null
  // The count says what it means, on a desktop too (the phone tab always did).
  const chatsLabel =
    roomNeedsYou > 0
      ? `Chats, ${roomNeedsShort ? 'at least ' : ''}${roomNeedsYou} need you`
      : roomNeedsShort
        ? 'Chats, couldn’t check everything that needs you'
        : 'Chats'
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
  const [startOptions, setStartOptions] = useState<StartJobOptions | undefined>()
  const openStartJob = useCallback((options?: StartJobOptions) => {
    setStartOptions(options)
    setStartOpened(true)
  }, [])
  const closeStartJob = useCallback(() => {
    setStartOpened(false)
    setStartOptions(undefined)
    const params = new URLSearchParams(location.search)
    if (params.get('start') === 'job') {
      params.delete('start')
      params.delete('recipe')
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
  // The room fills the window: body.fit stops the page scrolling and lets the room and side panel scroll inside. Only
  // the room: Agents, Knowledge and Settings are ordinary pages, and a fixed-height frame clipped them below the fold on phones.
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
      aria-label={target === 'room' ? chatsLabel : undefined}
      onClick={go(to)}
    >
      {label}
      {/* The Chats button carries the needs-you count on every width (decision 184: no team rings any more). */}
      {target === 'room' && roomBadge && (
        <span className="bold-nav-count" data-protected="inline-flex">
          {roomBadge}
        </span>
      )}
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
        <div className="bold-frame" inert={commandOpen || startOpen}>
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
                {navButton('room', 'Chats', '/b')}
                {navButton('agents', 'Agents', '/b/agents')}
                {navButton('knowledge', 'Knowledge', '/b/knowledge')}
                {navButton('tasks', 'Tasks', '/b/tasks')}
                {navButton('screens', 'Screens', '/b/screens')}
              </nav>
            )}
            {phone && (
              <span className="bold-top-links">
                <button type="button" className="btn sm" onClick={go('/b/tasks')}>
                  Tasks
                </button>
                <button type="button" className="btn sm" onClick={go('/b/screens')}>
                  Screens
                </button>
              </span>
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
                <span className="searchbtn-label">Search</span>
                <span className="kbd">⌘K</span>
              </button>
            )}
            {!phone && (
              <button
                type="button"
                className={`icon-btn gear ${view === 'settings' ? 'on' : ''}`}
                aria-label="Settings"
                aria-current={view === 'settings' ? 'page' : undefined}
                data-protected="raised"
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
            <HermesCheckNotice pathname={location.pathname} />
            {!preview && <NotificationBridge />}
            {!preview && <UpdateBanner />}
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
                aria-label={chatsLabel}
                onClick={go('/b')}
              >
                <RoomIcon />
                <span>Chats</span>
                {roomBadge && (
                  <span className="bold-tab-count" data-protected="inline-flex">
                    {roomBadge}
                  </span>
                )}
              </button>
              <button
                type="button"
                className={view === 'agents' ? 'on' : undefined}
                aria-current={view === 'agents' ? 'page' : undefined}
                onClick={go('/b/agents')}
              >
                <TeamIcon />
                Agents
              </button>
              <button
                type="button"
                className={view === 'knowledge' ? 'on' : undefined}
                aria-current={view === 'knowledge' ? 'page' : undefined}
                onClick={go('/b/knowledge')}
              >
                <BookIcon size={22} />
                Knowledge
              </button>
              <button ref={searchTrigger} type="button" onClick={openCommand}>
                <SearchIcon size={22} />
                Search
              </button>
              <button
                type="button"
                className={view === 'settings' ? 'on' : undefined}
                aria-current={view === 'settings' ? 'page' : undefined}
                data-protected="raised"
                onClick={go('/b/settings')}
              >
                <GearIcon size={22} />
                Settings
              </button>
            </nav>
          )}
        </div>
        {commandOpen && (
          <BoldSearch
            agents={agents}
            light={light}
            onClose={closeCommand}
            onToggleLook={() => setManualLight(!light)}
            onResetLook={() => setManualLight(null)}
          />
        )}
        {startOpen && <BoldStartJob onClose={closeStartJob} options={startOptions} />}
        <JobUndoToast />
        {/* A message delete is undoable for a few seconds in every bold surface (room, one-to-one, thread). */}
        <DeleteToast className="bold-job-toasts bold-delete-toasts" />
      </div>
    </StartJobContext>
  )
}
