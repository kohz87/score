import { readFileSync } from 'node:fs'
import { ShapeSchema, type AgentStyle, type Shape } from '@score/contract'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AgentGlyph, agentTint } from './AgentGlyph.tsx'
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

// PLAN 10.2 (decision 108): marks.
const looks = ['cut', 'ring'] as const
const sizable = ['sm', 'md', 'lg'] as const
const motion = readFileSync('src/components/agent-glyph-motion.css', 'utf8')

function styled(extra: Partial<AgentStyle>, shape: Shape = 'triangle') {
  return { id: 'lead', name: 'lead', style: { color: '#6B4EFF', shape, ...extra } }
}

test('an agent without a look is a cut-out with two eye slots cut through its mask', () => {
  render(<AgentGlyph agent={agent('triangle')} size="sm" />)
  const glyph = screen.getByRole('img', { name: 'lead' })
  expect(glyph.classList.contains('agent-glyph--cut')).toBe(true)
  expect(glyph.classList.contains('agent-glyph--rich')).toBe(true)
  const mask = glyph.querySelector('mask')!
  // Black slots in a white field are what is cut out; the mark itself is solid and uses that mask.
  expect(mask.querySelector('rect[fill="#fff"]')).not.toBeNull()
  expect(mask.querySelectorAll('rect.agent-glyph__slot[fill="#000"]')).toHaveLength(2)
  expect(glyph.querySelector('.agent-glyph__mark')!.getAttribute('mask')).toBe(`url(#${mask.id})`)
  expect(glyph.querySelector('.agent-glyph__solid')).not.toBeNull()
  expect(stylesheet).toMatch(
    /\.agent-glyph--tile\.agent-glyph--rich\s*\{\s*background: transparent/,
  )
})

test('a ring is the shape as one thick outline with two solid eyes, and no mask', () => {
  render(<AgentGlyph agent={styled({ look: 'ring' })} size="md" />)
  const glyph = screen.getByRole('img')
  expect(glyph.classList.contains('agent-glyph--ring')).toBe(true)
  expect(glyph.querySelector('mask')).toBeNull()
  expect(glyph.querySelectorAll('.agent-glyph__outline')).toHaveLength(1)
  expect(glyph.querySelectorAll('.agent-glyph__slot--solid')).toHaveLength(2)
  expect(stylesheet).toMatch(
    /\.agent-glyph--ring \.agent-glyph__outline\s*\{[^}]*stroke-width: 2\.2/,
  )
})

test('two marks on a page never share a mask id', () => {
  render(
    <>
      <AgentGlyph agent={styled({})} size="sm" />
      <AgentGlyph agent={styled({})} size="sm" />
    </>,
  )
  const ids = [...document.querySelectorAll('mask')].map((mask) => mask.id)
  expect(ids).toHaveLength(2)
  expect(new Set(ids).size).toBe(2)
})

test.each(shapes.flatMap((shape) => sizable.map((size) => ({ shape, size }))))(
  'every shape is a cut-out and a ring at $size ($shape)',
  ({ shape, size }) => {
    const { rerender } = render(<AgentGlyph agent={styled({}, shape)} size={size} />)
    expect(screen.getByRole('img').querySelectorAll('.agent-glyph__slot')).toHaveLength(2)
    rerender(<AgentGlyph agent={styled({ look: 'ring' }, shape)} size={size} />)
    expect(screen.getByRole('img').querySelectorAll('.agent-glyph__slot')).toHaveLength(2)
  },
)

test('the lead’s mark is one solid round shape, not a ring inside a ring', () => {
  render(<AgentGlyph agent={agent('circle-dot')} size="sm" />)
  const art = screen.getByRole('img').querySelector('svg')!
  expect(art.querySelector('.agent-glyph__ring')).toBeNull()
  expect(art.querySelector('.agent-glyph__mark circle')?.getAttribute('r')).toBe('8')
})

test('list size is always the plain shape: no face, no mask', () => {
  for (const look of looks) {
    const { container, unmount } = render(<AgentGlyph agent={styled({ look })} size="xs" />)
    const glyph = container.firstElementChild!
    expect(glyph.querySelector('.agent-glyph__slot')).toBeNull()
    expect(glyph.querySelector('mask')).toBeNull()
    expect(glyph.classList.contains('agent-glyph--plain')).toBe(true)
    expect(glyph.classList.contains('agent-glyph--rich')).toBe(false)
    unmount()
  }
})

test('plain forces the plain shape at any size', () => {
  render(<AgentGlyph agent={styled({})} size="sm" plain />)
  expect(screen.getByRole('img').classList.contains('agent-glyph--plain')).toBe(true)
})

test.each(looks)(
  'a %s keeps its name, shape description, decorative mode and bare form',
  (look) => {
    const { rerender, container } = render(
      <AgentGlyph agent={styled({ look }, 'drop')} size="sm" describeShape />,
    )
    expect(screen.getByRole('img', { name: 'lead, drop' })).toBeDefined()
    rerender(<AgentGlyph agent={styled({ look }, 'drop')} size="sm" decorative />)
    expect(screen.queryByRole('img')).toBeNull()
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true')
    rerender(<AgentGlyph agent={styled({ look }, 'drop')} size="sm" bare />)
    expect(screen.getByRole('img').tagName.toLowerCase()).toBe('svg')
    expect(screen.getByRole('img').getAttribute('data-protected')).toBe('inline-flex')
    rerender(<AgentGlyph agent={styled({ look }, 'drop')} size="sm" contrast="high" />)
    expect(screen.getByRole('img').classList.contains('agent-glyph--high')).toBe(true)
  },
)

test('with no activity a mark rests; the activity prop picks the mood', () => {
  const { rerender } = render(<AgentGlyph agent={styled({})} size="sm" />)
  const glyph = () => screen.getByRole('img')
  expect(glyph().classList.contains('agent-glyph--idle')).toBe(true)
  for (const activity of ['working', 'thinking', 'needs'] as const) {
    rerender(<AgentGlyph agent={styled({})} size="sm" activity={activity} />)
    expect(glyph().classList.contains(`agent-glyph--${activity}`)).toBe(true)
    expect(glyph().classList.contains('agent-glyph--idle')).toBe(false)
  }
})

test.each(looks)(
  'a %s shows an orbiting dot only when thinking and ripples only when it needs you',
  (look) => {
    const { rerender } = render(<AgentGlyph agent={styled({ look })} size="md" />)
    const count = (selector: string) => screen.getByRole('img').querySelectorAll(selector).length
    expect([count('.agent-glyph__orbit'), count('.agent-glyph__ripple')]).toEqual([0, 0])
    rerender(<AgentGlyph agent={styled({ look })} size="md" activity="working" />)
    expect([count('.agent-glyph__orbit'), count('.agent-glyph__ripple')]).toEqual([0, 0])
    rerender(<AgentGlyph agent={styled({ look })} size="md" activity="thinking" />)
    expect([count('.agent-glyph__orbit'), count('.agent-glyph__ripple')]).toEqual([1, 0])
    rerender(<AgentGlyph agent={styled({ look })} size="md" activity="needs" />)
    expect([count('.agent-glyph__orbit'), count('.agent-glyph__ripple')]).toEqual([0, 2])
  },
)

test('each mood moves different parts, and eyes narrow or widen', () => {
  expect(motion).toMatch(
    /--idle\.agent-glyph--rich \.agent-glyph__mark\s*\{\s*animation: agent-breathe 4\.2s/,
  )
  expect(motion).toMatch(
    /--working\.agent-glyph--rich \.agent-glyph__mark\s*\{\s*animation: agent-pulse 1\.4s/,
  )
  expect(motion).toMatch(
    /--working\.agent-glyph--rich \.agent-glyph__slot\s*\{\s*animation: none;\s*transform: scaleY\(0\.45\)/,
  )
  expect(motion).toMatch(
    /--thinking\.agent-glyph--rich \.agent-glyph__eyes\s*\{\s*transform: translate\(0\.4px, -1\.1px\)/,
  )
  expect(motion).toMatch(
    /--needs\.agent-glyph--rich \.agent-glyph__slot\s*\{\s*animation: none;\s*transform: scale\(1\.25\)/,
  )
  expect(motion).toMatch(
    /\.agent-glyph--rich \.agent-glyph__slot\s*\{\s*animation: agent-blink 5s infinite/,
  )
})

test('only transform and stroke-opacity are animated, and Still and reduced motion stop every animation', () => {
  expect(motion).toMatch(
    /html\[data-liveliness='still'\] \.agent-glyph \*\s*\{\s*animation: none !important/,
  )
  expect(motion).toMatch(
    /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.agent-glyph,\s*\.agent-glyph \*\s*\{\s*animation: none !important/,
  )
  // protected.css pins opacity, scale, rotate and translate on glyph parts; an animation of those would be defeated.
  const properties = new Set<string>()
  for (const block of motion.matchAll(/@keyframes [\w-]+\s*\{((?:\s*[\d.%,\s]+\{[^}]*\})+)\s*\}/g))
    for (const declaration of block[1]!.matchAll(/([\w-]+):/g)) properties.add(declaration[1]!)
  expect([...properties].sort()).toEqual(['stroke-opacity', 'transform'])
  expect(motion).not.toMatch(/\sopacity:/)
})

describe('the pointer', () => {
  afterEach(() => {
    delete document.documentElement.dataset.liveliness
    vi.restoreAllMocks()
  })

  function setup(activity?: 'thinking') {
    vi.stubGlobal('requestAnimationFrame', (run: () => void) => {
      run()
      return 1
    })
    render(<AgentGlyph agent={styled({})} size="lg" activity={activity} />)
    const glyph = screen.getByRole('img')
    glyph.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 40, height: 40, bottom: 40, right: 40 }) as DOMRect
    return { glyph, eyes: glyph.querySelector<SVGGElement>('.agent-glyph__eyes')! }
  }
  afterEach(() => vi.unstubAllGlobals())

  test('the eyes look toward it, from one listener shared by every mark, and look away when it leaves nothing to follow', () => {
    const add = vi.spyOn(document, 'addEventListener')
    const { eyes, glyph } = setup()
    render(<AgentGlyph agent={styled({})} size="sm" />)
    expect(add.mock.calls.filter(([type]) => type === 'pointermove')).toHaveLength(1)
    fireEvent.pointerMove(document, { clientX: 400, clientY: 20 })
    expect(eyes.style.transform).toMatch(/^translate\(1\.3px, /)
    fireEvent.pointerMove(document, { clientX: -400, clientY: 20 })
    expect(eyes.style.transform).toMatch(/^translate\(-1\.3px, /)
    expect(glyph).toBeDefined()
  })

  test('the listener goes when the last mark does', () => {
    const remove = vi.spyOn(document, 'removeEventListener')
    const { unmount } = render(<AgentGlyph agent={styled({})} size="sm" />)
    unmount()
    expect(remove.mock.calls.filter(([type]) => type === 'pointermove')).toHaveLength(1)
  })

  test('a thinking mark keeps its eyes up and ignores the pointer', () => {
    const { eyes } = setup('thinking')
    fireEvent.pointerMove(document, { clientX: 400, clientY: 20 })
    expect(eyes.style.transform).toBe('')
  })

  test('under Still the eyes stay put', () => {
    document.documentElement.dataset.liveliness = 'still'
    const { eyes } = setup()
    fireEvent.pointerMove(document, { clientX: 400, clientY: 20 })
    expect(eyes.style.transform).toBe('')
  })

  test('with reduced motion the eyes stay put', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    const { eyes } = setup()
    fireEvent.pointerMove(document, { clientX: 400, clientY: 20 })
    expect(eyes.style.transform).toBe('')
  })

  test('a click nudges the mark it landed on, and not under Still', () => {
    vi.useFakeTimers()
    const { glyph } = setup()
    fireEvent.click(glyph)
    expect(glyph.classList.contains('agent-glyph--poke')).toBe(true)
    vi.advanceTimersByTime(500)
    expect(glyph.classList.contains('agent-glyph--poke')).toBe(false)
    document.documentElement.dataset.liveliness = 'still'
    fireEvent.click(glyph)
    expect(glyph.classList.contains('agent-glyph--poke')).toBe(false)
    vi.useRealTimers()
  })

  test('the plain list shape does not take part', () => {
    const add = vi.spyOn(document, 'addEventListener')
    render(<AgentGlyph agent={styled({})} size="xs" />)
    expect(add.mock.calls.filter(([type]) => type === 'pointermove')).toHaveLength(0)
  })
})
