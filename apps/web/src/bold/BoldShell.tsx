import type { AgentSummary } from '@score/contract'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { useStreamQuery } from '../data/query-client.ts'
import { useMediaQuery } from '../data/use-media.ts'
import { agentsQuery, approvalsQuery } from '../routes/chat/queries.ts'
import { CommandPalette } from '../shell/CommandPalette.tsx'
import { agentStateLabel, dockProgress } from './bold-agents.ts'
import { GearIcon, RoomIcon, SearchIcon, TeamIcon } from './BoldIcons.tsx'
import type { BoldSheetState } from './bold-ui.ts'
import './tokens.css'
import './bold.css'

const PHONE = '(max-width: 860px)'

type View = 'room' | 'team' | 'settings'

function viewOf(path: string): View {
  if (path.startsWith('/b/team')) return 'team'
  if (path.startsWith('/b/settings')) return 'settings'
  return 'room'
}

function DockRing({ agent, needsYou }: { agent: AgentSummary; needsYou: boolean }) {
  const progress = dockProgress()
  const state = needsYou ? 'needs you' : agentStateLabel(agent)
  return (
    <button
      type="button"
      className={`ring ${needsYou ? 'needs bold-needs' : ''}`}
      // A ring that says "needs you" is a decision marker no theme may hide (PLAN 11.3, AGENTS.md design rules).
      data-protected={needsYou ? 'grid' : undefined}
      aria-label={`One to one with ${agent.id}, ${state}`}
      title={`${agent.id} · ${state}`}
      data-progress={progress ?? undefined}
      style={{
        background:
          progress !== null
            ? `conic-gradient(${agent.style.color} 0 ${progress}%, var(--line) 0)`
            : 'var(--line)',
      }}
    >
      <span className="dock-ring-inner">
        <AgentGlyph agent={agent} size="sm" plain bare decorative />
      </span>
    </button>
  )
}

/**
 * The bold shell's frame (PLAN 11.3a): the top bar and, on a phone, the fixed tab bar. The room and its side panel are
 * the index child; Team and Settings are placeholders until 11.8 and 11.9.
 */
export function BoldShell() {
  const agents = useStreamQuery(agentsQuery).data ?? []
  // An agent needs you while a decision of yours is open for it (as the classic Needs-you dot), not only while a run
  // says it waits.
  const approvals = useStreamQuery(approvalsQuery).data ?? []
  const waitingOn = new Set(
    approvals
      .filter((item) => item.actionable && item.phase === 'human_pending')
      .map((item) => item.agentId),
  )
  const navigate = useNavigate()
  const location = useLocation()
  const view = viewOf(location.pathname)
  const phone = useMediaQuery(PHONE)
  const light = useMediaQuery('(prefers-color-scheme: light)')
  const [commandOpen, setCommandOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const commandTrigger = useRef<HTMLElement | null>(null)
  const dockHasProgress = agents.some(() => dockProgress() !== null)

  // The room fills the window: body.fit stops the page scrolling and lets the room and side panel scroll inside. Only
  // the room: Team and Settings are ordinary pages, and a fixed-height frame clipped them below the fold on phones.
  const fit = view === 'room'
  useEffect(() => {
    if (!fit) return
    document.body.classList.add('fit')
    return () => document.body.classList.remove('fit')
  }, [fit])

  const openCommand = useCallback(() => {
    if (commandOpen) return
    const active = document.activeElement
    commandTrigger.current = active instanceof HTMLElement ? active : null
    setCommandOpen(true)
  }, [commandOpen])
  const closeCommand = useCallback(() => {
    setCommandOpen(false)
    requestAnimationFrame(() => commandTrigger.current?.focus())
  }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        openCommand()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [openCommand])

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
    <div className="bold-shell" data-ui="bold" data-look={light ? 'light' : 'dark'}>
      <div className="bold-frame" inert={commandOpen}>
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
                />
              ))}
              {dockHasProgress && (
                <span className="small muted dock-note">Rings show progress</span>
              )}
            </div>
          )}
          {!phone && (
            <button
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
          <span className="bold-avatar" aria-label="You">
            Y
          </span>
        </header>

        <main className="main">
          <Outlet context={{ sheetOpen, setSheetOpen } satisfies BoldSheetState} />
        </main>

        {phone && (
          <nav className="bold-tabbar" aria-label="Main" inert={phone && sheetOpen}>
            <button
              type="button"
              className={view === 'room' ? 'on' : undefined}
              aria-current={view === 'room' ? 'page' : undefined}
              onClick={go('/b')}
            >
              <RoomIcon />
              Room
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
            <button type="button" onClick={openCommand}>
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
      {commandOpen && <CommandPalette onClose={closeCommand} />}
    </div>
  )
}
