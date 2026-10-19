import { readFileSync } from 'node:fs'
import { ShapeSchema, type AgentStyle, type Shape } from '@score/contract'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AgentGlyph, agentAvatarUrl, agentTint } from './AgentGlyph.tsx'
import { agentShapes } from './agent-shapes.ts'

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

test('preserves the four design geometries exactly at list size', () => {
  const { rerender } = render(<AgentGlyph agent={agent()} size="xs" />)
  const svg = () => screen.getByRole('img').querySelector('svg')!
  expect(svg().innerHTML).toBe(
    '<circle cx="10" cy="10" r="6.5" stroke-width="2.4" class="agent-glyph__ring"></circle><circle cx="10" cy="10" r="2.4" class="agent-glyph__solid"></circle>',
  )
  rerender(<AgentGlyph agent={agent('triangle')} size="xs" />)
  expect(svg().querySelector('path')?.getAttribute('d')).toBe('M10 3 L17.5 16 H2.5 Z')
  rerender(<AgentGlyph agent={agent('diamond')} size="xs" />)
  expect(svg().querySelector('path')?.getAttribute('d')).toBe('M10 2.5 L17.5 10 L10 17.5 L2.5 10 Z')
  rerender(<AgentGlyph agent={agent('square')} size="xs" />)
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

// PLAN 10.2: looks, pictures and moods.
const looks = ['bot', 'chibi'] as const
const sizable = ['sm', 'md', 'lg'] as const
const motion = readFileSync('src/components/agent-glyph-motion.css', 'utf8')

function styled(extra: Partial<AgentStyle>, shape: Shape = 'triangle') {
  return { id: 'lead', name: 'lead', style: { color: '#6B4EFF', shape, ...extra } }
}

test('an agent without a look is a bot with two eyes and no tile of its own', () => {
  render(<AgentGlyph agent={agent('triangle')} size="sm" />)
  const glyph = screen.getByRole('img', { name: 'lead' })
  expect(glyph.classList.contains('agent-glyph--bot')).toBe(true)
  expect(glyph.classList.contains('agent-glyph--rich')).toBe(true)
  expect(glyph.querySelectorAll('.agent-glyph__eye')).toHaveLength(2)
  expect(glyph.querySelector('.agent-glyph__image')).toBeNull()
  expect(stylesheet).toMatch(
    /\.agent-glyph--tile\.agent-glyph--rich\s*\{\s*background: transparent/,
  )
})

test.each(shapes.flatMap((shape) => sizable.map((size) => ({ shape, size }))))(
  'every shape is a bot, a chibi and a picture at $size ($shape)',
  ({ shape, size }) => {
    const { rerender } = render(<AgentGlyph agent={styled({}, shape)} size={size} />)
    expect(screen.getByRole('img').querySelectorAll('.agent-glyph__eye')).toHaveLength(2)
    rerender(<AgentGlyph agent={styled({ look: 'chibi' }, shape)} size={size} />)
    expect(screen.getByRole('img').classList.contains('agent-glyph--chibi')).toBe(true)
    expect(screen.getByRole('img').querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 48 52')
    expect(screen.getByRole('img').querySelectorAll('.agent-glyph__clip').length).toBeGreaterThan(0)
    rerender(<AgentGlyph agent={styled({ avatar: 'r1' }, shape)} size={size} />)
    expect(screen.getByRole('img').classList.contains('agent-glyph--picture')).toBe(true)
  },
)

test('the lead as a bot is a solid round head, not a ring', () => {
  render(<AgentGlyph agent={agent('circle-dot')} size="sm" />)
  const art = screen.getByRole('img').querySelector('svg')!
  expect(art.querySelector('.agent-glyph__ring')).toBeNull()
  expect(art.querySelector('circle.agent-glyph__solid')?.getAttribute('r')).toBe('8')
})

test('a chibi wears its shape as a white hair clip, in the shape of the agent', () => {
  const { rerender } = render(<AgentGlyph agent={styled({ look: 'chibi' }, 'heart')} size="sm" />)
  const clip = () => screen.getByRole('img').querySelector('.agent-glyph__clip')!.getAttribute('d')
  const heart = clip()
  rerender(<AgentGlyph agent={styled({ look: 'chibi' }, 'gem')} size="sm" />)
  expect(clip()).not.toBe(heart)
  expect(stylesheet).toMatch(/\.agent-glyph__clip\s*\{[^}]*fill: #ffffff/)
  // Large enough to read at about 28px: the clip is scaled to at least 0.7 of the 20-unit box.
  const scale = screen.getByRole('img').querySelector('.agent-glyph__clip')!.parentElement!
  expect(
    Number(/scale\(([\d.]+)\)/.exec(scale.getAttribute('transform') ?? '')?.[1]),
  ).toBeGreaterThanOrEqual(0.7)
})

test('list size is always the plain shape: no face, no picture, no clip', () => {
  for (const extra of [
    {},
    { look: 'chibi' as const },
    { avatar: 'r1' },
    { look: 'chibi' as const, avatar: 'r1' },
  ]) {
    const { container, unmount } = render(<AgentGlyph agent={styled(extra)} size="xs" />)
    const glyph = container.firstElementChild!
    expect(glyph.querySelector('.agent-glyph__eye')).toBeNull()
    expect(glyph.querySelector('image')).toBeNull()
    expect(glyph.querySelector('.agent-glyph__clip')).toBeNull()
    expect(glyph.classList.contains('agent-glyph--plain')).toBe(true)
    expect(glyph.classList.contains('agent-glyph--rich')).toBe(false)
    unmount()
  }
})

test('a picture is shown from its revision, with a badge in the agent colour and shape', () => {
  render(<AgentGlyph agent={styled({ avatar: 'r7Kq-2', look: 'chibi' }, 'cloud')} size="md" />)
  const glyph = screen.getByRole('img', { name: 'lead' })
  const image = glyph.querySelector('image')!
  expect(image.getAttribute('href')).toBe('/api/agents/lead/avatar?rev=r7Kq-2')
  expect(image.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet')
  // The picture wins over the look; the badge carries shape and colour so agents are never told apart by the art alone.
  expect(glyph.querySelector('.agent-glyph__clip')).toBeNull()
  expect(glyph.querySelector('.agent-glyph__badge-plate')).not.toBeNull()
  expect(glyph.querySelector('.agent-glyph__badge-shape')?.getAttribute('d')).toBe(
    agentShapes.cloud[0].d,
  )
  expect(stylesheet).toMatch(/\.agent-glyph__badge-plate\s*\{\s*fill: var\(--glyph-color\)/)
})

test('the picture url escapes the agent id and the revision', () => {
  expect(agentAvatarUrl('a b', 'x_y-1')).toBe('/api/agents/a%20b/avatar?rev=x_y-1')
})

test('a picture that fails to load falls back to the look', () => {
  render(<AgentGlyph agent={styled({ avatar: 'gone', look: 'chibi' })} size="md" />)
  fireEvent.error(screen.getByRole('img').querySelector('image')!)
  expect(screen.getByRole('img').classList.contains('agent-glyph--chibi')).toBe(true)
  expect(screen.getByRole('img').querySelector('image')).toBeNull()
})

test.each([...looks, 'picture'] as const)(
  'a %s keeps its name, shape description, decorative mode and bare form',
  (kind) => {
    const extra = kind === 'picture' ? { avatar: 'r1' } : { look: kind }
    const { rerender, container } = render(
      <AgentGlyph agent={styled(extra, 'drop')} size="sm" describeShape />,
    )
    expect(screen.getByRole('img', { name: 'lead, drop' })).toBeDefined()
    rerender(<AgentGlyph agent={styled(extra, 'drop')} size="sm" decorative />)
    expect(screen.queryByRole('img')).toBeNull()
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true')
    rerender(<AgentGlyph agent={styled(extra, 'drop')} size="sm" bare />)
    expect(screen.getByRole('img').tagName.toLowerCase()).toBe('svg')
    expect(screen.getByRole('img').getAttribute('data-protected')).toBe('inline-flex')
    rerender(<AgentGlyph agent={styled(extra, 'drop')} size="sm" contrast="high" />)
    expect(screen.getByRole('img').classList.contains('agent-glyph--high')).toBe(true)
  },
)

test('the eyes are the plate colour, white on a dark agent and ink on a light one', () => {
  expect(stylesheet).toMatch(/\.agent-glyph__eye\s*\{\s*fill: var\(--glyph-plate\)/)
  // The plate switches at the luminance where white and ink read about equally well (glyph-plate.test.ts walks all
  // colours for 3:1). Spot-check the preview's colours: dark ones get white eyes, light ones ink.
  const darkAgent = (color: string) => {
    const lum = rgb(color)
      .map((channel, index) => (channel / 255) ** 2.2 * [0.2126, 0.7152, 0.0722][index]!)
      .reduce((a, b) => a + b)
    return lum < 0.1935
  }
  expect(['#6B4EFF', '#0F766E', '#DC2626'].map(darkAgent)).toEqual([true, true, true])
  expect(['#FFB61E', '#19C39A', '#FFFF00'].map(darkAgent)).toEqual([false, false, false])
})

test('with no activity an agent rests; the activity prop picks the mood', () => {
  const { rerender } = render(<AgentGlyph agent={styled({})} size="sm" />)
  const glyph = () => screen.getByRole('img')
  expect(glyph().classList.contains('agent-glyph--idle')).toBe(true)
  for (const activity of ['working', 'thinking', 'needs'] as const) {
    rerender(<AgentGlyph agent={styled({})} size="sm" activity={activity} />)
    expect(glyph().classList.contains(`agent-glyph--${activity}`)).toBe(true)
    expect(glyph().classList.contains('agent-glyph--idle')).toBe(false)
  }
})

test.each([...looks, 'picture'] as const)(
  'thought dots belong to thinking and needs-you only (%s)',
  (kind) => {
    const extra = kind === 'picture' ? { avatar: 'r1' } : { look: kind }
    const { rerender } = render(<AgentGlyph agent={styled(extra)} size="md" />)
    const dots = () => screen.getByRole('img').querySelectorAll('.agent-glyph__dot').length
    expect(dots()).toBe(0)
    rerender(<AgentGlyph agent={styled(extra)} size="md" activity="working" />)
    expect(dots()).toBe(0)
    rerender(<AgentGlyph agent={styled(extra)} size="md" activity="thinking" />)
    expect(dots()).toBe(3)
    if (kind !== 'chibi') {
      rerender(<AgentGlyph agent={styled(extra)} size="md" activity="needs" />)
      expect(dots()).toBe(3)
    }
  },
)

test('a chibi works at a laptop, rests its cheek on a hand to think, and calls with a "!" bubble', () => {
  const { rerender } = render(<AgentGlyph agent={styled({ look: 'chibi' })} size="lg" />)
  const part = (name: string) => screen.getByRole('img').querySelector(`.agent-glyph__${name}`)
  expect(part('laptop')).toBeNull()
  expect(part('alert')).toBeNull()
  expect(part('mouth-open')).toBeNull()
  expect(part('arm--l')).not.toBeNull()
  expect(part('arm--r')).not.toBeNull()
  expect(part('lock--l')).not.toBeNull()
  expect(part('head')).not.toBeNull()
  rerender(<AgentGlyph agent={styled({ look: 'chibi' })} size="lg" activity="working" />)
  expect(part('laptop')).not.toBeNull()
  expect(part('alert')).toBeNull()
  rerender(<AgentGlyph agent={styled({ look: 'chibi' })} size="lg" activity="needs" />)
  expect(part('laptop')).toBeNull()
  expect(part('alert')?.textContent).toBe('!')
  expect(part('mouth-open')).not.toBeNull()
  // Each state moves different parts (the arms type, the head nods, a hand rises to the cheek, an arm waves).
  expect(motion).toMatch(
    /--working\.agent-glyph--chibi \.agent-glyph__arm--l\s*\{\s*animation: agent-k-type-l/,
  )
  expect(motion).toMatch(
    /--working\.agent-glyph--chibi \.agent-glyph__head\s*\{\s*animation: agent-k-nod/,
  )
  expect(motion).toMatch(
    /--thinking\.agent-glyph--chibi \.agent-glyph__arm--r\s*\{\s*transform: rotate\(140deg\)/,
  )
  expect(motion).toMatch(
    /--needs\.agent-glyph--chibi \.agent-glyph__arm--r\s*\{\s*animation: agent-k-wave/,
  )
  expect(motion).toMatch(
    /--idle\.agent-glyph--chibi \.agent-glyph__lock--l\s*\{\s*animation: agent-k-lock/,
  )
})

test('reduced motion stills every animation, and only transform and fill-opacity are ever animated', () => {
  expect(motion).toMatch(
    /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.agent-glyph,\s*\.agent-glyph \*\s*\{\s*animation: none !important/,
  )
  // protected.css pins opacity, scale, rotate and translate on glyph parts; an animation of those would be defeated.
  const properties = new Set<string>()
  for (const block of motion.matchAll(/@keyframes [\w-]+\s*\{((?:\s*[\d%,\s]+\{[^}]*\})+)\s*\}/g))
    for (const declaration of block[1]!.matchAll(/([\w-]+):/g)) properties.add(declaration[1]!)
  expect([...properties].sort()).toEqual(['fill-opacity', 'transform'])
  expect(motion).not.toMatch(/\sopacity:/)
})

describe('eyes follow the pointer', () => {
  afterEach(() => vi.unstubAllGlobals())

  function hover(kind: 'bot' | 'chibi') {
    render(<AgentGlyph agent={styled({ look: kind })} size="lg" />)
    const glyph = screen.getByRole('img')
    glyph.getBoundingClientRect = () => ({ left: 0, top: 0, width: 40, height: 40 }) as DOMRect
    const eyes = glyph.querySelector<SVGGElement>('.agent-glyph__eyes')!
    return { glyph, eyes }
  }

  test.each(looks)('a %s looks toward the pointer and back again', (kind) => {
    const { glyph, eyes } = hover(kind)
    fireEvent.pointerMove(glyph, { clientX: 40, clientY: 20 })
    expect(eyes.style.transform).toMatch(/^translate\(/)
    expect(eyes.style.animation).toBe('none')
    fireEvent.pointerLeave(glyph)
    expect(eyes.style.transform).toBe('')
    expect(eyes.style.animation).toBe('')
  })

  test('with reduced motion the eyes stay put', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    const { glyph, eyes } = hover('bot')
    fireEvent.pointerMove(glyph, { clientX: 40, clientY: 20 })
    expect(eyes.style.transform).toBe('')
  })

  test('a picture has no eyes to move', () => {
    render(<AgentGlyph agent={styled({ avatar: 'r1' })} size="lg" />)
    fireEvent.pointerMove(screen.getByRole('img'), { clientX: 40, clientY: 20 })
    expect(screen.getByRole('img').querySelector('.agent-glyph__eyes')).toBeNull()
  })
})
