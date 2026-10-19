import type { AgentSummary, PetActivity, PetPack } from '@score/contract'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { AgentGlyph, type AgentActivity } from '../../../components/AgentGlyph.tsx'
import { StillFrame } from '../../../components/PetAvatar.tsx'
import { packActivities, petPackUrl } from '../../../components/pet-pack.ts'
import { useLiveliness } from '../../../data/liveliness.ts'
import { useMediaQuery } from '../../../data/use-media.ts'
import type { Handoff, StageMood } from './stage-mood.ts'
import { moodText } from './stage-mood.ts'
import {
  initialPositions,
  petView,
  pickBreak,
  pickTarget,
  restingMotion,
  shownMembers,
  stepToward,
  type BreakFile,
  type Motion,
  type StageOverlay,
  type Walker,
} from './stage-motion.ts'
import { subscribeFrame } from './stage-ticker.ts'
import './room-stage.css'

export type StageMember = { agent: AgentSummary; mood: StageMood }

type Props = {
  roomId: string
  members: StageMember[]
  /** The two members handing over right now, who face each other. */
  handoff: Handoff | null
  onMention: (agentId: string) => void
}

/** On a phone the strip is short: this many members, then a "+N" chip. */
const PHONE_LIMIT = 5
const PHONE_QUERY = '(width < 560px)'
const SAY_MS = 1200

type Facing = 1 | -1
/** Where a member is and what it is doing between moods; moved by the shared frame loop, not by React. */
type Actor = Walker & {
  mode: Motion['mode']
  file?: BreakFile
  until: number
  facing: Facing
}
type Look = { mode: Motion['mode']; file?: BreakFile; facing: Facing }

const markActivity: Record<StageMood, AgentActivity> = {
  rest: 'idle',
  sleep: 'idle',
  think: 'thinking',
  work: 'working',
  needs: 'needs',
}

const rand = (low: number, high: number) => low + Math.random() * (high - low)

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

/** One pet: the pack's files stacked and crossfaded, fetched when first needed, or one still frame under Still. */
function PetFigure({
  agentId,
  pack,
  file,
  still,
  flip,
  hop,
}: {
  agentId: string
  pack: PetPack
  file: PetActivity
  still: boolean
  flip: boolean
  hop: boolean
}) {
  // Files are fetched when they are first needed, then kept so the next crossfade is instant; a new pack is new files.
  const [fetched, setFetched] = useState<ReadonlySet<string>>(() => new Set(['idle', file]))
  const [rev, setRev] = useState(pack.rev)
  if (rev !== pack.rev) {
    setRev(pack.rev)
    setFetched(new Set(['idle', file]))
  } else if (!fetched.has(file)) {
    setFetched(new Set([...fetched, file]))
  }
  const url = (name: string) => petPackUrl(agentId, name as PetActivity, pack.rev)
  return (
    <span
      className={[
        'room-stage__fig',
        'room-stage__move',
        flip && 'room-stage__fig--flip',
        hop && 'room-stage__fig--hop',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ '--stage-floor': pack.floor } as CSSProperties}
    >
      {still ? (
        <StillFrame key={file} url={url(file)} on base="room-stage__anim" />
      ) : (
        [...fetched].map((name) => (
          <img
            key={name}
            className={`room-stage__anim${name === file ? ' room-stage__anim--on' : ''}`}
            data-anim={name}
            src={url(name)}
            alt=""
            draggable={false}
          />
        ))
      )}
    </span>
  )
}

function Overlay({ kind }: { kind: StageOverlay | null }) {
  if (kind === 'bang') return <Bang />
  if (kind === 'dots') return <Dots />
  if (kind === 'zzz') return <Zzz />
  return null
}

/**
 * The strip under a chat room's title (PLAN 10.10, decision 110): its members as pets (a pack agent plays its files,
 * with its mark as a badge) and marks, showing what is going on in the room. Resting members wander and take breaks
 * under Lively, one shared frame loop moves them; Calm only follows moods; Still and reduced motion show first frames.
 * Click a member to mention it.
 */
export function RoomStageView({ roomId, members, handoff, onMention }: Props) {
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
  const actors = useRef(new Map<string, Actor>())
  const latest = useRef({ shown, liveliness })
  const pair = useRef<{ a: string; b: string } | null>(null)
  const [look, setLook] = useState<Record<string, Look>>({})
  const [saying, setSaying] = useState<{ id: string; left: boolean } | null>(null)
  const [inView, setInView] = useState(true)

  useEffect(() => {
    latest.current = { shown, liveliness }
  })

  const commit = useCallback((id: string) => {
    const actor = actors.current.get(id)
    if (!actor) return
    setLook((previous) => {
      const before = previous[id]
      if (
        before &&
        before.mode === actor.mode &&
        before.file === actor.file &&
        before.facing === actor.facing
      )
        return previous
      return { ...previous, [id]: { mode: actor.mode, file: actor.file, facing: actor.facing } }
    })
  }, [])

  // Members that came get a place on the strip, members that left lose theirs; positions are percentages, so a resize
  // needs no work.
  useLayoutEffect(() => {
    const ids = new Set(shown.map((item) => item.agent.id))
    for (const id of [...actors.current.keys()]) if (!ids.has(id)) actors.current.delete(id)
    const spots = initialPositions(shown.length)
    const now = performance.now()
    shown.forEach((item, index) => {
      const id = item.agent.id
      if (!actors.current.has(id)) {
        const x = spots[index]!
        actors.current.set(id, {
          id,
          x,
          target: x,
          pet: Boolean(item.agent.style.pack),
          mode: 'idle',
          until: now + rand(3000, 8000),
          facing: 1,
        })
      }
      const actor = actors.current.get(id)!
      actor.pet = Boolean(item.agent.style.pack)
      const slot = slots.current.get(id)
      if (slot) slot.style.left = `${actor.x * 100}%`
    })
    setLook((previous) => {
      const next: Record<string, Look> = {}
      for (const [id, actor] of actors.current)
        next[id] = previous[id] ?? { mode: actor.mode, facing: actor.facing }
      return next
    })
  }, [shown])

  // A new mood ends whatever the member was doing and starts its resting clock again.
  const moodKey = shown.map((item) => `${item.agent.id}:${item.mood}`).join('|')
  useLayoutEffect(() => {
    const now = performance.now()
    for (const actor of actors.current.values()) {
      actor.mode = 'idle'
      actor.file = undefined
      actor.target = actor.x
      actor.until = now + rand(2500, 5000)
      commit(actor.id)
    }
  }, [moodKey, commit])

  // A hand-off: both stop and face each other.
  const handoffKey = handoff ? `${handoff.from}>${handoff.to}` : ''
  useLayoutEffect(() => {
    pair.current = null
    if (!handoff) return
    const from = actors.current.get(handoff.from)
    const to = actors.current.get(handoff.to)
    if (!from || !to) return
    for (const [actor, other] of [
      [from, to],
      [to, from],
    ] as const) {
      actor.mode = 'idle'
      actor.file = undefined
      actor.target = actor.x
      actor.facing = other.x >= actor.x ? 1 : -1
      commit(actor.id)
    }
    pair.current = { a: from.id, b: to.id }
    // The pair is identified by the key; the object changes on every message.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoffKey, commit])

  // Calm and Still never wander: a stroll or a break in progress ends where it stands.
  useLayoutEffect(() => {
    if (liveliness === 'lively') return
    for (const actor of actors.current.values()) {
      if (actor.mode === 'idle') continue
      actor.mode = 'idle'
      actor.file = undefined
      actor.target = actor.x
      commit(actor.id)
    }
  }, [liveliness, commit])

  // Pause everything while the stage is scrolled out of view (and the shared loop pauses with the tab).
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

  const anyResting = shown.some((item) => item.mood === 'rest')
  const walks = liveliness === 'lively'
  useEffect(() => {
    if (!walks || !inView || !anyResting) return undefined
    return subscribeFrame((now, seconds) => {
      const width = root.current?.clientWidth ?? 0
      if (width <= 0) return
      const { shown: current, liveliness: mood } = latest.current
      const all = [...actors.current.values()]
      for (const item of current) {
        const actor = actors.current.get(item.agent.id)
        if (!actor || !restingMotion(mood, item.mood, actor.pet).walks) continue
        const holding = pair.current
        if (holding && (holding.a === actor.id || holding.b === actor.id)) continue
        if (actor.mode === 'walk') {
          const step = stepToward(actor.x, actor.target, seconds, width)
          actor.x = step.x
          const slot = slots.current.get(actor.id)
          if (slot) slot.style.left = `${actor.x * 100}%`
          if (step.arrived) {
            actor.mode = 'idle'
            actor.until = now + rand(3000, 8000)
            commit(actor.id)
          }
        } else if (now > actor.until) {
          if (actor.mode === 'break') {
            actor.mode = 'idle'
            actor.file = undefined
            actor.until = now + rand(3000, 7000)
            commit(actor.id)
          } else if (Math.random() < 0.7) {
            // Keep clear of where the others stand and where they are going.
            const target = pickTarget(actor, all, width, Math.random)
            if (target === null) actor.until = now + rand(2000, 4000)
            else {
              actor.target = target
              actor.facing = target > actor.x ? 1 : -1
              actor.mode = 'walk'
              commit(actor.id)
            }
          } else {
            const file = restingMotion(mood, item.mood, actor.pet).breaks
              ? pickBreak(packActivities(item.agent.style.pack ?? { activities: [] }), Math.random)
              : null
            if (file) {
              actor.mode = 'break'
              actor.file = file
              actor.until = now + rand(4000, 7000)
              commit(actor.id)
            } else actor.until = now + rand(2000, 5000)
          }
        }
      }
    })
  }, [walks, inView, anyResting, commit])

  const sayTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(sayTimer.current), [])
  const mention = (id: string) => {
    onMention(id)
    const actor = actors.current.get(id)
    setSaying({ id, left: (actor?.x ?? 0) > 0.7 })
    clearTimeout(sayTimer.current)
    sayTimer.current = setTimeout(() => setSaying(null), SAY_MS)
  }

  const still = liveliness === 'still'
  return (
    <div
      ref={root}
      className="room-stage"
      role="group"
      aria-label="Room members"
      data-protected="any"
      data-room={roomId}
      data-liveliness={liveliness}
    >
      <div className="room-stage__strip">
        {shown.map(({ agent, mood }) => {
          const id = agent.id
          const state = look[id] ?? { mode: 'idle' as const, facing: 1 as Facing }
          const pack = agent.style.pack ?? null
          const view = pack
            ? petView(mood, state, packActivities(pack))
            : { file: 'idle' as PetActivity, overlay: mood === 'needs' ? ('bang' as const) : null }
          const needs = mood === 'needs'
          const hops = pack ? needs : needs || state.mode === 'walk'
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
                aria-label={`${agent.name}, ${moodText(mood)}`}
                data-agent={id}
                data-mood={mood}
                data-mode={state.mode}
                data-facing={state.facing < 0 ? 'left' : 'right'}
                data-front={needs ? 'true' : undefined}
                data-file={pack ? view.file : undefined}
                style={{ '--stage-color': agent.style.color } as CSSProperties}
                onClick={() => mention(id)}
              >
                <span className="room-stage__body room-stage__move">
                  {pack ? (
                    <>
                      <PetFigure
                        agentId={id}
                        pack={pack}
                        file={view.file}
                        still={still}
                        flip={state.facing < 0}
                        hop={hops}
                      />
                      <span className="room-stage__badge">
                        <AgentGlyph agent={agent} size="sm" decorative mark />
                      </span>
                    </>
                  ) : (
                    <span
                      className={`room-stage__mark room-stage__move${hops ? ' room-stage__mark--hop' : ''}`}
                    >
                      <AgentGlyph
                        agent={agent}
                        size="lg"
                        bare
                        decorative
                        activity={markActivity[mood]}
                      />
                    </span>
                  )}
                  <span className="room-stage__shadow" />
                  <Overlay kind={view.overlay} />
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
