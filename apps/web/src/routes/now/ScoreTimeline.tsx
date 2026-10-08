import type { NowSnapshot } from '@score/contract'
import type { CSSProperties } from 'react'
import { useNavigate } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import {
  axisTicks,
  clockLabel,
  connectorLabel,
  connectors,
  layoutBlock,
  LANE_HEIGHT,
  percent,
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

export function ScoreTimeline({ snapshot }: { snapshot: NowSnapshot }) {
  const navigate = useNavigate()
  const window = windowOf(snapshot.now)
  const links = connectors(snapshot, window)
  const height = Math.max(snapshot.lanes.length, 1) * LANE_HEIGHT
  const nowLeft = percent(window, window.now)
  const planner = snapshot.lanes[0]?.agent
  return (
    <section className="now-score" aria-label="Score: who is doing what, over time">
      <div className="now-score-scroll">
        <div className="now-score-grid">
          <div className="now-lane-labels">
            <div className="now-axis-spacer" />
            {snapshot.lanes.map(({ agent }) => (
              <div key={agent.id} className="now-lane-label">
                <AgentGlyph agent={agent} size="lg" />
                <div className="now-lane-name">
                  <span className="now-lane-title">
                    {agent.name}
                    {agent.status === 'working' && (
                      <span
                        className="now-lane-dot"
                        style={{ background: agent.style.color }}
                        role="img"
                        aria-label="working"
                      />
                    )}
                  </span>
                  <span className="now-lane-role">{agent.role}</span>
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
            <div className="now-plot" data-testid="score-plot" style={{ height }}>
              <div className="now-future" style={{ left: `${nowLeft}%` }} />
              {snapshot.lanes.map((_, index) => (
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
              {snapshot.lanes.map(({ agent, blocks }, index) => (
                <div
                  key={agent.id}
                  className="now-lane"
                  role="group"
                  aria-label={`${agent.name}, ${agent.role}`}
                  style={
                    { top: index * LANE_HEIGHT, '--agent': agent.style.color } as CSSProperties
                  }
                >
                  {blocks.map((block) => {
                    const layout = layoutBlock(window, block)
                    const style: CSSProperties = { left: `${layout.left}%` }
                    if (layout.width !== null) style.width = `${layout.width}%`
                    const taskId = block.taskId
                    return (
                      <button
                        key={block.id}
                        type="button"
                        className={`now-block now-block--${block.state}`}
                        style={style}
                        aria-label={`${agent.name}: ${block.label}, ${stateText[block.state]}, ${clockLabel(Date.parse(block.start))}`}
                        aria-disabled={taskId === null ? true : undefined}
                        title={block.label}
                        onClick={() => {
                          if (taskId !== null) void navigate(`/tasks/${encodeURIComponent(taskId)}`)
                        }}
                      >
                        {block.state === 'working' && (
                          <span className="now-block-dot" aria-hidden="true" />
                        )}
                        {block.state === 'waiting' && <Shield />}
                        <span className="now-block-label">{block.label}</span>
                      </button>
                    )
                  })}
                </div>
              ))}
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
