import type { AgentLook, AgentStyle } from '@score/contract'
import { useEffect, useId, type CSSProperties } from 'react'
import { agentEyes, agentShapes, markBodies, type AgentShapeElement } from './agent-shapes.ts'
import { watchGlyphs } from './glyph-pointer.ts'
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
  const kind = plain ? 'plain' : glyphKind(agent.style, size)
  const mood = activity ?? 'idle'
  const rich = kind !== 'plain'
  useEffect(() => (rich ? watchGlyphs() : undefined), [rich])
  const className = [
    'agent-glyph',
    `agent-glyph--${size}`,
    `agent-glyph--${kind}`,
    rich && `agent-glyph--${mood}`,
    rich && 'agent-glyph--rich',
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
  const art =
    kind === 'plain' ? (
      <Shape elements={agentShapes[agent.style.shape]} />
    ) : (
      <MarkArt shape={agent.style.shape} look={kind} activity={mood} />
    )

  if (bare) {
    return (
      <svg
        {...accessibility}
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
    <span {...accessibility} data-protected="inline-flex" className={className} style={style}>
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
        {art}
      </svg>
    </span>
  )
}
