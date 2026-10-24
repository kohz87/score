import type { AgentSummary } from '@score/contract'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { AgentGlyph } from '../../../components/AgentGlyph.tsx'
import { useLiveliness } from '../../../data/liveliness.ts'
import { useMediaQuery } from '../../../data/use-media.ts'
import type { Handoff, StageMood } from './stage-mood.ts'
import { moodText } from './stage-mood.ts'
import {
  initialPositions,
  placeNewcomer,
  shownMembers,
  type StageOverlay,
  type Walker,
} from './stage-motion.ts'
import './room-stage.css'

export type StageMember = { agent: AgentSummary; mood: StageMood }

type Props = {
  roomId: string
  members: StageMember[]
  /** The two members handing over right now, who face each other. */
  handoff: Handoff | null
  onMention: (agentId: string) => void
  /** Nothing has happened in the room for a while: resting members nap (not under Still). */
  quiet?: boolean
}

/** On a phone the strip is short: this many members, then a "+N" chip. */
const PHONE_LIMIT = 5
const PHONE_QUERY = '(width < 560px)'
const SAY_MS = 1200

function Bang() {
  return (
    <svg className="room-stage__fx room-stage__bang" viewBox="0 0 22 22" aria-hidden="true">
      <rect x="0" y="0" width="22" height="22" rx="11" fill="#12131a" />
      <text x="11" y="16" textAnchor="middle" fill="#ffffff" fontSize="14" fontWeight="700">
        !
      </text>
    </svg>
  )
}

function Dots() {
  return (
    <svg className="room-stage__fx room-stage__dots" viewBox="0 0 30 12" aria-hidden="true">
      {[5, 15, 25].map((cx, index) => (
        <circle
          key={cx}
          className="room-stage__dot"
          cx={cx}
          cy="7"
          r="3.2"
          style={{ animationDelay: `${index * 0.15}s` }}
        />
      ))}
    </svg>
  )
}

function Zzz() {
  return (
    <svg className="room-stage__fx room-stage__zzz" viewBox="0 0 30 30" aria-hidden="true">
      {[0, 1, 2].map((n) => (
        <text
          key={n}
          className="room-stage__z"
          x={4 + n * 4}
          y={24 - n * 3}
          style={{ animationDelay: `${n * 0.9}s` }}
        >
          z
        </text>
      ))}
    </svg>
  )
}

function Say({ left }: { left: boolean }) {
  return (
    <svg
      className={`room-stage__fx room-stage__say${left ? ' room-stage__say--left' : ''}`}
      viewBox="0 0 44 22"
      aria-hidden="true"
    >
      <rect x="0" y="0" width="44" height="20" rx="10" fill="#12131a" />
      <text x="22" y="14" textAnchor="middle" fill="#ffffff" fontSize="11" fontWeight="600">
        hi!
      </text>
    </svg>
  )
}

function Overlay({ kind }: { kind: StageOverlay | null }) {
  if (kind === 'bang') return <Bang />
  if (kind === 'dots') return <Dots />
  if (kind === 'zzz') return <Zzz />
  return null
}

/**
 * The strip under a chat room's title: its members as marks, showing what is going on in the room. Click a member to
 * mention it.
 */
export function RoomStageView({ roomId, members, handoff, onMention, quiet = false }: Props) {
  const liveliness = useLiveliness()
  const phone = useMediaQuery(PHONE_QUERY)
  const shown = useMemo(
    () => (phone ? shownMembers(members, PHONE_LIMIT) : members),
    [phone, members],
  )
  const hiddenCount = members.length - shown.length
  const [listed, setListed] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const slots = useRef(new Map<string, HTMLElement>())
  const actors = useRef(new Map<string, Walker>())
  const [saying, setSaying] = useState<{ id: string; left: boolean } | null>(null)
  const [inView, setInView] = useState(true)

  // Members that came get a place on the strip, members that left lose theirs; positions are percentages, so a resize
  // needs no work.
  useLayoutEffect(() => {
    const ids = new Set(shown.map((item) => item.agent.id))
    for (const id of [...actors.current.keys()]) if (!ids.has(id)) actors.current.delete(id)
    const spots = initialPositions(shown.length)
    // The first members spread over the strip; later ones stand where nobody is.
    const first = actors.current.size === 0
    shown.forEach((item, index) => {
      const id = item.agent.id
      if (!actors.current.has(id)) {
        const x = first ? spots[index]! : placeNewcomer(spots[index]!, [...actors.current.values()])
        actors.current.set(id, { id, x, target: x })
      }
      const slot = slots.current.get(id)
      if (slot) slot.style.left = `${actors.current.get(id)!.x * 100}%`
    })
  }, [shown])

  // Pause everything while the stage is scrolled out of view.
  useEffect(() => {
    const node = root.current
    if (!node || typeof IntersectionObserver === 'undefined') return undefined
    const observer = new IntersectionObserver((entries) => {
      const last = entries.at(-1)
      if (last) setInView(last.isIntersecting)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const sayTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(sayTimer.current), [])
  const still = liveliness === 'still'
  const mention = (id: string) => {
    onMention(id)
    clearTimeout(sayTimer.current)
    const actor = actors.current.get(id)
    setSaying({ id, left: (actor?.x ?? 0) > 0.7 })
    sayTimer.current = setTimeout(() => setSaying(null), SAY_MS)
  }
  const napping = quiet && !still
  // In a hand-off the two face each other (members stand in the order they are listed).
  const facing = (id: string): 'left' | 'right' => {
    if (!handoff || (id !== handoff.from && id !== handoff.to)) return 'right'
    const otherId = id === handoff.from ? handoff.to : handoff.from
    return shown.findIndex((item) => item.agent.id === otherId) <
      shown.findIndex((item) => item.agent.id === id)
      ? 'left'
      : 'right'
  }
  return (
    <div
      ref={root}
      className={`room-stage${inView ? '' : ' room-stage--paused'}`}
      role="group"
      aria-label="Room members"
      data-protected="any"
      data-room={roomId}
      data-liveliness={liveliness}
    >
      <div className="room-stage__strip">
        {shown.map(({ agent, mood: actual }) => {
          const id = agent.id
          // A quiet room sends its resting members to sleep; what they are told (the label) stays "resting".
          const mood: StageMood = napping && actual === 'rest' ? 'sleep' : actual
          const overlay: StageOverlay | null =
            mood === 'needs' ? 'bang' : mood === 'sleep' ? 'zzz' : mood === 'think' ? 'dots' : null
          const needs = mood === 'needs'
          return (
            <span
              key={id}
              className="room-stage__slot"
              data-front={needs ? 'true' : undefined}
              ref={(node) => {
                if (node) slots.current.set(id, node)
                else slots.current.delete(id)
              }}
            >
              <button
                type="button"
                className="room-stage__actor"
                title={`Mention @${id}`}
                aria-label={`${agent.name}, ${moodText(actual)}`}
                data-agent={id}
                data-mood={actual}
                data-quiet={mood !== actual ? 'true' : undefined}
                data-mode="idle"
                data-facing={facing(id)}
                data-front={needs ? 'true' : undefined}
                style={{ '--stage-color': agent.style.color } as CSSProperties}
                onClick={() => mention(id)}
              >
                <span className="room-stage__body room-stage__move">
                  <span
                    className={`room-stage__mark room-stage__move${needs ? ' room-stage__mark--hop' : ''}`}
                  >
                    <AgentGlyph agent={agent} size="lg" bare decorative />
                  </span>
                  <span className="room-stage__shadow" />
                  <Overlay kind={overlay} />
                  {saying?.id === id && <Say left={saying.left} />}
                  <span className="room-stage__name">{agent.name}</span>
                </span>
              </button>
            </span>
          )
        })}
        {hiddenCount > 0 && (
          <button
            type="button"
            className="room-stage__more"
            aria-expanded={listed}
            aria-label={`${hiddenCount} more members`}
            onClick={() => setListed((open) => !open)}
          >
            +{hiddenCount}
          </button>
        )}
      </div>
      {hiddenCount > 0 && listed && (
        <ul className="room-stage__members" aria-label="All members">
          {members.map(({ agent, mood }) => (
            <li key={agent.id}>
              <button
                type="button"
                className="room-stage__member"
                onClick={() => mention(agent.id)}
                title={`Mention @${agent.id}`}
              >
                <AgentGlyph agent={agent} size="xs" bare decorative />
                {agent.name}
                <small>{moodText(mood)}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
