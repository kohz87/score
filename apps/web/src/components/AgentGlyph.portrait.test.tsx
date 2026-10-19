import { readFileSync } from 'node:fs'
import type { AgentStyle } from '@score/contract'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const decode = vi.fn()
vi.mock('./portrait-decode.ts', () => ({ decodePortrait: (url: string) => decode(url) }))

import { saveLiveliness } from '../data/liveliness.ts'
import { AgentGlyph } from './AgentGlyph.tsx'
import { resetPortraits } from './portrait-cache.ts'

const ready = { url: 'blob:p', crop: { x: 5, y: 30, side: 90 }, width: 100, height: 200 }
const pack: NonNullable<AgentStyle['pack']> = {
  rev: 'r1',
  activities: ['idle'],
  name: null,
  credits: null,
  floor: 0,
}
const packed = (id = 'lead') => ({
  id,
  name: id,
  style: { color: '#19C39A', shape: 'triangle', pack } satisfies AgentStyle,
})
const plainAgent = {
  id: 'lead',
  name: 'lead',
  style: { color: '#19C39A', shape: 'triangle' } as AgentStyle,
}
const glyph = () => screen.getByRole('img', { name: 'lead' })
const settle = () =>
  act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

beforeEach(() => {
  decode.mockResolvedValue(ready)
  localStorage.clear()
})
afterEach(() => {
  cleanup()
  resetPortraits()
  decode.mockReset()
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test.each(['sm', 'md', 'lg'] as const)(
  '%s: a ringed round portrait with the mark as a badge',
  async (size) => {
    render(<AgentGlyph agent={packed()} size={size} />)
    await settle()
    const g = glyph()
    expect(g.classList.contains('agent-glyph--portrait')).toBe(true)
    expect(g.getAttribute('data-protected')).toBe('inline-flex')
    expect(g.querySelector('.agent-glyph__portrait img')?.getAttribute('src')).toBe('blob:p')
    expect(g.querySelector('.agent-glyph__badge svg path')).not.toBeNull()
  },
)

test('xs: the portrait is clipped to the agent’s shape and outlined in its colour', async () => {
  render(<AgentGlyph agent={packed()} size="xs" />)
  await settle()
  const g = glyph()
  expect(g.querySelector('clipPath path')?.getAttribute('d')).toBe('M10 3 L17.5 16 H2.5 Z')
  expect(g.querySelector('image')?.getAttribute('href')).toBe('blob:p')
  expect(g.querySelector('image')?.getAttribute('clip-path')).toMatch(/^url\(#/)
  expect(g.querySelector('.agent-glyph__portrait-outline')).not.toBeNull()
  expect(g.querySelector('.agent-glyph__badge')).toBeNull()
})

test('while loading, and when decoding fails, the mark shows (never a broken image)', async () => {
  decode.mockReturnValue(new Promise(() => {}))
  const { unmount } = render(<AgentGlyph agent={packed()} />)
  expect(glyph().classList.contains('agent-glyph--portrait')).toBe(false)
  expect(glyph().querySelector('img')).toBeNull()
  unmount()
  resetPortraits()
  decode.mockRejectedValue(new Error('x'))
  render(<AgentGlyph agent={packed()} />)
  await settle()
  expect(glyph().classList.contains('agent-glyph--portrait')).toBe(false)
  expect(glyph().classList.contains('agent-glyph--cut')).toBe(true)
})

test('an agent without a pack keeps its mark and decodes nothing', async () => {
  render(<AgentGlyph agent={plainAgent} />)
  await settle()
  expect(decode).not.toHaveBeenCalled()
  expect(glyph().classList.contains('agent-glyph--portrait')).toBe(false)
})

test('`mark` keeps the mark for a pack agent: the badge on its own full pet is never a portrait of itself', async () => {
  render(<AgentGlyph agent={packed()} size="sm" mark />)
  await settle()
  expect(decode).not.toHaveBeenCalled()
  expect(glyph().classList.contains('agent-glyph--portrait')).toBe(false)
})

test('fifty glyphs decode once', async () => {
  render(
    <>
      {Array.from({ length: 50 }, (_, i) => (
        <AgentGlyph key={i} agent={packed()} size={i % 2 ? 'xs' : 'md'} decorative />
      ))}
    </>,
  )
  await settle()
  expect(decode).toHaveBeenCalledTimes(1)
})

test('pointing at it plays the idle file, cropped the same way; leaving stills it', async () => {
  render(<AgentGlyph agent={packed()} />)
  await settle()
  expect(glyph().querySelector('img.agent-glyph__anim')).toBeNull()
  fireEvent.pointerEnter(glyph())
  const anim = glyph().querySelector<HTMLImageElement>('img.agent-glyph__anim')!
  expect(anim.getAttribute('src')).toBe('/api/agents/lead/pack/idle?rev=r1')
  expect(anim.style.width).toBe('111.111%')
  fireEvent.pointerLeave(glyph())
  expect(glyph().querySelector('img.agent-glyph__anim')).toBeNull()
})

test('an interactive parent’s keyboard focus plays it too', async () => {
  render(
    <button>
      <AgentGlyph agent={packed()} />
    </button>,
  )
  await settle()
  fireEvent.focus(screen.getByRole('button'))
  expect(document.querySelector('img.agent-glyph__anim')).not.toBeNull()
  fireEvent.blur(screen.getByRole('button'))
  expect(document.querySelector('img.agent-glyph__anim')).toBeNull()
})

test('under Still it never animates', async () => {
  saveLiveliness('still')
  render(<AgentGlyph agent={packed()} />)
  await settle()
  fireEvent.pointerEnter(glyph())
  expect(document.querySelector('img.agent-glyph__anim')).toBeNull()
})

test('reduced motion never animates either', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('reduce'),
    addEventListener() {},
    removeEventListener() {},
  }))
  render(<AgentGlyph agent={packed()} />)
  await settle()
  fireEvent.pointerEnter(glyph())
  expect(document.querySelector('img.agent-glyph__anim')).toBeNull()
})

test('the portrait is covered by the theme protection', () => {
  const css = readFileSync('src/styles/protected.css', 'utf8').replace(/\s+/g, ' ')
  expect(css).toMatch(/span\.agent-glyph--portrait\[data-protected\]/)
  expect(css).toMatch(
    /svg \*:not\(\.agent-glyph__portrait-image\)[^{]*\{ clip-path: none !important/,
  )
  const guard = readFileSync('src/themes/guard.ts', 'utf8')
  expect(guard).toMatch(/const SHAPES = '[^']*\bimage\b/)
})

test('keyboard focus keeps it playing when the pointer leaves (hover and focus are tracked apart)', async () => {
  render(
    <button>
      <AgentGlyph agent={packed()} />
    </button>,
  )
  await settle()
  const button = screen.getByRole('button')
  fireEvent.focus(button)
  fireEvent.pointerEnter(button)
  fireEvent.pointerLeave(button)
  expect(document.querySelector('img.agent-glyph__anim')).not.toBeNull()
  fireEvent.blur(button)
  expect(document.querySelector('img.agent-glyph__anim')).toBeNull()
  // And the other way round: blur while the pointer is still over it.
  fireEvent.pointerEnter(button)
  fireEvent.focus(button)
  fireEvent.blur(button)
  expect(document.querySelector('img.agent-glyph__anim')).not.toBeNull()
})

test.each(
  (['sm', 'md', 'lg'] as const).flatMap((size) =>
    (['cut', 'ring'] as const).map((look) => ({ size, look })),
  ),
)('$look badge at $size keeps its shape styling', async ({ size, look }) => {
  const a = packed()
  render(<AgentGlyph agent={{ ...a, style: { ...a.style, look } }} size={size} />)
  await settle()
  const badge = glyph().querySelector('.agent-glyph__badge')!
  expect(badge.classList.contains(`agent-glyph--${look}`)).toBe(true)
  if (look === 'ring') {
    expect(badge.querySelector('.agent-glyph__outline')).not.toBeNull()
    const css = readFileSync('src/components/agent-glyph.css', 'utf8')
    expect(css).toMatch(/\.agent-glyph--ring \.agent-glyph__outline\s*\{[^}]*stroke-width: [\d.]+/)
    expect(css).toMatch(/\.agent-glyph--ring \.agent-glyph__outline\s*\{[^}]*stroke: var/)
  } else {
    expect(badge.querySelector('mask')).not.toBeNull()
  }
})

test('under a custom theme the badge sits on Score’s own plate, not the theme’s card colour', () => {
  const css = readFileSync('src/styles/protected.css', 'utf8').replace(/\s+/g, ' ')
  expect(css).toMatch(
    /html\[data-look='custom'\] \[data-protected\] \.agent-glyph__badge[^{]*\{[^}]*background-color: var\(--glyph-plate\) !important/,
  )
  expect(css).toMatch(/\.agent-glyph__badge-plate[^{]*\{[^}]*fill: var\(--glyph-plate\) !important/)
})
