import type { AgentStyle } from '@score/contract'
import { useContext, useEffect, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { AgentFace } from './AgentFace.tsx'
import { faceHidesCentreDot, moodWords, type FaceMood } from './agent-face.ts'
import { AgentFacesContext } from './agent-faces-context.ts'
import { agentShapes, type AgentShapeElement } from './agent-shapes.ts'
import './agent-glyph.css'

export type AgentGlyphProps = {
  agent: { id: string; name: string; style: AgentStyle }
  size?: 'xs' | 'sm' | 'md' | 'lg'
  bare?: boolean
  decorative?: boolean
  describeShape?: boolean
  contrast?: 'default' | 'high'
  /** What the agent is doing; drawn as its eyes in the new shell only (decision 127). Default idle. */
  mood?: FaceMood
  /** Hero glyphs: eyes follow the pointer and a tap or Enter/Space greets (happy arcs and a hop for ~1.2 s). */
  lively?: boolean
  /** Adds the mood to the accessible name; only where the mood is not already said in text next to the glyph. */
  describeMood?: boolean
}

const GREETING_MS = 1200

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

export function AgentGlyph({
  agent,
  size = 'md',
  bare = false,
  decorative = false,
  describeShape = false,
  contrast = 'default',
  mood = 'idle',
  lively = false,
  describeMood = false,
}: AgentGlyphProps) {
  const faces = useContext(AgentFacesContext)
  const [greeting, setGreeting] = useState(false)
  useEffect(() => {
    if (!greeting) return
    const timer = setTimeout(() => setGreeting(false), GREETING_MS)
    return () => clearTimeout(timer)
  }, [greeting])
  const shown: FaceMood = greeting ? 'done' : mood
  const animated = faces && size !== 'xs'
  const className = [
    'agent-glyph',
    `agent-glyph--${size}`,
    !bare && 'agent-glyph--tile',
    contrast === 'high' && 'agent-glyph--high',
    faces && 'agent-glyph--face',
    animated && 'agent-glyph--face-animated',
  ]
    .filter(Boolean)
    .join(' ')
  const style = {
    '--glyph-color': agent.style.color,
    '--glyph-tint': agentTint(agent.style.color),
  } as CSSProperties
  const word = describeMood && faces ? moodWords[mood] : null
  const accessibility = decorative
    ? { 'aria-hidden': true as const }
    : {
        role: 'img',
        'aria-label': [agent.name, describeShape ? agent.style.shape : null, word]
          .filter(Boolean)
          .join(', '),
      }
  const body =
    faces && faceHidesCentreDot(agent.style.shape)
      ? agentShapes[agent.style.shape].slice(0, 1)
      : agentShapes[agent.style.shape]
  const art = faces ? (
    <g className="agent-glyph__body">
      <Shape elements={body} />
      <AgentFace
        id={agent.id}
        shape={agent.style.shape}
        mood={shown}
        animated={animated}
        lively={lively}
      />
    </g>
  ) : (
    <Shape elements={body} />
  )
  const face = faces
    ? {
        'data-face': shown,
        'data-greeting': greeting ? '' : undefined,
        ...(lively
          ? {
              onClick: () => setGreeting(true),
              onKeyDown: (event: KeyboardEvent) => {
                if (event.key === 'Enter' || event.key === ' ') setGreeting(true)
              },
            }
          : {}),
      }
    : {}

  if (bare) {
    return (
      <svg
        {...accessibility}
        {...face}
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
      {...face}
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
