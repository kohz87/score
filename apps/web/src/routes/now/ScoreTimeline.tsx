import type { AgentSummary, LaneBlock, NowSnapshot } from '@score/contract'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { PopOutButton } from '../pop/PopOutButton.tsx'
import { Link, useNavigate } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { UnattributedGlyph } from '../../components/UnattributedGlyph.tsx'
import {
  axisTicks,
  clockLabel,
  connectorLabel,
  connectors,
  laneItems,
  LANE_HEIGHT,
  percent,
  UNATTRIBUTED_NAME,
  windowOf,
} from './timeline-model.ts'

const stateText = {
  done: 'done',
  working: 'working now',
  planned: 'planned',
  waiting: 'waiting on you',
} as const

function Shield() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 1.5 L13.5 3.5 V8 C13.5 11 11 13.3 8 14.5 C5 13.3 2.5 11 2.5 8 V3.5 Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** The plot's width in pixels, for grouping blocks that would be too narrow to read. */
function usePlotWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(1000)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const next = element.getBoundingClientRect().width
      if (next > 0) setWidth(Math.round(next))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}

/** Where a click on a block goes: its task when it is on the current board, an attempt of an earlier board its own page. */
function blockPath(block: LaneBlock): string | null {
  if (block.taskId !== null) return `/tasks/${encodeURIComponent(block.taskId)}`
  if (block.attemptId) return `/attempts/${encodeURIComponent(block.attemptId)}`
  return null
}

/** What the person is told beyond the label: attempt facts that a color or an outline cannot carry. */
function blockNotes(block: LaneBlock): string[] {
  const notes: string[] = []
  if (block.observationEndedAt)
    notes.push(`no longer observed since ${clockLabel(Date.parse(block.observationEndedAt))}`)
  if (block.provenance === 'partial') notes.push('provenance unknown')
  return notes
}

type LaneOwner = { key: string; name: string; role: string | null; agent: AgentSummary | null }

/** A group of crowded task blocks: one counted block that opens a small list (Escape or a click elsewhere closes it). */
function BlockGroup({
  owner,
  blocks,
  state,
  style,
  open,
  onToggle,
  onClose,
}: {
  owner: LaneOwner
  blocks: LaneBlock[]
  state: LaneBlock['state']
  style: CSSProperties
  open: boolean
  onToggle: () => void
  onClose: () => void
}) {
  const navigate = useNavigate()
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) onClose()
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open, onClose])
  const label = `${blocks.length} tasks`
  return (
    <div
      ref={root}
      className="now-group"
      style={style}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation()
          onClose()
          root.current?.querySelector('button')?.focus()
        }
      }}
    >
      <button
        type="button"
        className={`now-block now-block--${state} now-block--group`}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={`${owner.name}: ${label}, ${stateText[state]}. Show the list`}
        title={label}
        onClick={onToggle}
      >
        <span className="now-block-label">{label}</span>
      </button>
      {open && (
        <ul className="now-group-list" aria-label={`${owner.name}: ${label}`}>
          {blocks.map((block) => (
            <li key={block.id}>
              <button
                type="button"
                className="now-group-item"
                disabled={blockPath(block) === null}
                onClick={() => {
                  const path = blockPath(block)
                  if (path !== null) void navigate(path)
                }}
              >
                {owner.agent ? (
                  <AgentGlyph agent={owner.agent} size="xs" bare decorative />
                ) : (
                  <UnattributedGlyph size="xs" decorative />
                )}
                <span className="now-group-title">{block.label}</span>
                <span className="now-group-meta">
                  {[
                    block.observationEndedAt ? null : stateText[block.state],
                    clockLabel(Date.parse(block.start)),
                    ...blockNotes(block),
                  ]
                    .filter(Boolean)
                    .join(', ')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function ScoreTimeline({ snapshot }: { snapshot: NowSnapshot }) {
  const navigate = useNavigate()
  const window = windowOf(snapshot.now)
  const [plotRef, plotWidth] = usePlotWidth()
  const [openGroup, setOpenGroup] = useState<string | null>(null)
  const links = connectors(snapshot, window, plotWidth)
  const owners: (LaneOwner & { blocks: LaneBlock[] })[] = snapshot.lanes.map(
    ({ agent, blocks }) => ({ key: agent.id, name: agent.name, role: agent.role, agent, blocks }),
  )
  // Attempts with no known agent: a lane of their own under the agents, never an agent's.
  if (snapshot.unattributed)
    owners.push({
      key: ' unattributed',
      name: UNATTRIBUTED_NAME,
      role: 'No known agent',
      agent: null,
      blocks: snapshot.unattributed.blocks,
    })
  const hasChat = owners.some((lane) => lane.blocks.some((block) => block.kind === 'chat'))
  const hasUnobserved = owners.some((lane) => lane.blocks.some((block) => block.observationEndedAt))
  const height = Math.max(owners.length, 1) * LANE_HEIGHT
  const nowLeft = percent(window, window.now)
  const planner = snapshot.lanes[0]?.agent
  return (
    <section className="now-score" aria-label="Score: who is doing what, over time">
      <div className="now-score-scroll">
        <div className="now-score-grid">
          <div className="now-lane-labels">
            <div className="now-axis-spacer" />
            {owners.map(({ key, agent, name, role }) => (
              <div key={key} className="now-lane-label">
                {agent ? <AgentGlyph agent={agent} size="lg" /> : <UnattributedGlyph />}
                <div className="now-lane-name">
                  <span className="now-lane-title">
                    {agent ? (
                      <Link
                        to={`/now/watch/${encodeURIComponent(agent.id)}`}
                        className="now-lane-link"
                      >
                        {agent.name}
                      </Link>
                    ) : (
                      // Nothing was observed of these attempts' runs, so there is no Watch page to link to.
                      <span>{name}</span>
                    )}
                    {agent && (
                      <PopOutButton
                        agentId={agent.id}
                        agentName={agent.name}
                        className="now-lane-popout"
                      />
                    )}
                    {agent?.status === 'working' && (
                      <span
                        className="now-lane-dot"
                        style={{ background: agent.style.color }}
                        role="img"
                        aria-label="working"
                      />
                    )}
                  </span>
                  <span className="now-lane-role">{role}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="now-plot-col">
            <div className="now-axis" aria-hidden="true">
              {axisTicks(window).map((tick) => (
                <span
                  key={tick.label}
                  className={`now-tick${tick.left > 97 ? ' now-tick--end' : ''}`}
                  style={{ left: `${tick.left}%` }}
                >
                  {tick.label}
                </span>
              ))}
            </div>
            <div className="now-plot" data-testid="score-plot" ref={plotRef} style={{ height }}>
              <div className="now-future" style={{ left: `${nowLeft}%` }} />
              {owners.map((_, index) => (
                <div
                  key={index}
                  className="now-lane-line"
                  style={{ top: index * LANE_HEIGHT + LANE_HEIGHT / 2 - 1 }}
                />
              ))}
              <svg
                className="now-connectors"
                viewBox={`0 0 1000 ${height}`}
                preserveAspectRatio="none"
                fill="none"
                aria-hidden="true"
                style={{ height }}
              >
                {links.map((link) => (
                  <path
                    key={link.id}
                    className={`now-connector now-connector--${link.kind}`}
                    d={link.d}
                  />
                ))}
              </svg>
              {links.map((link) => (
                <span
                  key={link.id}
                  className="now-connector-label"
                  aria-hidden="true"
                  style={{ left: `${link.labelLeft}%`, top: link.labelTop }}
                >
                  {connectorLabel[link.kind]}
                </span>
              ))}
              {owners.map((owner, index) => {
                const { agent, blocks } = owner
                return (
                  <div
                    key={owner.key}
                    className={`now-lane${agent ? '' : ' now-lane--unattributed'}`}
                    role="group"
                    aria-label={`${owner.name}, ${owner.role}`}
                    style={
                      {
                        top: index * LANE_HEIGHT,
                        '--agent': agent ? agent.style.color : 'var(--ink-muted)',
                      } as CSSProperties
                    }
                  >
                    {laneItems(window, blocks, plotWidth).map((item) => {
                      const layout = item.layout
                      const block = layout.block
                      const style: CSSProperties = { left: `${layout.left}%` }
                      if (layout.width !== null) style.width = `${layout.width}%`
                      if (item.kind === 'chat')
                        return (
                          <span
                            key={block.id}
                            className="now-chat-band"
                            style={style}
                            role="img"
                            aria-label={`${owner.name}: ${block.label}, ${clockLabel(Date.parse(block.start))}`}
                            title={block.label}
                          />
                        )
                      if (item.kind === 'group')
                        return (
                          <BlockGroup
                            key={block.id}
                            owner={owner}
                            blocks={item.blocks}
                            state={block.state}
                            style={style}
                            open={openGroup === block.id}
                            onToggle={() => setOpenGroup(openGroup === block.id ? null : block.id)}
                            onClose={() => setOpenGroup(null)}
                          />
                        )
                      const path = blockPath(block)
                      const unobserved = Boolean(block.observationEndedAt)
                      const notes = blockNotes(block)
                      // Observation that stopped is not work in progress and not a finish: no state word for it.
                      const spoken = [
                        `${owner.name}: ${block.label}`,
                        ...(unobserved ? [] : [stateText[block.state]]),
                        clockLabel(Date.parse(block.start)),
                        ...notes,
                      ].join(', ')
                      return (
                        <button
                          key={block.id}
                          type="button"
                          className={`now-block now-block--${unobserved ? 'done' : block.state}${unobserved ? ' now-block--unobserved' : ''}`}
                          style={style}
                          aria-label={spoken}
                          aria-disabled={path === null ? true : undefined}
                          title={
                            notes.length > 0 ? `${block.label} (${notes.join(', ')})` : block.label
                          }
                          onClick={() => {
                            if (path !== null) void navigate(path)
                          }}
                        >
                          {block.state === 'working' && !unobserved && (
                            <span className="now-block-dot" aria-hidden="true" />
                          )}
                          {block.state === 'waiting' && <Shield />}
                          <span className="now-block-label">{block.label}</span>
                        </button>
                      )
                    })}
                  </div>
                )
              })}
              <div className="now-line" style={{ left: `${nowLeft}%` }} aria-hidden="true" />
              <div className="now-line-label" style={{ left: `${nowLeft}%` }}>
                Now, {clockLabel(window.now)}
              </div>
            </div>
          </div>
        </div>
      </div>
      {links.length > 0 && (
        <ul className="now-sr-only" aria-label="Hand-offs">
          {links.map((link) => (
            <li key={link.id}>
              {connectorLabel[link.kind]}: {link.fromAgentId} ({link.fromLabel}) to {link.toAgentId}{' '}
              ({link.toLabel})
            </li>
          ))}
        </ul>
      )}
      <div className="now-legend">
        <span>
          <span className="now-legend-swatch now-legend-swatch--done" />
          Done
        </span>
        <span>
          <span className="now-legend-swatch now-legend-swatch--working" />
          Working now
        </span>
        <span>
          <span className="now-legend-swatch now-legend-swatch--planned" />
          Planned{planner ? ` by ${planner.name}` : ''}
        </span>
        {hasChat && (
          <span>
            <span className="now-legend-swatch now-legend-swatch--chat" />
            Chatting
          </span>
        )}
        {hasUnobserved && (
          <span>
            <span className="now-legend-swatch now-legend-swatch--unobserved" />
            No longer observed
          </span>
        )}
        <span>
          <svg width="22" height="10" viewBox="0 0 22 10" fill="none" aria-hidden="true">
            <path d="M1 2 C 9 2, 13 8, 21 8" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          Hand-off
        </span>
      </div>
    </section>
  )
}
