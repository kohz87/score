import type { AgentLook, AgentStyle } from '@score/contract'
import { useEffect, useId, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { useLiveliness } from '../data/liveliness.ts'
import { agentEyes, agentShapes, markBodies, type AgentShapeElement } from './agent-shapes.ts'
import { watchGlyphs } from './glyph-pointer.ts'
import { usePortrait } from './portrait-cache.ts'
import './agent-glyph.css'
import './agent-glyph-motion.css'

/** What an agent is doing right now, where the caller knows it. Without it the mark rests. */
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
}

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

export type GlyphKind = 'plain' | AgentLook

/** List size is always the plain coloured shape; otherwise the agent's mark, and `cut` is the default. */
export function glyphKind(style: AgentStyle, size: 'xs' | 'sm' | 'md' | 'lg'): GlyphKind {
  return size === 'xs' ? 'plain' : (style.look ?? 'cut')
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

/** One eye slot: a rounded bar, black in the cut-out's mask, the agent's colour in a ring. */
function Slots({
  shape,
  className,
  fill,
}: {
  shape: AgentStyle['shape']
  className: string
  fill?: string
}) {
  const { y, xs, w, h } = agentEyes[shape]
  return (
    <g className="agent-glyph__eyes">
      {xs.map((x) => (
        <rect
          key={x}
          className={className}
          x={+(x - w / 2).toFixed(2)}
          y={+(y - h / 2).toFixed(2)}
          width={w}
          height={h}
          rx={+(w / 2).toFixed(2)}
          fill={fill}
        />
      ))}
    </g>
  )
}

/**
 * The agent's mark (decision 108): its shape in its colour with a calm face. `cut` is a solid mark with the eyes cut
 * through it (the page shows through); `ring` is the shape as one thick outline with two solid eyes inside.
 */
function MarkArt({
  shape,
  look,
  activity,
}: {
  shape: AgentStyle['shape']
  look: AgentLook
  activity: AgentActivity
}) {
  const mask = useId()
  return (
    <>
      {activity === 'needs' && (
        <>
          <circle className="agent-glyph__ripple" cx="10" cy="10" r="8.5" />
          <circle className="agent-glyph__ripple" cx="10" cy="10" r="8.5" />
        </>
      )}
      {look === 'cut' ? (
        <>
          <mask id={mask}>
            <rect x="-5" y="-5" width="30" height="30" fill="#fff" />
            <Slots shape={shape} className="agent-glyph__slot" fill="#000" />
          </mask>
          <g className="agent-glyph__mark" mask={`url(#${mask})`}>
            <Shape elements={markBodies[shape]} />
          </g>
        </>
      ) : (
        <g className="agent-glyph__mark">
          <Shape elements={markBodies[shape]} className="agent-glyph__outline" />
          <Slots shape={shape} className="agent-glyph__slot agent-glyph__slot--solid" />
        </g>
      )}
      {activity === 'thinking' && (
        <circle className="agent-glyph__orbit" cx="10" cy="0.6" r="0.9" />
      )}
    </>
  )
}

type Portrait = NonNullable<ReturnType<typeof usePortrait>>

/** True while the pointer is over the glyph (or the button or link it sits in) or that control has keyboard focus. */
function useWatched(ref: RefObject<Element | null>, enabled: boolean): boolean {
  const [watched, setWatched] = useState(false)
  useEffect(() => {
    const own = ref.current
    if (!enabled || !own) return undefined
    const target = own.closest('button, a[href], [role=button], [role=menuitem]') ?? own
    const on = () => setWatched(true)
    const off = () => setWatched(false)
    const events = [
      ['pointerenter', on],
      ['pointerleave', off],
      ['focusin', on],
      ['focusout', off],
    ] as const
    for (const [type, handler] of events) target.addEventListener(type, handler)
    return () => {
      for (const [type, handler] of events) target.removeEventListener(type, handler)
      setWatched(false)
    }
  }, [ref, enabled])
  return enabled && watched
}

/** Where the idle file sits so that the same square the still portrait was cut from fills the circle. */
function animPlacement(portrait: Portrait): CSSProperties {
  const { crop, width, height } = portrait
  return {
    width: `${+((width / crop.side) * 100).toFixed(3)}%`,
    height: `${+((height / crop.side) * 100).toFixed(3)}%`,
    left: `${+((-crop.x / crop.side) * 100).toFixed(3)}%`,
    top: `${+((-crop.y / crop.side) * 100).toFixed(3)}%`,
  }
}

/**
 * The portrait as one svg (list size, and a bare glyph): clipped to the agent's shape at `xs`, or to a ring with a
 * small shape badge when bare at a larger size. Identity stays colour + shape (AGENTS.md).
 */
function PortraitArt({
  portrait,
  shape,
  round,
  playing,
}: {
  portrait: Portrait
  shape: AgentStyle['shape']
  round: boolean
  playing: boolean
}) {
  const clip = useId()
  const k = 20 / portrait.crop.side
  const outline = round ? (
    <circle className="agent-glyph__portrait-outline" cx="10" cy="10" r="9" />
  ) : (
    <Shape elements={agentShapes[shape]} className="agent-glyph__portrait-outline" />
  )
  return (
    <>
      <clipPath id={clip}>
        {round ? <circle cx="10" cy="10" r="9" /> : <Shape elements={agentShapes[shape]} />}
      </clipPath>
      <image
        className="agent-glyph__portrait-image"
        href={portrait.url}
        x="0"
        y="0"
        width="20"
        height="20"
        clipPath={`url(#${clip})`}
      />
      {playing && (
        <image
          className="agent-glyph__portrait-image agent-glyph__anim"
          href={portrait.idle}
          x={-portrait.crop.x * k}
          y={-portrait.crop.y * k}
          width={portrait.width * k}
          height={portrait.height * k}
          clipPath={`url(#${clip})`}
        />
      )}
      {outline}
      {round && (
        <g className="agent-glyph__badge-mark" transform="translate(11.2 11.2) scale(0.44)">
          <circle className="agent-glyph__badge-plate" cx="10" cy="10" r="12" />
          <Shape elements={agentShapes[shape]} />
        </g>
      )}
    </>
  )
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
}: AgentGlyphProps) {
  const pack = agent.style.pack
  const portrait = usePortrait(agent.id, plain || !pack ? null : pack.rev)
  const liveliness = useLiveliness()
  const root = useRef<HTMLSpanElement & SVGSVGElement>(null)
  const playing = useWatched(root, portrait !== null && liveliness !== 'still')
  const kind = plain ? 'plain' : glyphKind(agent.style, size)
  const mood = activity ?? 'idle'
  const pictured = portrait !== null
  const rich = kind !== 'plain' && !pictured
  useEffect(() => (rich ? watchGlyphs() : undefined), [rich])
  const className = [
    'agent-glyph',
    `agent-glyph--${size}`,
    pictured ? 'agent-glyph--portrait' : `agent-glyph--${kind}`,
    rich && `agent-glyph--${mood}`,
    rich && 'agent-glyph--rich',
    !bare && !(pictured && size !== 'xs') && 'agent-glyph--tile',
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
  const art = pictured ? (
    <PortraitArt
      portrait={portrait}
      shape={agent.style.shape}
      round={size !== 'xs'}
      playing={playing}
    />
  ) : kind === 'plain' ? (
    <Shape elements={agentShapes[agent.style.shape]} />
  ) : (
    <MarkArt shape={agent.style.shape} look={kind} activity={mood} />
  )

  if (pictured && !bare && size !== 'xs') {
    const look = agent.style.look ?? 'cut'
    return (
      <span
        {...accessibility}
        ref={root}
        data-protected="inline-flex"
        className={className}
        style={style}
      >
        <span className="agent-glyph__portrait">
          <img className="agent-glyph__still" src={portrait.url} alt="" draggable={false} />
          {playing && (
            <img
              className="agent-glyph__anim"
              src={portrait.idle}
              alt=""
              draggable={false}
              style={animPlacement(portrait)}
            />
          )}
        </span>
        <span className="agent-glyph__badge">
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
            <MarkArt shape={agent.style.shape} look={look} activity="idle" />
          </svg>
        </span>
      </span>
    )
  }

  if (bare) {
    return (
      <svg
        {...accessibility}
        ref={root}
        data-protected="inline-flex"
        className={className}
        style={style}
        viewBox="0 0 20 20"
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
      ref={root}
      data-protected="inline-flex"
      className={className}
      style={style}
    >
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
        {art}
      </svg>
    </span>
  )
}
