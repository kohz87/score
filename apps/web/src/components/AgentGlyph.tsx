import type { AgentLook, AgentStyle } from '@score/contract'
import { useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react'
import {
  agentEyes,
  agentShapes,
  botBodies,
  botDetails,
  type AgentShapeElement,
} from './agent-shapes.ts'
import './agent-glyph.css'
import './agent-glyph-motion.css'

/** What an agent is doing right now, where the caller knows it. Without it the glyph rests. */
export type AgentActivity = 'idle' | 'working' | 'thinking' | 'needs'

export type AgentGlyphProps = {
  agent: { id: string; name: string; style: AgentStyle }
  size?: 'xs' | 'sm' | 'md' | 'lg'
  bare?: boolean
  decorative?: boolean
  describeShape?: boolean
  contrast?: 'default' | 'high'
  activity?: AgentActivity
  /** Always the plain coloured shape, whatever the agent's look: for a spot that draws its own tile behind it. */
  plain?: boolean
  /** A passing pose for the pet corner (PLAN 10.2c): asleep (eyes shut) or yawning (eyes squinting, a chibi's mouth open). */
  pose?: AgentPose
}

export type AgentPose = 'sleep' | 'yawn'

const designTints: Record<string, string> = {
  '#6B4EFF': '#ECE8FF',
  '#19C39A': '#DDF6EE',
  '#FFB61E': '#FFF1D1',
  '#FF6B8A': '#FFE3E9',
}

export function agentTint(color: string): string {
  if (!/^#[\da-f]{6}$/i.test(color)) {
    throw new TypeError('Agent color must be a six-digit hex color')
  }
  const designTint = designTints[color.toUpperCase()]
  if (designTint) return designTint
  return `#${[1, 3, 5]
    .map((offset) =>
      Math.round(Number.parseInt(color.slice(offset, offset + 2), 16) * 0.15 + 255 * 0.85)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')
    .toUpperCase()}`
}

/** Where a picture is served from; a new picture is a new revision, so the URL never changes meaning. */
export function agentAvatarUrl(id: string, rev: string): string {
  return `/api/agents/${encodeURIComponent(id)}/avatar?rev=${encodeURIComponent(rev)}`
}

export type GlyphKind = 'plain' | AgentLook | 'picture'

/** List size is always the plain coloured shape; otherwise a picture wins over the look, and `bot` is the default. */
export function glyphKind(
  style: AgentStyle,
  size: 'xs' | 'sm' | 'md' | 'lg',
  pictureFailed = false,
) {
  if (size === 'xs') return 'plain'
  if (style.avatar && !pictureFailed) return 'picture'
  return style.look ?? 'bot'
}

function ShapeElement({ element, className }: { element: AgentShapeElement; className?: string }) {
  const { tag, ...attributes } = element
  const outlined = tag === 'circle' && element.strokeWidth !== undefined
  const cls = className ?? (outlined ? 'agent-glyph__ring' : 'agent-glyph__solid')
  switch (tag) {
    case 'circle':
      return <circle {...attributes} className={cls} />
    case 'rect':
      return <rect {...attributes} className={cls} />
    case 'path':
      return <path {...attributes} className={cls} />
  }
}

function Shape({
  elements,
  className,
}: {
  elements: readonly AgentShapeElement[]
  className?: string
}) {
  return elements.map((element, index) => (
    <ShapeElement key={index} element={element} className={className} />
  ))
}

function Dots({ points }: { points: readonly (readonly [number, number, number])[] }) {
  return (
    <g className="agent-glyph__dots">
      {points.map(([cx, cy, r]) => (
        <circle key={cx} cx={cx} cy={cy} r={r} className="agent-glyph__dot" />
      ))}
    </g>
  )
}

const botDots = [
  [16.2, 3.2, 0.75],
  [18.2, 1.6, 0.95],
  [20.4, 0, 1.15],
] as const
const chibiDots = [
  [37.5, 9, 1.1],
  [40.5, 6, 1.4],
  [43.8, 2.8, 1.7],
] as const

function BotArt({ agent, activity }: { agent: AgentGlyphProps['agent']; activity: AgentActivity }) {
  const eyes = agentEyes[agent.style.shape]
  const shape = agent.style.shape
  return (
    <>
      <ellipse className="agent-glyph__shadow" cx="10" cy="19.4" rx="5" ry="0.9" />
      <g className="agent-glyph__body">
        <Shape elements={botBodies[shape]} />
        {botDetails[shape]?.map((d) => (
          <path key={d} d={d} className="agent-glyph__detail" />
        ))}
        <g className="agent-glyph__eyes">
          {eyes.xs.map((x) => (
            <rect
              key={x}
              className="agent-glyph__eye"
              x={+(x - eyes.w / 2).toFixed(2)}
              y={+(eyes.y - eyes.h / 2).toFixed(2)}
              width={eyes.w}
              height={eyes.h}
              rx={eyes.w / 2}
            />
          ))}
        </g>
      </g>
      {(activity === 'thinking' || activity === 'needs') && <Dots points={botDots} />}
    </>
  )
}

function PictureArt({
  agent,
  activity,
  onError,
}: {
  agent: AgentGlyphProps['agent']
  activity: AgentActivity
  onError: () => void
}) {
  const { avatar, shape } = agent.style
  return (
    <>
      <ellipse className="agent-glyph__shadow" cx="10" cy="19.4" rx="5.5" ry="0.9" />
      <g className="agent-glyph__body">
        <image
          className="agent-glyph__image"
          href={agentAvatarUrl(agent.id, avatar ?? '')}
          x="0.5"
          y="0"
          width="19"
          height="19"
          preserveAspectRatio="xMidYMid meet"
          onError={onError}
        />
      </g>
      {/* The badge keeps agents told apart by colour and shape, whatever the picture shows. */}
      <g className="agent-glyph__badge">
        <circle className="agent-glyph__badge-plate" cx="15.8" cy="15.8" r="4.2" />
        <g transform="translate(12.6 12.6) scale(0.32)">
          <Shape elements={botBodies[shape]} className="agent-glyph__badge-shape" />
        </g>
      </g>
      {(activity === 'thinking' || activity === 'needs') && <Dots points={botDots} />}
    </>
  )
}

function ChibiEye({ cx }: { cx: number }) {
  return (
    <>
      <ellipse className="agent-glyph__iris" cx={cx} cy="22.4" rx="2.5" ry="3.2" />
      <circle className="agent-glyph__shine" cx={cx - 0.9} cy="21.1" r="0.95" />
      <circle className="agent-glyph__shine" cx={cx + 0.8} cy="23.9" r="0.45" />
    </>
  )
}

/**
 * A small character in a 48x52 box, built from parts that move on their own: head, hair locks, eyes, mouth, arms,
 * a laptop while working. Hair and outfit are in the agent's colour; its shape is a white hair clip.
 */
function ChibiArt({
  agent,
  activity,
  pose,
}: {
  agent: AgentGlyphProps['agent']
  activity: AgentActivity
  pose?: AgentPose
}) {
  const clip = botBodies[agent.style.shape]
  const mouth =
    activity === 'needs' || pose === 'yawn' ? (
      <ellipse className="agent-glyph__mouth-open" cx="24" cy="28.4" rx="1.3" ry="1.1" />
    ) : activity === 'working' || activity === 'thinking' ? (
      <path className="agent-glyph__mouth" d="M22.9 28.2 H25.1" />
    ) : (
      <path className="agent-glyph__mouth" d="M22.7 27.8 Q24 28.9 25.3 27.8" />
    )
  return (
    <>
      <ellipse className="agent-glyph__shadow" cx="24" cy="49.8" rx="10" ry="1.6" />
      <g className="agent-glyph__char">
        <g className="agent-glyph__feet">
          <ellipse className="agent-glyph__outfit-dark" cx="20" cy="46" rx="2.7" ry="1.6" />
          <ellipse className="agent-glyph__outfit-dark" cx="28" cy="46" rx="2.7" ry="1.6" />
        </g>
        <g className="agent-glyph__torso">
          <path
            className="agent-glyph__outfit"
            d="M16 34 Q24 30.5 32 34 L33.4 44.6 Q24 46.8 14.6 44.6 Z"
          />
          <path className="agent-glyph__collar" d="M20.8 32.8 L24 35.8 L27.2 32.8" />
        </g>
        {activity === 'working' && (
          <g className="agent-glyph__laptop">
            <rect
              className="agent-glyph__lap-lid"
              x="14.5"
              y="33.2"
              width="19"
              height="9.4"
              rx="1.2"
            />
            <circle className="agent-glyph__lap-logo" cx="24" cy="37.8" r="1" />
            <rect
              className="agent-glyph__lap-base"
              x="12.5"
              y="42.2"
              width="23"
              height="2.2"
              rx="1.1"
            />
          </g>
        )}
        <g className="agent-glyph__head">
          <circle className="agent-glyph__hair" cx="24" cy="19.4" r="14.5" />
          <g className="agent-glyph__lock agent-glyph__lock--l">
            <rect className="agent-glyph__hair" x="9.4" y="17.4" width="5" height="15" rx="2.5" />
          </g>
          <g className="agent-glyph__lock agent-glyph__lock--r">
            <rect className="agent-glyph__hair" x="33.6" y="17.4" width="5" height="15" rx="2.5" />
          </g>
          <ellipse className="agent-glyph__skin" cx="24" cy="22" rx="11.6" ry="10.6" />
          <path
            className="agent-glyph__hair"
            d="M12.4 19.8 Q12.6 8.4 24 8.4 Q35.4 8.4 35.6 19.8 Q32.6 14.6 29 16.4 Q27 12.2 23.6 15.6 Q20 12.4 17.6 16.6 Q14.6 15.6 12.4 19.8 Z"
          />
          {/* Big enough to tell apart at chat size: the clip is the agent's shape. */}
          <g transform="translate(9.6 2.2) scale(0.72)">
            <Shape elements={clip} className="agent-glyph__clip" />
          </g>
          <g className="agent-glyph__eyes">
            <ChibiEye cx={19.2} />
            <ChibiEye cx={28.8} />
          </g>
          <ellipse className="agent-glyph__blush" cx="16.4" cy="26.6" rx="2.1" ry="1.05" />
          <ellipse className="agent-glyph__blush" cx="31.6" cy="26.6" rx="2.1" ry="1.05" />
          {mouth}
        </g>
        <g className="agent-glyph__arm agent-glyph__arm--l">
          <rect className="agent-glyph__outfit" x="15.1" y="33" width="3" height="8" rx="1.5" />
          <circle className="agent-glyph__skin" cx="16.6" cy="41.4" r="1.7" />
        </g>
        <g className="agent-glyph__arm agent-glyph__arm--r">
          <rect className="agent-glyph__outfit" x="29.9" y="33" width="3" height="8" rx="1.5" />
          <circle className="agent-glyph__skin" cx="31.4" cy="41.4" r="1.7" />
        </g>
      </g>
      {activity === 'thinking' && <Dots points={chibiDots} />}
      {activity === 'needs' && (
        <g className="agent-glyph__alert">
          <rect className="agent-glyph__alert-bg" x="37" y="1" width="8" height="9" rx="3" />
          <text className="agent-glyph__alert-text" x="41" y="8.2">
            !
          </text>
        </g>
      )}
    </>
  )
}

const reducedMotion = () =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** Faces look toward the pointer while it is over them (a bot or a chibi; never changes any state). */
function lookAtPointer(event: PointerEvent<Element>, reach: number) {
  const eyes = event.currentTarget.querySelector<SVGGElement>('.agent-glyph__eyes')
  if (!eyes || reducedMotion()) return
  const box = event.currentTarget.getBoundingClientRect()
  const dx = (event.clientX - (box.left + box.width / 2)) / box.width
  const dy = (event.clientY - (box.top + box.height / 2)) / box.height
  eyes.style.animation = 'none'
  eyes.style.transform = `translate(${(dx * reach).toFixed(2)}px, ${(dy * reach * 0.7).toFixed(2)}px)`
}

function lookAway(event: PointerEvent<Element>) {
  const eyes = event.currentTarget.querySelector<SVGGElement>('.agent-glyph__eyes')
  if (!eyes) return
  eyes.style.animation = ''
  eyes.style.transform = ''
}

export function AgentGlyph({
  agent,
  size = 'md',
  bare = false,
  decorative = false,
  describeShape = false,
  contrast = 'default',
  activity,
  plain = false,
  pose,
}: AgentGlyphProps) {
  // A picture that fails to load (removed, or the server unreachable) falls back to the agent's look.
  const [failedRev, setFailedRev] = useState<string | null>(null)
  const kind = plain
    ? 'plain'
    : glyphKind(agent.style, size, failedRev !== null && failedRev === agent.style.avatar)
  const mood = activity ?? 'idle'
  const rich = kind !== 'plain'
  const className = [
    'agent-glyph',
    `agent-glyph--${size}`,
    `agent-glyph--${kind}`,
    rich && `agent-glyph--${mood}`,
    rich && 'agent-glyph--rich',
    rich && pose && `agent-glyph--${pose}`,
    !bare && 'agent-glyph--tile',
    contrast === 'high' && 'agent-glyph--high',
  ]
    .filter(Boolean)
    .join(' ')
  const style = {
    '--glyph-color': agent.style.color,
    '--glyph-tint': agentTint(agent.style.color),
  } as CSSProperties
  const accessibility = decorative
    ? { 'aria-hidden': true as const }
    : {
        role: 'img',
        'aria-label': describeShape ? `${agent.name}, ${agent.style.shape}` : agent.name,
      }
  const faces = kind === 'bot' || kind === 'chibi'
  const pointer = faces
    ? {
        onPointerMove: (event: PointerEvent<Element>) =>
          lookAtPointer(event, kind === 'chibi' ? 1.6 : 2.2),
        onPointerLeave: lookAway,
      }
    : {}
  let art: ReactNode
  let viewBox = '0 0 20 20'
  switch (kind) {
    case 'plain':
      art = <Shape elements={agentShapes[agent.style.shape]} />
      break
    case 'bot':
      art = <BotArt agent={agent} activity={mood} />
      break
    case 'chibi':
      art = <ChibiArt agent={agent} activity={mood} pose={pose} />
      viewBox = '0 0 48 52'
      break
    case 'picture':
      art = (
        <PictureArt
          agent={agent}
          activity={mood}
          onError={() => setFailedRev(agent.style.avatar ?? null)}
        />
      )
      break
  }

  if (bare) {
    return (
      <svg
        {...accessibility}
        {...pointer}
        data-protected="inline-flex"
        className={className}
        style={style}
        viewBox={viewBox}
        fill="none"
        focusable="false"
      >
        {art}
      </svg>
    )
  }

  return (
    <span
      {...accessibility}
      {...pointer}
      data-protected="inline-flex"
      className={className}
      style={style}
    >
      <svg viewBox={viewBox} fill="none" aria-hidden="true" focusable="false">
        {art}
      </svg>
    </span>
  )
}
