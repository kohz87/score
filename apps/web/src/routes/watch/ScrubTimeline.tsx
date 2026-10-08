import type { AgentSummary, WatchMarker } from '@score/contract'
import { useEffect, useMemo, useRef, type KeyboardEvent, type PointerEvent } from 'react'
import {
  clockSeconds,
  clock,
  markerKinds,
  markerLabels,
  markerPositions,
  nearestMarker,
} from './watch-model.ts'

export type ScrubTimelineProps = {
  agent: Pick<AgentSummary, 'name'>
  markers: WatchMarker[]
  /** Index into `markers` of the replayed moment; null while live. */
  cursor: number | null
  playing: boolean
  onSelect: (index: number) => void
  onLive: () => void
  onBack: () => void
  onTogglePlay: () => void
}

export function ScrubTimeline({
  agent,
  markers,
  cursor,
  playing,
  onSelect,
  onLive,
  onBack,
  onTogglePlay,
}: ScrubTimelineProps) {
  const positions = useMemo(() => markerPositions(markers), [markers])
  const track = useRef<HTMLDivElement>(null)
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const dragging = useRef(false)
  const live = cursor === null
  const shownIndex = cursor ?? markers.length - 1
  const shown = markers[shownIndex]
  const focusAfter = useRef<number | null>(null)

  useEffect(() => {
    if (focusAfter.current !== null) {
      buttons.current[focusAfter.current]?.focus()
      focusAfter.current = null
    }
  })

  const percentAt = (event: PointerEvent) => {
    const box = track.current?.getBoundingClientRect()
    if (!box || box.width === 0) return null
    return ((event.clientX - box.left) / box.width) * 100
  }
  const scrub = (event: PointerEvent) => {
    const percent = percentAt(event)
    const index = percent === null ? null : nearestMarker(positions, percent)
    if (index !== null) onSelect(index)
  }
  const move = (index: number) => {
    focusAfter.current = index
    onSelect(index)
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (markers.length === 0) return
    if (event.key === 'End') {
      event.preventDefault()
      onLive()
      focusAfter.current = markers.length - 1
    } else if (event.key === 'Home') {
      event.preventDefault()
      move(0)
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault()
      move(Math.max(0, shownIndex - 1))
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault()
      if (live) return
      // Past the last marker is the live edge.
      if (shownIndex >= markers.length - 1) {
        onLive()
        focusAfter.current = markers.length - 1
      } else move(shownIndex + 1)
    }
  }

  return (
    <section className="watch-replay" aria-label="Replay">
      <div className="watch-replay__buttons">
        <button type="button" aria-label="Back 30 seconds" onClick={onBack}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M7.5 3 L3 8 L7.5 13 M13 3 L8.5 8 L13 13"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          type="button"
          aria-label={live || playing ? 'Pause playback' : 'Play'}
          onClick={onTogglePlay}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            {live || playing ? (
              <path
                d="M5.5 3 V13 M10.5 3 V13"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            ) : (
              <path d="M4.5 2.5 L13 8 L4.5 13.5 Z" fill="currentColor" />
            )}
          </svg>
        </button>
      </div>
      <span className="watch-replay__time" aria-live="off">
        {shown ? clock(shown.at) : '--:--'}
      </span>
      <div
        ref={track}
        className="watch-track"
        role="group"
        aria-label="Replay timeline"
        onKeyDown={onKeyDown}
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest('button')) return
          dragging.current = true
          event.currentTarget.setPointerCapture?.(event.pointerId)
          scrub(event)
        }}
        onPointerMove={(event) => {
          if (dragging.current) scrub(event)
        }}
        onPointerUp={() => {
          dragging.current = false
        }}
        onPointerCancel={() => {
          dragging.current = false
        }}
      >
        <span className="watch-track__rail" />
        <span
          className="watch-track__played"
          style={{ width: `${live ? 100 : (positions[shownIndex] ?? 100)}%` }}
        />
        {markers.map((marker, index) => (
          <button
            key={`${marker.seq}-${marker.kind}-${marker.at}`}
            ref={(element) => {
              buttons.current[index] = element
            }}
            type="button"
            className={`watch-marker watch-marker--${marker.kind}${index === cursor ? ' watch-marker--on' : ''}`}
            style={{ left: `${positions[index]}%` }}
            tabIndex={index === shownIndex ? 0 : -1}
            aria-label={`${markerLabels[marker.kind]} at ${clockSeconds(marker.at)}`}
            aria-current={index === cursor ? 'true' : undefined}
            onClick={() => onSelect(index)}
          />
        ))}
      </div>
      <button
        type="button"
        className={`watch-replay__live${live ? ' watch-replay__live--on' : ''}`}
        aria-label="Back to live"
        aria-pressed={live}
        onClick={onLive}
      >
        Live
      </button>
      <div className="watch-replay__legend">
        {markerKinds.map((kind) => (
          <span key={kind} className="watch-legend">
            <span
              className={`watch-legend__swatch watch-legend__swatch--${kind}`}
              aria-hidden="true"
            />
            {markerLabels[kind]}
          </span>
        ))}
        <span className="watch-replay__spacer" />
        <span>
          Drag back to replay anything they did. {agent.name} keeps working while you watch the
          past.
        </span>
      </div>
    </section>
  )
}
