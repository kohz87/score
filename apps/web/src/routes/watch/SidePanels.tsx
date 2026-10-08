import type { AgentSummary, WatchOverviewItem } from '@score/contract'
import { useState } from 'react'
import { Link } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { clockSeconds, markerLabels, type ActivityItem } from './watch-model.ts'

const INITIAL = 5

export type WhatTheyAreDoingProps = {
  agent: Pick<AgentSummary, 'name'>
  items: ActivityItem[]
  /** The item to highlight: the newest while live, the replayed one while scrubbing. */
  currentKey: string | null
  live: boolean
  onSelect: (item: ActivityItem) => void
}

export function WhatTheyAreDoing({
  agent,
  items,
  currentKey,
  live,
  onSelect,
}: WhatTheyAreDoingProps) {
  const [all, setAll] = useState(false)
  const shown = all ? items : items.slice(0, INITIAL)
  return (
    <section className="watch-panel" aria-labelledby="watch-doing">
      <h2 id="watch-doing">What {agent.name} is doing</h2>
      {items.length === 0 && (
        <p className="watch-panel__empty">Nothing yet. Steps show up here as they happen.</p>
      )}
      <ol className="watch-doing">
        {shown.map((item, index) => {
          const current = item.key === currentKey
          return (
            <li key={item.key}>
              <button
                type="button"
                className={`watch-doing__item${current ? ' watch-doing__item--current' : ''}`}
                aria-current={current ? 'true' : undefined}
                disabled={item.seq === null}
                onClick={() => onSelect(item)}
              >
                <span
                  className={`watch-doing__dot watch-marker--${item.kind}`}
                  role="img"
                  aria-label={markerLabels[item.kind]}
                />
                <span className="watch-doing__body">
                  <span className="watch-doing__text">{item.text}</span>
                  <time className="watch-doing__time" dateTime={item.at}>
                    {clockSeconds(item.at)}
                    {live && index === 0 && current ? ', now' : ''}
                  </time>
                </span>
              </button>
            </li>
          )
        })}
      </ol>
      {items.length > INITIAL && (
        <button
          type="button"
          className="watch-panel__more"
          aria-expanded={all}
          onClick={() => setAll(!all)}
        >
          {all ? 'Show less' : 'Full history'}
        </button>
      )}
    </section>
  )
}

function Miniature({ item }: { item: WatchOverviewItem }) {
  if (item.thumbnail)
    return (
      <img className="watch-mini__img" src={item.thumbnail} alt={`${item.agent.name}'s screen`} />
    )
  if (!item.live && item.surface === null)
    return <span className="watch-mini__empty">No desktop open</span>
  if (item.surface === 'browser')
    return (
      <>
        <span className="watch-mini__page" />
        <span className="watch-mini__line" style={{ left: '12%', top: '30%', width: '40%' }} />
        <span className="watch-mini__line" style={{ left: '12%', top: '44%', width: '28%' }} />
      </>
    )
  return (
    <>
      <span className="watch-mini__window" />
      <span
        className="watch-mini__line watch-mini__line--hot"
        style={{ left: '12%', top: '28%', width: '40%' }}
      />
      <span className="watch-mini__line" style={{ left: '12%', top: '40%', width: '48%' }} />
      <span className="watch-mini__line" style={{ left: '12%', top: '50%', width: '36%' }} />
      {item.surface === 'editor' && <span className="watch-mini__page watch-mini__page--small" />}
    </>
  )
}

export function OtherScreens({
  items,
  currentAgentId,
  failed,
}: {
  items: WatchOverviewItem[] | undefined
  currentAgentId: string
  failed: boolean
}) {
  const others = (items ?? []).filter((item) => item.agent.id !== currentAgentId)
  return (
    <section className="watch-panel" aria-labelledby="watch-others">
      <h2 id="watch-others">Other screens</h2>
      {items === undefined && (
        <p className="watch-panel__empty" role={failed ? 'alert' : 'status'}>
          {failed ? 'Could not load the other screens.' : 'Loading the other screens…'}
        </p>
      )}
      {items && others.length === 0 && (
        <p className="watch-panel__empty">No other agents are on the team yet.</p>
      )}
      <ul className="watch-others">
        {others.map((item) => (
          <li key={item.agent.id}>
            <Link to={`/now/watch/${encodeURIComponent(item.agent.id)}`} className="watch-mini">
              <span className="watch-mini__screen">
                <Miniature item={item} />
              </span>
              <span className="watch-mini__meta">
                <AgentGlyph agent={item.agent} size="xs" decorative />
                <span className="watch-mini__name">{item.agent.name}</span>
                <span className="watch-mini__spacer" />
                {item.live && <span className="watch-mini__live" aria-hidden="true" />}
                <span className="watch-mini__status">{item.status}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
