import type { AgentStyle } from '@score/contract'
import type { CSSProperties } from 'react'
import { agentShapes, type AgentShapeElement } from './agent-shapes.ts'
import './agent-glyph.css'

export type AgentGlyphProps = {
  agent: { id: string; name: string; style: AgentStyle }
  size?: 'xs' | 'sm' | 'md' | 'lg'
  bare?: boolean
  decorative?: boolean
  describeShape?: boolean
  contrast?: 'default' | 'high'
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
}: AgentGlyphProps) {
  const className = [
    'agent-glyph',
    `agent-glyph--${size}`,
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
  const art = <Shape elements={agentShapes[agent.style.shape]} />

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
