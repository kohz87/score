import { useEffect, useRef, useState } from 'react'
import {
  clockSeconds,
  groupActivity,
  markerLabels,
  type ActivityItem,
} from '../routes/watch/watch-model.ts'

const INITIAL_STEPS = 5

/** The step list: newest first, the five newest until "Full history", a sub-agent's steps grouped, one bounded scroll. */
export function StepList({
  items,
  currentKey,
  live,
  targets,
  onSelect,
}: {
  items: ActivityItem[]
  currentKey: string | null
  live: boolean
  targets: (item: ActivityItem) => number
  onSelect: (item: ActivityItem) => void
}) {
  const [all, setAll] = useState(false)
  const entries = groupActivity(items)
  const holdsCurrent = (entry: (typeof entries)[number]) =>
    entry.type === 'item'
      ? entry.item.key === currentKey
      : entry.items.some((i) => i.key === currentKey)
  // A replayed step that fell outside the five newest opens the whole history, so the current step is always on screen.
  const currentHidden = entries.slice(INITIAL_STEPS).some(holdsCurrent)
  const expanded = all || currentHidden
  const shown = expanded ? entries : entries.slice(0, INITIAL_STEPS)
  const list = useRef<HTMLOListElement>(null)
  // While replaying, the replayed step is kept in view inside the list (never the page). Live, the newest step is
  // already first, so a reader scrolled down the history is left where they are.
  useEffect(() => {
    if (live) return
    const box = list.current
    const current = box?.querySelector<HTMLElement>('[aria-current="true"]')
    if (!box || !current) return
    const top =
      current.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop
    if (top < box.scrollTop || top + current.offsetHeight > box.scrollTop + box.clientHeight)
      box.scrollTop = Math.max(0, top - 8)
  }, [currentKey, expanded, live])
  const row = (item: ActivityItem) => {
    const current = item.key === currentKey
    return (
      <li key={item.key}>
        <button
          type="button"
          className={`bold-screen-step${current ? ' sel' : ''}`}
          aria-current={current ? 'true' : undefined}
          disabled={targets(item) < 0}
          onClick={() => onSelect(item)}
        >
          <span
            className={`bold-screen-dot watch-marker--${item.kind}`}
            role="img"
            aria-label={markerLabels[item.kind]}
          />
          <time className="mono bold-screen-time" dateTime={item.at}>
            {live && item === items[0] ? 'now' : clockSeconds(item.at)}
          </time>
          <span>{item.text}</span>
        </button>
      </li>
    )
  }
  return (
    <>
      <ol ref={list} className="bold-screen-steps">
        {shown.map((entry) =>
          entry.type === 'item' ? (
            row(entry.item)
          ) : (
            <li key={entry.key} className="bold-screen-group">
              <span className="bold-screen-sub">
                Sub-agent · {entry.items.length} {entry.items.length === 1 ? 'step' : 'steps'}
              </span>
              <ol
                className="bold-screen-steps bold-screen-steps--nested"
                aria-label="Sub-agent steps"
              >
                {entry.items.map(row)}
              </ol>
            </li>
          ),
        )}
      </ol>
      {entries.length > INITIAL_STEPS && (
        <button
          type="button"
          className="bold-screen-more"
          aria-expanded={expanded}
          disabled={currentHidden && !all}
          onClick={() => setAll(!all)}
        >
          {expanded ? 'Show less' : 'Full history'}
        </button>
      )}
    </>
  )
}
