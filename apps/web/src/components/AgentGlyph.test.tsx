import { readFileSync } from 'node:fs'
import { ShapeSchema, type Shape } from '@score/contract'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { AgentGlyph, agentTint } from './AgentGlyph.tsx'

const shapes = ShapeSchema.options
const sizes = ['xs', 'sm', 'md', 'lg'] as const
const stylesheet = readFileSync('src/components/agent-glyph.css', 'utf8')

function agent(shape: Shape = 'circle-dot', color = '#6B4EFF') {
  return { id: 'lead', name: 'lead', style: { color, shape } }
}

afterEach(cleanup)

test.each(shapes.flatMap((shape) => sizes.map((size) => ({ shape, size }))))(
  '$shape renders at $size with the agent name',
  ({ shape, size }) => {
    render(<AgentGlyph agent={agent(shape)} size={size} />)
    const glyph = screen.getByRole('img', { name: 'lead' })
    expect(glyph.classList.contains(`agent-glyph--${size}`)).toBe(true)
    expect(glyph.classList.contains('agent-glyph--tile')).toBe(true)
    expect(glyph.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 20 20')
    expect(glyph.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    expect(glyph.style.getPropertyValue('--glyph-color')).toBe('#6B4EFF')
    expect(glyph.style.getPropertyValue('--glyph-tint')).toBe('#ECE8FF')
    expect(glyph.style.length).toBe(2)
  },
)

test.each(shapes)('%s matches the shape snapshot', (shape) => {
  const { container } = render(<AgentGlyph agent={agent(shape)} />)
  expect(container.firstChild).toMatchSnapshot()
})

test.each(shapes.flatMap((shape) => sizes.map((size) => ({ shape, size }))))(
  'bare $shape at $size has only an accessible SVG',
  ({ shape, size }) => {
    const { container } = render(<AgentGlyph agent={agent(shape)} size={size} bare />)
    const glyph = screen.getByRole('img', { name: 'lead' })
    expect(glyph.tagName.toLowerCase()).toBe('svg')
    expect(glyph.classList.contains('agent-glyph--tile')).toBe(false)
    expect(glyph.classList.contains(`agent-glyph--${size}`)).toBe(true)
    expect(glyph.getAttribute('aria-hidden')).toBeNull()
    expect(glyph.getAttribute('focusable')).toBe('false')
    expect(container.querySelector('span')).toBeNull()
  },
)

test.each([false, true])('decorative mode hides the glyph (bare=%s)', (bare) => {
  const { container } = render(<AgentGlyph agent={agent()} bare={bare} decorative describeShape />)
  expect(screen.queryByRole('img')).toBeNull()
  expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true')
  expect(container.firstElementChild?.getAttribute('aria-label')).toBeNull()
  expect(container.firstElementChild?.getAttribute('role')).toBeNull()
})

test.each(shapes)('%s is described only when requested', (shape) => {
  const { rerender } = render(<AgentGlyph agent={agent(shape)} describeShape />)
  expect(screen.getByRole('img', { name: `lead, ${shape}` })).toBeDefined()
  rerender(<AgentGlyph agent={agent(shape)} />)
  expect(screen.getByRole('img', { name: 'lead' })).toBeDefined()
})

test('uses the supplied agent name and updates identity and tint on rerender', () => {
  const { rerender } = render(<AgentGlyph agent={agent()} />)
  rerender(
    <AgentGlyph
      agent={{ id: 'builder', name: 'builder', style: { color: '#19C39A', shape: 'triangle' } }}
    />,
  )
  const glyph = screen.getByRole('img', { name: 'builder' })
  expect(glyph.style.getPropertyValue('--glyph-tint')).toBe('#DDF6EE')
  expect(glyph.querySelector('path')?.getAttribute('d')).toBe('M10 3 L17.5 16 H2.5 Z')
})

test('preserves the four design geometries exactly', () => {
  const { rerender } = render(<AgentGlyph agent={agent()} />)
  const svg = () => screen.getByRole('img').querySelector('svg')!
  expect(svg().innerHTML).toBe(
    '<circle cx="10" cy="10" r="6.5" stroke-width="2.4" class="agent-glyph__ring"></circle><circle cx="10" cy="10" r="2.4" class="agent-glyph__solid"></circle>',
  )
  rerender(<AgentGlyph agent={agent('triangle')} />)
  expect(svg().querySelector('path')?.getAttribute('d')).toBe('M10 3 L17.5 16 H2.5 Z')
  rerender(<AgentGlyph agent={agent('diamond')} />)
  expect(svg().querySelector('path')?.getAttribute('d')).toBe('M10 2.5 L17.5 10 L10 17.5 L2.5 10 Z')
  rerender(<AgentGlyph agent={agent('square')} />)
  expect(svg().innerHTML).toBe(
    '<rect x="4" y="4" width="12" height="12" rx="4" class="agent-glyph__solid"></rect>',
  )
})

test.each([
  ['xs', 20, 7, 12],
  ['sm', 34, 11, 18],
  ['md', 40, 13, 20],
  ['lg', 44, 14, 24],
])('%s has the exact design dimensions', (size, tile, radius, svg) => {
  const rule = stylesheet.match(new RegExp(`\\.agent-glyph--${size}\\s*\\{([^}]+)\\}`))?.[1]
  expect(rule).toContain(`--glyph-tile-size: ${tile}px`)
  expect(rule).toContain(`--glyph-radius: ${radius}px`)
  expect(rule).toContain(`--glyph-svg-size: ${svg}px`)
})

test.each([
  ['#6B4EFF', '#ECE8FF'],
  ['#19C39A', '#DDF6EE'],
  ['#FFB61E', '#FFF1D1'],
  ['#FF6B8A', '#FFE3E9'],
  ['#123456', '#DBE1E6'],
  ['#FFFF00', '#FFFFD9'],
  ['#000000', '#D9D9D9'],
  ['#FFFFFF', '#FFFFFF'],
])('agentTint(%s) is %s, regardless of case', (color, tint) => {
  expect(agentTint(color)).toBe(tint)
  expect(agentTint(color.toLowerCase())).toBe(tint)
})

test.each(['red', '#fff', '#12345Z', '#12345678', ''])(
  'rejects an invalid hex color: %s',
  (color) => {
    expect(() => agentTint(color)).toThrow(TypeError)
  },
)

test.each([false, true])(
  'explicit high contrast reaches both solid and ring shapes (bare=%s)',
  (bare) => {
    const { rerender } = render(<AgentGlyph agent={agent()} bare={bare} contrast="high" />)
    expect(screen.getByRole('img').classList.contains('agent-glyph--high')).toBe(true)
    rerender(<AgentGlyph agent={agent()} bare={bare} />)
    expect(screen.getByRole('img').classList.contains('agent-glyph--high')).toBe(false)
    const highRule = stylesheet.match(/\.agent-glyph--high\s*\{([^}]+)\}/)?.[1]
    const autoRule = stylesheet.match(
      /@media \(prefers-contrast: more\)\s*\{\s*\.agent-glyph\s*\{([^}]+)\}/,
    )?.[1]
    expect(highRule?.replace(/\s+/g, ' ').trim()).toBe(autoRule?.replace(/\s+/g, ' ').trim())
    expect(highRule).toContain('--glyph-shape-stroke: var(--glyph-outline)')
    expect(highRule).toContain('--glyph-ring-stroke: var(--glyph-outline)')
    expect(highRule).toContain('--glyph-border: 1.5px solid #12131a')
    expect(stylesheet).toContain('stroke: var(--glyph-shape-stroke, none)')
    expect(stylesheet).toContain('stroke: var(--glyph-ring-stroke, var(--glyph-color))')
    expect(stylesheet).toContain('border: var(--glyph-border, 0 solid transparent)')
  },
)

function luminance(channels: number[]) {
  const linear = channels.map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722
}

function rgb(color: string) {
  return [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16))
}

test.each(['#6B4EFF', '#19C39A', '#FFB61E', '#FF6B8A', '#FFFF00', '#FFFFFF'])(
  '%s high-contrast stroke exceeds 3:1 against its tile',
  (color) => {
    // Evaluate the actual CSS mix and rounding, independently of agentTint's color math.
    const mix = stylesheet.match(
      /color-mix\(in srgb, var\(--glyph-color\) (\d+)%, (#[\da-f]+) (\d+)%\)/i,
    )!
    expect(stylesheet).toContain('round(down, r, 1)')
    expect(stylesheet).toContain('round(down, g, 1)')
    expect(stylesheet).toContain('round(down, b, 1)')
    const ink = rgb(mix[2]!)
    const stroke = rgb(color).map((channel, index) =>
      Math.floor((channel * Number(mix[1])) / 100 + (ink[index]! * Number(mix[3])) / 100),
    )
    const ratio = (luminance(rgb(agentTint(color))) + 0.05) / (luminance(stroke) + 0.05)
    expect(ratio).toBeGreaterThanOrEqual(3)
  },
)
