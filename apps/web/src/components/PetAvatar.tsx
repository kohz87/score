import type { AgentStyle, PetPack } from '@score/contract'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react'
import { useLiveliness } from '../data/liveliness.ts'
import { createPetScheduler, type PetView } from '../pets/pet-scheduler.ts'
import { AgentGlyph, type AgentActivity } from './AgentGlyph.tsx'
import { packActivities, petPackUrl } from './pet-pack.ts'
import './pet-avatar.css'

export type PetAvatarProps = {
  agent: { id: string; name: string; style: AgentStyle & { pack: PetPack } }
  /** What the agent is doing, where known; without it the pet rests. */
  activity?: AgentActivity
  decorative?: boolean
  className?: string
}

/** The first frame of a file, drawn once: what Still and reduced motion show instead of the animation. */
function StillFrame({ url, on }: { url: string; on: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const image = new Image()
    let live = true
    image.onload = () => {
      const target = canvas.current
      if (!live || !target || image.naturalWidth === 0) return
      target.width = image.naturalWidth
      target.height = image.naturalHeight
      try {
        target.getContext('2d')?.drawImage(image, 0, 0)
      } catch {
        // Nothing to draw; the badge still shows the agent.
      }
    }
    image.src = url
    return () => {
      live = false
      image.onload = null
    }
  }, [url])
  return (
    <canvas ref={canvas} className={`pet-anim${on ? ' pet-anim--on' : ''}`} aria-hidden="true" />
  )
}

function Dots() {
  return (
    <svg className="pet-fx pet-dots" viewBox="0 0 30 14" aria-hidden="true">
      {[
        [5, 10, 2.6],
        [14, 8, 3.4],
        [24, 5.5, 4.2],
      ].map(([cx, cy, r]) => (
        <circle key={cx} className="pet-dot" cx={cx} cy={cy} r={r} />
      ))}
    </svg>
  )
}

function Alert() {
  return (
    <svg className="pet-fx pet-alert" viewBox="0 0 26 26" aria-hidden="true">
      <rect className="pet-alert-bg" x="0" y="0" width="26" height="26" rx="9" />
      <text className="pet-alert-text" x="13" y="19.5">
        !
      </text>
    </svg>
  )
}

function Zzz() {
  return (
    <svg className="pet-fx pet-zzz" viewBox="0 0 30 30" aria-hidden="true">
      {[0, 1, 2].map((n) => (
        <text
          key={n}
          className="pet-z"
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

function Say() {
  return (
    <svg className="pet-fx pet-say" viewBox="0 0 44 22" aria-hidden="true">
      <rect className="pet-say-bg" x="0" y="0" width="44" height="18" rx="9" />
      <text className="pet-say-text" x="22" y="13">
        hi!
      </text>
    </svg>
  )
}

function Heart() {
  return (
    <svg className="pet-fx pet-heart" viewBox="0 0 20 20" aria-hidden="true">
      <path
        className="pet-heart-shape"
        d="M10 16.6 C4 12.6 2.5 9.6 3.6 7.1 C4.8 4.4 8.4 4.2 10 6.8 C11.6 4.2 15.2 4.4 16.4 7.1 C17.5 9.6 16 12.6 10 16.6 Z"
      />
    </svg>
  )
}

/**
 * An agent wearing its pet pack (decisions 107–108): one animated file per activity, crossfaded as the mood changes,
 * with Score's own overlays for the moods the pack has no file for, a greeting when you point at it, a bounce or a heart
 * when you click it, and the agent's mark as a small badge. Standing on a floor, scaled by height. Still and reduced
 * motion show a still first frame.
 */
export function PetAvatar({
  agent,
  activity = 'idle',
  decorative = false,
  className,
}: PetAvatarProps) {
  const { pack } = agent.style
  const liveliness = useLiveliness()
  const activities = useMemo(() => packActivities(pack), [pack])
  const [pet] = useState(() => createPetScheduler({ mood: activity, liveliness, activities }))
  const view: PetView = useSyncExternalStore(pet.subscribe, pet.getSnapshot, pet.getSnapshot)
  useEffect(() => {
    pet.start()
    return () => pet.destroy()
  }, [pet])
  useEffect(() => pet.setMood(activity), [pet, activity])
  useEffect(() => pet.setLiveliness(liveliness), [pet, liveliness])
  useEffect(() => pet.setActivities(activities), [pet, activities])
  useEffect(() => {
    const onVisibility = () => pet.setHidden(document.visibilityState === 'hidden')
    onVisibility()
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [pet])
  // Files are fetched when they are first needed, then kept so the next crossfade is instant.
  const [fetched, setFetched] = useState<ReadonlySet<string>>(() => new Set(['idle', view.file]))
  const shown = fetched.has(view.file) ? fetched : new Set([...fetched, view.file])
  useEffect(() => {
    if (!fetched.has(view.file)) setFetched(shown)
  }, [view.file, fetched, shown])
  // A new pack is new files.
  const rev = useRef(pack.rev)
  useEffect(() => {
    if (rev.current === pack.rev) return
    rev.current = pack.rev
    setFetched(new Set(['idle', view.file]))
  }, [pack.rev, view.file])

  const still = liveliness === 'still'
  const style = {
    '--pet-color': agent.style.color,
    '--pet-floor': pack.floor,
  } as CSSProperties
  const accessibility = decorative
    ? { 'aria-hidden': true as const }
    : { role: 'img', 'aria-label': agent.name }
  const url = (file: string) => petPackUrl(agent.id, file as never, pack.rev)

  return (
    <div
      {...accessibility}
      data-protected="any"
      className={['pet-avatar', still && 'pet-avatar--still', className].filter(Boolean).join(' ')}
      style={style}
      data-file={view.file}
      onPointerEnter={() => pet.pointerEnter()}
      onClick={() => pet.click()}
    >
      <div className="pet-floor" />
      <div
        className={[
          'pet-stage',
          view.hop && 'pet-stage--hop',
          view.love && `pet-stage--love pet-stage--love-${view.hearts % 2}`,
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {still ? (
          <StillFrame key={view.file} url={url(view.file)} on />
        ) : (
          [...shown].map((file) => (
            <img
              key={file}
              className={`pet-anim${file === view.file ? ' pet-anim--on' : ''}`}
              data-anim={file}
              src={url(file)}
              alt=""
              draggable={false}
            />
          ))
        )}
      </div>
      <span className="pet-badge">
        <AgentGlyph agent={agent} size="sm" decorative />
      </span>
      {view.overlay === 'dots' && <Dots />}
      {view.overlay === 'alert' && <Alert />}
      {view.overlay === 'zzz' && <Zzz />}
      {view.saying && <Say />}
      {view.love && <Heart key={view.hearts} />}
    </div>
  )
}
