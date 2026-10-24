import type { AgentSummary } from '@score/contract'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { useStreamQuery } from '../data/query-client.ts'
import { useMediaQuery } from '../data/use-media.ts'
import { agentsQuery } from '../routes/chat/queries.ts'
import { agentNameColor, agentStateLabel } from './bold-agents.ts'
import { BookIcon, ChevronIcon, GridIcon, PlusIcon, ThreadIcon } from './BoldIcons.tsx'
import { useStartJob } from './BoldStartJob.tsx'

const PHONE = '(max-width: 860px)'

type SideMode = 'work' | 'library' | 'thread' | `agent:${string}`

function sideCopy(mode: SideMode, agent: AgentSummary | undefined): string {
  if (mode === 'work') return 'The Work panel comes in a later task.'
  if (mode === 'library') return 'The Library panel comes in a later task.'
  if (mode === 'thread') return 'The Thread panel comes in a later task.'
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
  const startJob = useStartJob()
  const phone = useMediaQuery(PHONE)
  const [mode, setMode] = useState<SideMode>('work')
  const [menuOpen, setMenuOpen] = useState(false)
  const sideRef = useRef<HTMLElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const agent = mode.startsWith('agent:')
    ? agents.find((item) => item.id === mode.slice(6))
    : undefined
  const label =
    mode === 'work'
      ? 'Work'
      : mode === 'library'
        ? 'Library'
        : mode === 'thread'
          ? 'Thread'
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

  const choose = (next: SideMode) => {
    setMode(next)
    setMenuOpen(false)
    toggleRef.current?.focus()
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

  return (
    <div className="roomgrid">
      <section className="roomcol" aria-label="Team room">
        <div className="roomhead">
          <button className="roomtitle" type="button">
            Team room
            <ChevronIcon />
          </button>
          <button
            type="button"
            className="chip room-start"
            aria-label="Start a job"
            onClick={() => startJob?.openStartJob()}
          >
            <PlusIcon />
            Job
          </button>
        </div>
        <div className="stream" aria-live="polite">
          <p className="room-placeholder">The team room comes in 11.4.</p>
        </div>
      </section>

      {!phone && (
        <div className="bold-sidecol">
          <aside className="side" ref={sideRef} aria-label="Side panel">
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
                ) : agent ? (
                  <SideGlyph agent={agent} />
                ) : null}
                {label}
                <ChevronIcon />
              </button>
              {agent && (
                <span className="small muted side-privacy">Only you and {agent.id} see this</span>
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
            <div className="sidebody" data-placeholder={mode}>
              <p className="side-placeholder">{sideCopy(mode, agent)}</p>
              {agent && (
                <span className="side-agent-name" style={{ color: agentNameColor(agent) }}>
                  {agent.id}
                </span>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}
